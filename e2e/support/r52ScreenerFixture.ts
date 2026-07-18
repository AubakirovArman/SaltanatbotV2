import type { Page, Route } from "@playwright/test";
import {
  ALERT_EVENT_PAGE_SCHEMA_V1,
  ALERT_RULE_LIST_SCHEMA_V1,
  parseAlertEventPageV1,
  parseAlertRuleListV1,
  parseScreenerPresetListV1,
  parseScreenerRunResultV1,
  type ScreenerRunResultV1
} from "@saltanatbotv2/contracts";

export const R52_OWNER_ID = "10000000-0000-4000-8000-000000000052";
export const R52_OWNER_LOGIN = "r52-screen-owner";
export const R52_JOB_ID = "40000000-0000-4000-8000-000000000052";
export const R52_CSRF = "csrf-r52-screener";
export const R52_SCREEN_TIMEFRAME = "1h";

const BASE_TIME = Date.parse("2026-07-16T20:00:00.000Z");
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export interface R52ScreenerRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  body?: Record<string, unknown>;
}

export interface R52CandleRequest {
  symbol: string;
  timeframe: string;
}

export interface R52ScreenerFixture {
  readonly requests: R52ScreenerRequest[];
  readonly violations: string[];
  readonly unexpectedApiRequests: string[];
  readonly candleRequests: R52CandleRequest[];
  jobPolls(): number;
}

/**
 * Fail-closed browser fixture for the technical screener journey. Every API
 * route that is not explicitly mocked below answers 501 and is recorded, so
 * the journey can assert that no application request escaped the mock. The
 * document and static assets still come from Playwright's isolated web server;
 * no request reaches a database, the jobs runtime or Binance.
 */
export async function installR52ScreenerFixture(page: Page): Promise<R52ScreenerFixture> {
  const requests: R52ScreenerRequest[] = [];
  const violations: string[] = [];
  const unexpectedApiRequests: string[] = [];
  const candleRequests: R52CandleRequest[] = [];
  let screenEnqueued = false;
  let jobPollCount = 0;

  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    unexpectedApiRequests.push(`${request.method()} ${path}`);
    return json(route, { code: "unexpected_mock_request", error: `${request.method()} ${path}` }, 501);
  });

  // The scanner opens in its basis sub-mode before the journey switches to the
  // technical screener. Basis market data is deliberately unavailable here:
  // that is an honest UI state and keeps this fixture free of arbitrage data.
  await page.route("**/api/arbitrage**", (route) => json(route, { code: "arbitrage_unavailable", error: "Arbitrage research data is unavailable in this fixture." }, 503));

  await page.route("**/api/catalog", (route) => json(route, {
    instruments: [
      instrument("BTCUSDT", "Bitcoin / Tether", 64_700, 2),
      instrument("ETHUSDT", "Ethereum / Tether", 3_400, 2)
    ],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
    chartTypes: ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]
  }));
  await page.route("**/api/candles?**", (route) => {
    const url = new URL(route.request().url());
    candleRequests.push({
      symbol: url.searchParams.get("symbol") ?? "",
      timeframe: url.searchParams.get("timeframe") ?? ""
    });
    const rows = chartCandles();
    return json(route, {
      instrument: instrument(url.searchParams.get("symbol") ?? "BTCUSDT", "Fixture instrument", rows.at(-1)!.close, 2),
      candles: rows,
      provider: "r52-browser-fixture",
      hasMore: false
    });
  });
  await page.route("**/api/sparklines?**", (route) => json(route, {
    timeframe: "1m",
    series: {
      BTCUSDT: { last: 64_700, changePct: 0.42, points: [64_620, 64_680, 64_700] },
      ETHUSDT: { last: 3_400, changePct: -0.21, points: [3_410, 3_395, 3_400] }
    }
  }));

  await page.route("**/api/auth/config", (route) => json(route, {
    mode: "database",
    authRequired: true,
    registrationEnabled: true,
    tradingRoleAssignmentsEnabled: true
  }));
  await page.route("**/api/auth/me", (route) => json(route, {
    user: {
      id: R52_OWNER_ID,
      login: R52_OWNER_LOGIN,
      status: "active",
      appRole: "user",
      tradingRole: "paper-trade",
      mustChangePassword: false,
      authorizationRevision: 5,
      approvedAt: "2026-07-16T19:00:00.000Z",
      createdAt: "2026-07-16T18:00:00.000Z",
      updatedAt: "2026-07-16T19:00:00.000Z"
    },
    csrfToken: R52_CSRF,
    expiresAt: "2026-07-18T20:00:00.000Z",
    tradingAvailable: true
  }));

  await installAlertReadFixture(page, violations, unexpectedApiRequests);

  await page.route("**/api/onboarding**", (route) => {
    const owner = route.request().headers()["x-sbv2-expected-user"] ?? null;
    if (owner !== R52_OWNER_ID) violations.push(`onboarding owner: ${owner ?? "<missing>"}`);
    return json(route, {
      onboarding: {
        schemaVersion: 1,
        revision: 2,
        status: "completed",
        goal: "monitoring",
        goalSelectedAt: "2026-07-16T19:00:00.000Z",
        milestones: {
          chartReadyAt: "2026-07-16T19:01:00.000Z",
          priceAlertCreatedAt: null,
          backtestCompletedAt: null,
          paperBotCreatedAt: null
        },
        completedAt: "2026-07-16T19:01:00.000Z",
        dismissedAt: null,
        createdAt: "2026-07-16T18:00:00.000Z",
        updatedAt: "2026-07-16T19:01:00.000Z"
      }
    });
  });

  await page.route("**/api/workspaces**", (route) => {
    const owner = route.request().headers()["x-sbv2-expected-user"] ?? null;
    if (owner !== R52_OWNER_ID) violations.push(`workspace owner: ${owner ?? "<missing>"}`);
    return json(route, { workspaces: [], page: { hasMore: false }, quota: workspaceQuota() });
  });

  await page.route("**/api/trade/**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/trade/auth") {
      return json(route, {
        ok: true,
        demo: true,
        liveTradingEnabled: false,
        secureTradingOrigin: false,
        role: "paper-trade",
        csrfToken: R52_CSRF,
        runtimeProfile: "public-http-paper",
        executionMode: "paper-only",
        privateExchangeRequests: false,
        credentialWrites: false
      });
    }
    if (request.method() === "POST" && pathname === "/api/trade/ws-ticket") return json(route, { ticket: "r52-browser-ticket" });
    if (request.method() === "GET" && pathname === "/api/trade/bots") return json(route, { bots: [] });
    if (request.method() === "GET" && pathname === "/api/trade/arbitrage-alerts") return json(route, { rules: [], deliveries: [] });
    unexpectedApiRequests.push(`${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_trade_request", error: `${request.method()} ${pathname}` }, 501);
  });

  await page.route("**/api/screener/**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    requests.push({
      method: request.method(),
      path: pathname,
      ownerHeader,
      csrfHeader: request.headers()["x-csrf-token"] ?? null
    });
    if (request.method() === "GET" && pathname === "/api/screener/presets") {
      if (ownerHeader !== R52_OWNER_ID) {
        violations.push(`GET ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
        return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
      }
      return json(route, parseScreenerPresetListV1({
        schemaVersion: "screener-preset-list-v1",
        presets: [],
        generatedAt: iso(BASE_TIME),
        researchOnly: true,
        executionPermission: false
      }));
    }
    unexpectedApiRequests.push(`${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_screener_request", error: `${request.method()} ${pathname}` }, 501);
  });

  await page.route("**/api/jobs**", (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = parseBody(request.postData());
    requests.push({
      method: request.method(),
      path: pathname,
      ownerHeader,
      csrfHeader,
      ...(body ? { body } : {})
    });
    if (ownerHeader !== R52_OWNER_ID) {
      violations.push(`${request.method()} ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }

    if (request.method() === "POST" && pathname === "/api/jobs") {
      if (csrfHeader !== R52_CSRF) {
        violations.push(`POST ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
        return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
      }
      const problem = screenerEnqueueProblem(body);
      if (problem) {
        violations.push(`POST ${pathname}: ${problem}`);
        return json(route, { code: "invalid_request", error: "Invalid screener job." }, 400);
      }
      screenEnqueued = true;
      return json(route, { job: { id: R52_JOB_ID, status: "queued" } }, 202);
    }

    const pollMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/u);
    if (request.method() === "GET" && pollMatch) {
      if (!screenEnqueued || decodeURIComponent(pollMatch[1]!) !== R52_JOB_ID) {
        return json(route, { code: "job_not_found", error: "Job not found." }, 404);
      }
      jobPollCount += 1;
      return json(route, { job: { id: R52_JOB_ID, status: "completed", result: screenerRunResult() } });
    }

    unexpectedApiRequests.push(`${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_jobs_request", error: `${request.method()} ${pathname}` }, 501);
  });

  await installSocketFixture(page);
  return {
    requests,
    violations,
    unexpectedApiRequests,
    candleRequests,
    jobPolls: () => jobPollCount
  };
}

export function screenerRunResult(): ScreenerRunResultV1 {
  return parseScreenerRunResultV1({
    schemaVersion: "screener-run-result-v1",
    definitionHash: "c".repeat(64),
    generatedAt: iso(BASE_TIME + 60_000),
    timeframe: R52_SCREEN_TIMEFRAME,
    closedBarTimeMin: BASE_TIME - 3_600_000,
    closedBarTimeMax: BASE_TIME,
    universe: { requested: 100, evaluated: 98, matched: 2, unavailable: 2 },
    unavailableReasons: { "indicator-warm-up": 2 },
    rows: [
      {
        symbol: "BTCUSDT",
        lastClose: "64703.52",
        closedBarTime: BASE_TIME,
        change24hPercent: "2.15",
        quoteVolume24h: "1284000000",
        metrics: { rsi: "27.42", atrPercent: "3.18" },
        matchedFilters: 3
      },
      {
        symbol: "ETHUSDT",
        lastClose: "3401.75",
        closedBarTime: BASE_TIME,
        change24hPercent: "-1.08",
        quoteVolume24h: "812000000",
        metrics: { rsi: "24.1", atrPercent: "2.44" },
        matchedFilters: 3
      }
    ],
    rowsTruncated: false,
    researchOnly: true,
    executionPermission: false
  });
}

function screenerEnqueueProblem(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return "missing body";
  if (body.kind !== "screener") return `kind ${String(body.kind)}`;
  if (typeof body.clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(body.clientRequestId)) return "invalid clientRequestId";
  const request = record(body.request);
  if (!request) return "missing request";
  if (request.schemaVersion !== "screener-run-request-v1") return "wrong request schema";
  if (request.researchOnly !== true || request.executionPermission !== false) return "safety envelope violated";
  if (!record(request.definition)) return "missing definition";
  return undefined;
}

async function installAlertReadFixture(
  page: Page,
  violations: string[],
  unexpectedApiRequests: string[]
): Promise<void> {
  await page.route("**/api/alerts**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const owner = request.headers()["x-sbv2-expected-user"] ?? null;
    const supportedPath = url.pathname === "/api/alerts"
      || url.pathname === "/api/alerts/events"
      || url.pathname === "/api/alerts/outbox"
      || url.pathname === "/api/alerts/bindings";

    if (request.method() !== "GET" || !supportedPath) {
      unexpectedApiRequests.push(`${request.method()} ${url.pathname}`);
      return json(route, { code: "unexpected_alert_request", error: `${request.method()} ${url.pathname}` }, 501);
    }
    if (owner !== R52_OWNER_ID) {
      violations.push(`${request.method()} ${url.pathname}: owner ${owner ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }

    if (url.pathname === "/api/alerts") {
      return json(route, parseAlertRuleListV1({
        schemaVersion: ALERT_RULE_LIST_SCHEMA_V1,
        rules: [],
        generatedAt: iso(BASE_TIME + 30_000),
        researchOnly: true,
        executionPermission: false
      }));
    }
    if (url.pathname === "/api/alerts/events") {
      return json(route, parseAlertEventPageV1({
        schemaVersion: ALERT_EVENT_PAGE_SCHEMA_V1,
        events: [],
        nextCursor: "r52_owner_alert_cursor_v1_0",
        hasMore: false,
        generatedAt: iso(BASE_TIME + 30_000),
        researchOnly: true,
        executionPermission: false
      }));
    }
    if (url.pathname === "/api/alerts/bindings") {
      return json(route, { bindings: [], researchOnly: true, executionPermission: false });
    }
    return json(route, { items: [], researchOnly: true, executionPermission: false });
  });
}

function instrument(symbol: string, displayName: string, basePrice: number, decimals: number) {
  return {
    symbol,
    displayName,
    assetClass: "crypto",
    exchange: "Binance",
    currency: "USDT",
    provider: "binance",
    basePrice,
    decimals
  };
}

function chartCandles() {
  return Array.from({ length: 120 }, (_, index) => ({
    time: BASE_TIME - (120 - index) * 60_000,
    open: 64_000 + index * 5,
    high: 64_030 + index * 5,
    low: 63_980 + index * 5,
    close: 64_010 + index * 5,
    volume: 100 + index,
    source: "synthetic"
  }));
}

function workspaceQuota() {
  return {
    activeCount: 0,
    activeLimit: 50,
    totalCount: 0,
    totalLimit: 100,
    payloadBytesUsed: 0,
    payloadBytesLimit: 50 * 1_048_576,
    maxDocumentBytes: 1_048_576,
    maxDatabaseDocumentBytes: 1_048_576,
    maxRevisions: 25
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
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

async function installSocketFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class R52WebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly protocol = "";
      readonly extensions = "";
      readonly bufferedAmount = 0;
      readonly binaryType = "blob";
      readyState = R52WebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = R52WebSocket.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
          const path = new URL(this.url, window.location.href).pathname;
          if (path === "/quotes") this.emit({ type: "quotes_snapshot", timeframe: "1m", provider: "r52-fixture", series: { BTCUSDT: { last: 64_700, changePct: 0.42, points: [64_620, 64_700] } }, ts: Date.now() });
        }, 0);
      }

      send() {}

      close(code = 1000, reason = "") {
        if (this.readyState === R52WebSocket.CLOSED) return;
        this.readyState = R52WebSocket.CLOSED;
        const event = new CloseEvent("close", { code, reason, wasClean: true });
        this.onclose?.(event);
        this.dispatchEvent(event);
      }

      private emit(value: unknown) {
        const event = new MessageEvent<string>("message", { data: JSON.stringify(value) });
        this.onmessage?.(event);
        this.dispatchEvent(event);
      }
    }
    window.WebSocket = R52WebSocket as unknown as typeof WebSocket;
  });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
