import type { Page, Route } from "@playwright/test";
import {
  installR4PaperPortfolioFixture,
  R4_CSRF,
  R4_OWNER_ID,
  type R4PaperPortfolioFixture,
  type R4PaperRequest
} from "./r4PaperPortfolioFixture";

export const R8_FIXED_TIME = Date.parse("2026-07-17T03:30:00.000Z");
export const R8_HANDOFF_STORAGE_KEY = "sbv2:automation:market-opportunity-v1";

/**
 * R8 multi-leg paper intent fixture: the complete R4 paper-portfolio browser
 * environment plus a stateful, fail-closed multi-leg surface. It intercepts
 * the two additive endpoints (submit POST and the detail GET that now carries
 * the multiLeg section) and falls back to the R4 handlers for everything else,
 * so the LAST-registered route wins exactly where R8 extends the API.
 */
export interface R8MultiLegFixture {
  base: R4PaperPortfolioFixture;
  readonly multiLegRequests: R4PaperRequest[];
  readonly multiLegViolations: string[];
  submitRequests(): R4PaperRequest[];
}

/**
 * Verified n-leg research envelope. The handoff parser only allows a ready
 * paper plan for a verified n-leg-v1 opportunity, and the numbers mirror the
 * backend goldens: notional 1020, fee reserve 2·0.204 → worst case 1020.408;
 * combined both-legs-all-costs PnL +207.796 with 0.204 modeled fees.
 */
export function r8OpportunityEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: "market-opportunity-v1",
    id: "n-leg-opportunity:fixture",
    family: "n-leg-cycle",
    kind: "cycle",
    source: { engine: "n-leg-v1", opportunityId: "n-leg-opportunity:fixture", evaluatedAt: R8_FIXED_TIME - 10_000 },
    legs: Array.from({ length: 4 }, (_, index) => ({
      id: `cycle-leg-${index}`,
      venue: "fixture",
      instrumentId: `fixture:spot:M${index}`,
      symbol: `M${index}`,
      marketType: "spot",
      side: index % 2 === 0 ? "buy" : "sell",
      role: "cycle",
      identityScope: "canonical-instrument",
      quantityUnit: "base",
      quantity: index + 1,
      referencePrice: 100 + index
    })),
    economics: {
      outcome: "research-simulation",
      netEdgeBps: 100,
      costCoverage: "visible-depth-and-declared-fees",
      entryFees: { value: 0.204, currency: "USDT" },
      funding: "excluded",
      borrow: "excluded",
      slippage: "visible-depth"
    },
    capacity: { notional: { value: 1_020, currency: "USDT" }, depthLimited: false },
    evidence: {
      evaluatedAt: R8_FIXED_TIME - 10_000,
      quoteAgeMs: 20,
      legSkewMs: 0,
      sequenceContinuity: "verified",
      exchangeTimestamps: "verified",
      dataQuality: "fresh",
      sourceIds: ["fixture-book-0", "fixture-book-1", "fixture-book-2", "fixture-book-3"],
      provenanceIds: ["n-leg-v1"]
    },
    execution: {
      research: "available",
      paperPlan: "ready",
      live: "blocked",
      atomicity: "none",
      paperBlockers: [],
      liveBlockers: ["Live multi-leg execution is disabled."]
    },
    blockers: []
  };
}

export function r8HandoffRecord(): Record<string, unknown> {
  return {
    transportVersion: 1,
    destination: "automation",
    storedAt: R8_FIXED_TIME - 1_000,
    expiresAt: R8_FIXED_TIME + 15 * 60_000,
    opportunity: r8OpportunityEnvelope()
  };
}

export async function installR8MultiLegFixture(page: Page): Promise<R8MultiLegFixture> {
  const base = await installR4PaperPortfolioFixture(page);
  const multiLegRequests: R4PaperRequest[] = [];
  const multiLegViolations: string[] = [];
  const intentsByPortfolio = new Map<string, Array<Record<string, unknown>>>();
  let submitSequence = 0;

  const section = (portfolioId: string): Record<string, unknown> => ({
    killSwitchEnabled: false,
    intents: structuredClone(intentsByPortfolio.get(portfolioId) ?? [])
  });

  // Registered after the R4 catch-alls: Playwright dispatches the multi-leg
  // submit POST and the multiLeg-enriched detail GET here first and everything
  // else falls back to the stateful R4 handler untouched.
  await page.route("**/api/trade/paper-portfolios**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    const submitMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)\/multi-leg$/u);
    if (request.method() === "POST" && submitMatch) {
      const portfolioId = decodeURIComponent(submitMatch[1]!);
      const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
      const csrfHeader = request.headers()["x-csrf-token"] ?? null;
      const idempotencyKey = request.headers()["idempotency-key"] ?? null;
      const body = parseBody(request.postData());
      multiLegRequests.push({ method: "POST", path: pathname, ownerHeader, csrfHeader, idempotencyKey, ...(body ? { body } : {}) });

      if (ownerHeader !== R4_OWNER_ID) {
        multiLegViolations.push(`POST ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
        return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
      }
      if (csrfHeader !== R4_CSRF) {
        multiLegViolations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
        return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
      }
      if (!idempotencyKey) {
        multiLegViolations.push(`POST ${pathname}: idempotency key missing`);
        return json(route, { code: "idempotency_key_required", error: "Idempotency-Key is required." }, 400);
      }
      const detail = base.detail(portfolioId);
      if (!detail || body?.kind !== "paper-multi-leg.submit") {
        multiLegViolations.push(`POST ${pathname}: invalid submit`);
        return json(route, { code: "invalid_input", error: "Invalid multi-leg submit." }, 400);
      }
      submitSequence += 1;
      const rows = intentsByPortfolio.get(portfolioId) ?? [];
      rows.unshift(completedIntent(submitSequence));
      intentsByPortfolio.set(portfolioId, rows);
      return json(route, { ...detail, multiLeg: section(portfolioId), replayed: false }, 201);
    }

    const detailMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)$/u);
    if (request.method() === "GET" && detailMatch) {
      const portfolioId = decodeURIComponent(detailMatch[1]!);
      const detail = base.detail(portfolioId);
      // Unknown portfolios (and the R4 failure injection) keep R4 semantics.
      if (!detail) return route.fallback();
      return json(route, { ...detail, multiLeg: section(portfolioId) });
    }

    return route.fallback();
  });

  return {
    base,
    multiLegRequests,
    multiLegViolations,
    submitRequests: () => multiLegRequests.filter((record) => record.method === "POST" && record.path.endsWith("/multi-leg"))
  };
}

function completedIntent(sequence: number): Record<string, unknown> {
  return {
    intentId: `mleg-r8-e2e-${String(sequence).padStart(4, "0")}`,
    status: "terminal",
    outcome: "completed",
    sourceEngine: "n-leg-v1",
    sourceOpportunityId: "n-leg-opportunity:fixture",
    legCount: 4,
    // Canonical six-decimal money strings, exactly as the read model formats.
    reservedCapital: "1020.408000",
    netPnl: "207.796000",
    fees: "0.204000",
    createdAt: R8_FIXED_TIME,
    legs: Array.from({ length: 4 }, (_, index) => ({
      venue: "fixture",
      instrumentId: `fixture:spot:M${index}`,
      side: index % 2 === 0 ? ("buy" as const) : ("sell" as const),
      plannedQuantity: index + 1,
      filledQuantity: index + 1,
      averagePrice: 100 + index,
      fee: Number(((index + 1) * (100 + index) * 0.0002).toFixed(6)),
      compensated: false
    })),
    residualExposure: []
  };
}

function parseBody(postData: string | null): Record<string, unknown> | undefined {
  if (!postData) return undefined;
  try {
    const parsed: unknown = JSON.parse(postData);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
