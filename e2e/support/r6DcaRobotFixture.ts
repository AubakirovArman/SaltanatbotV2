import type { Page, Route } from "@playwright/test";
import {
  installR4PaperPortfolioFixture,
  R4_CSRF,
  R4_OWNER_ID,
  type R4PaperPortfolioFixture
} from "./r4PaperPortfolioFixture";

/**
 * R6 DCA robot creation fixture: the complete R4 paper-portfolio browser
 * environment plus a stateful, fail-closed `/api/trade/bots` surface that
 * records the exact create POST (owner, CSRF, idempotency key and byte-level
 * body) so the spec can pin the kind/dca contract shape.
 */
export interface R6DcaBotRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  idempotencyKey: string | null;
  body?: Record<string, unknown>;
}

export interface R6DcaRobotFixture {
  base: R4PaperPortfolioFixture;
  readonly bots: Array<Record<string, unknown>>;
  readonly botRequests: R6DcaBotRequest[];
  readonly botViolations: string[];
  createRequests(): R6DcaBotRequest[];
}

export async function installR6DcaRobotFixture(page: Page): Promise<R6DcaRobotFixture> {
  const base = await installR4PaperPortfolioFixture(page);
  const bots: Array<Record<string, unknown>> = [];
  const botRequests: R6DcaBotRequest[] = [];
  const botViolations: string[] = [];
  let createdAt = Date.parse("2026-07-17T04:00:00.000Z");

  // Registered after the R4 catch-alls, so Playwright dispatches the trading
  // bot API here first while every other surface keeps the R4 fences.
  await page.route("**/api/trade/bots**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const idempotencyKey = request.headers()["idempotency-key"] ?? null;

    const detail = pathname.match(/^\/api\/trade\/bots\/([^/]+)\/(fills|logs|orders|order-journal)$/u);
    if (request.method() === "GET" && detail) {
      const key = detail[2] === "order-journal" ? "orders" : detail[2]!;
      return json(route, { [key]: [] });
    }
    if (request.method() === "GET" && /^\/api\/trade\/bots\/[^/]+\/live$/u.test(pathname)) {
      return json(route, { account: { balance: 2_000, equity: 2_000, currency: "USDT" }, position: null, price: 64_700, paused: false });
    }
    if (request.method() === "GET" && pathname === "/api/trade/bots") {
      return json(route, { bots: structuredClone(bots) });
    }
    if (request.method() === "POST" && pathname === "/api/trade/bots") {
      const body = parseBody(request.postData());
      botRequests.push({ method: "POST", path: pathname, ownerHeader, csrfHeader, idempotencyKey, ...(body ? { body } : {}) });
      if (ownerHeader !== R4_OWNER_ID) {
        botViolations.push(`POST ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
        return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
      }
      if (csrfHeader !== R4_CSRF) {
        botViolations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
        return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
      }
      if (!idempotencyKey) {
        botViolations.push(`POST ${pathname}: idempotency key missing`);
        return json(route, { code: "idempotency_key_required", error: "Idempotency-Key is required." }, 400);
      }
      if (!body || body.exchange !== "paper") {
        botViolations.push(`POST ${pathname}: non-paper create`);
        return json(route, { code: "invalid_input", error: "Only paper robots exist in this fixture." }, 400);
      }
      createdAt += 1_000;
      const publicInput = Object.fromEntries(Object.entries(body).filter(([key]) => (
        key !== "expectedPortfolioRevision" && key !== "expectedLedgerEpoch"
      )));
      const bot: Record<string, unknown> = {
        ...publicInput,
        id: `paper-r6-dca-${bots.length + 1}`,
        paperLedgerEpoch: 1,
        status: "stopped",
        createdAt,
        updatedAt: createdAt
      };
      bots.push(bot);
      return json(route, { bot: structuredClone(bot) }, 201);
    }
    botViolations.push(`${request.method()} ${pathname}: unmatched trading bot request`);
    return json(route, { code: "unexpected_bot_request", error: `${request.method()} ${pathname}` }, 501);
  });

  return {
    base,
    bots,
    botRequests,
    botViolations,
    createRequests: () => botRequests.filter((record) => record.method === "POST" && record.path === "/api/trade/bots")
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
