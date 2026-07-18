import type { Page, Route } from "@playwright/test";
import { installR52ScreenerFixture, R52_CSRF, R52_OWNER_ID, type R52ScreenerFixture } from "./r52ScreenerFixture";

export const R9_OWNER_ID = R52_OWNER_ID;
export const R9_CSRF = R52_CSRF;
export const R9_JOB_ID = "40000000-0000-4000-8000-000000000091";
export const R9_ENGINE_VERSION = "backtest-core-v1";
export const R9_DATASET_FINGERPRINT = "d076618630cf584258a3d81c288db5d29d42c76329e1a27ab4373adf32001930";

export interface R9EvalJobRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  body?: Record<string, unknown>;
}

export interface R9GeneratorEvalFixture {
  /** The underlying authenticated-shell fixture (auth, catalog, sockets, …). */
  readonly base: R52ScreenerFixture;
  readonly evalRequests: R9EvalJobRequest[];
  readonly violations: string[];
  jobPolls(): number;
}

/**
 * R9.1 fixture family extension: reuses the R5.2 authenticated browser fixture
 * for the whole shell, then re-registers the jobs API route for the server
 * multi-market evaluation journey. Playwright matches routes in reverse
 * registration order, so this LAST-registered handler wins over the base
 * fixture's screener-only jobs route. The evaluation job completes with a
 * deterministic result echoing the requested markets, so the generator's
 * ranking flow renders without a database, jobs runtime or exchange.
 */
export async function installR9GeneratorEvalFixture(page: Page): Promise<R9GeneratorEvalFixture> {
  const base = await installR52ScreenerFixture(page);
  const evalRequests: R9EvalJobRequest[] = [];
  const violations: string[] = [];
  let enqueuedBody: Record<string, unknown> | undefined;
  let jobPollCount = 0;

  await page.route("**/api/jobs**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    evalRequests.push({ method: request.method(), path: pathname, ownerHeader, csrfHeader, ...(body ? { body } : {}) });

    if (ownerHeader !== R9_OWNER_ID) {
      violations.push(`${request.method()} ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }

    if (request.method() === "POST" && pathname === "/api/jobs") {
      if (csrfHeader !== R9_CSRF) {
        violations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
        return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
      }
      if (body?.kind !== "multi-market-eval") {
        violations.push(`POST ${pathname}: kind ${String(body?.kind)}`);
        return json(route, { code: "invalid_request", error: "Invalid research job." }, 400);
      }
      enqueuedBody = body;
      return json(route, { job: { id: R9_JOB_ID, status: "queued" } }, 202);
    }

    const pollMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/u);
    if (request.method() === "GET" && pollMatch) {
      if (!enqueuedBody || decodeURIComponent(pollMatch[1]!) !== R9_JOB_ID) {
        return json(route, { code: "job_not_found", error: "Job not found." }, 404);
      }
      jobPollCount += 1;
      return json(route, { job: { id: R9_JOB_ID, status: "completed", result: evaluationResult(enqueuedBody) } });
    }

    violations.push(`unexpected jobs request: ${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_jobs_request", error: `${request.method()} ${pathname}` }, 501);
  });

  return { base, evalRequests, violations, jobPolls: () => jobPollCount };
}

/** Deterministic multi-market-eval-v1 result echoing the requested dataset. */
function evaluationResult(body: Record<string, unknown>): Record<string, unknown> {
  const requested = Array.isArray(body.markets) ? (body.markets as { symbol: string; timeframe: string }[]) : [];
  const split = record(body.split) ?? { trainFraction: 0.7, embargoBars: 8 };
  return {
    schemaVersion: "multi-market-eval-v1",
    engineVersion: R9_ENGINE_VERSION,
    dataset: {
      schemaVersion: "dataset-v1",
      source: "binance:spot:last",
      timeframe: requested[0]?.timeframe ?? "1h",
      symbols: requested.map((market) => market.symbol).sort(),
      fromMs: 1_767_225_600_000,
      toMs: 1_778_017_600_000,
      barCounts: Object.fromEntries(requested.map((market) => [market.symbol, body.lookbackBars ?? 3_000])),
      split: { ...split, testFraction: 0.3 },
      fingerprint: R9_DATASET_FINGERPRINT
    },
    seed: typeof body.seed === "number" ? body.seed : 0,
    markets: requested.map((market, index) => ({
      symbol: market.symbol,
      timeframe: market.timeframe,
      train: windowSection(9.5 - index),
      outOfSample: windowSection(4.1 - index * 0.6)
    })),
    portfolio: {
      symbols: requested.map((market) => market.symbol),
      metrics: { netProfitPct: 3.6, maxDrawdownPct: 2.9, sharpe: 1.1 },
      correlation: { symbols: requested.map((market) => market.symbol), values: [], averagePairwise: 0.4 },
      contributions: [],
      rejectionCounts: { max_concurrent: 0, gross_exposure: 0, allocation_too_small: 0, invalid_candidate: 0 }
    }
  };
}

function windowSection(netProfitPct: number): Record<string, unknown> {
  return {
    netProfitPct,
    sharpe: 1.3,
    profitFactor: 1.7,
    maxDrawdownPct: 4.4,
    totalTrades: 12,
    liquidated: false,
    barCount: 2_092,
    tradeCount: 12
  };
}

function parseBody(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
