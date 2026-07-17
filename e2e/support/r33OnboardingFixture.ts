import type { Page, Route } from "@playwright/test";
import type { TradingBot } from "../../frontend/src/trading/tradeClient";

export const R33_OWNER_ID = "10000000-0000-4000-8000-000000000033";
export const R33_OWNER_LOGIN = "fresh-r33";

export const R33_GOALS = ["monitoring", "price-alert", "backtest", "paper-robot"] as const;
export type R33Goal = (typeof R33_GOALS)[number];

export const R33_MILESTONES = ["chart-ready", "price-alert-created", "backtest-completed", "paper-bot-created"] as const;
export type R33Milestone = (typeof R33_MILESTONES)[number];

interface R33OnboardingState {
  schemaVersion: 1;
  revision: number;
  status: "not_started" | "in_progress" | "completed" | "dismissed";
  goal: R33Goal | null;
  goalSelectedAt: string | null;
  milestones: {
    chartReadyAt: string | null;
    priceAlertCreatedAt: string | null;
    backtestCompletedAt: string | null;
    paperBotCreatedAt: string | null;
  };
  completedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OnboardingRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  body?: Record<string, unknown>;
}

interface WorkspaceDocument {
  id: string;
  clientId: string;
  revision: number;
  status: "active" | "archived";
  archivedAt?: string;
  name: string;
  payload: Record<string, unknown>;
}

export interface R33RouteFixture {
  readonly onboardingRequests: OnboardingRequest[];
  readonly ownerViolations: string[];
  readonly workspaceDocuments: WorkspaceDocument[];
  readonly bots: TradingBot[];
  state(): R33OnboardingState;
}

const GOAL_MILESTONE: Record<R33Goal, R33Milestone> = {
  monitoring: "chart-ready",
  "price-alert": "price-alert-created",
  backtest: "backtest-completed",
  "paper-robot": "paper-bot-created"
};

const MILESTONE_FIELD: Record<R33Milestone, keyof R33OnboardingState["milestones"]> = {
  "chart-ready": "chartReadyAt",
  "price-alert-created": "priceAlertCreatedAt",
  "backtest-completed": "backtestCompletedAt",
  "paper-bot-created": "paperBotCreatedAt"
};

export async function installR33RouteFixture(page: Page): Promise<R33RouteFixture> {
  const ownerViolations: string[] = [];
  const onboardingRequests: OnboardingRequest[] = [];
  const workspaceDocuments: WorkspaceDocument[] = [];
  const bots: TradingBot[] = [];
  const states = new Map<string, R33OnboardingState>([[R33_OWNER_ID, freshState()]]);

  await page.route("**/api/auth/config", (route) =>
    json(route, {
      mode: "database",
      authRequired: true,
      registrationEnabled: true,
      tradingRoleAssignmentsEnabled: true
    })
  );
  await page.route("**/api/auth/me", (route) =>
    json(route, {
      user: {
        id: R33_OWNER_ID,
        login: R33_OWNER_LOGIN,
        status: "active",
        appRole: "user",
        tradingRole: "paper-trade",
        mustChangePassword: false,
        authorizationRevision: 1,
        approvedAt: "2026-07-16T20:00:00.000Z",
        createdAt: "2026-07-16T20:00:00.000Z",
        updatedAt: "2026-07-16T20:00:00.000Z"
      },
      csrfToken: "csrf-r33",
      expiresAt: "2026-07-17T20:00:00.000Z",
      tradingAvailable: true
    })
  );

  await page.route("**/api/onboarding**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const body = request.postData() ? safeBody(request.postData()!) : undefined;
    onboardingRequests.push({
      method: request.method(),
      path: pathname,
      ownerHeader,
      csrfHeader,
      ...(body ? { body } : {})
    });

    if (ownerHeader !== R33_OWNER_ID) {
      ownerViolations.push(`${request.method()} ${pathname}: expected owner ${R33_OWNER_ID}, received ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    const current = states.get(ownerHeader);
    if (!current) {
      ownerViolations.push(`${request.method()} ${pathname}: state for owner ${ownerHeader} does not exist`);
      return json(route, { code: "not_found", error: "Onboarding state not found." }, 404);
    }

    if (request.method() === "GET" && pathname === "/api/onboarding") {
      return json(route, { onboarding: clone(current) });
    }
    if (csrfHeader !== "csrf-r33") {
      ownerViolations.push(`${request.method()} ${pathname}: missing or invalid CSRF token`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }
    if (!body || body.revision !== current.revision) {
      return json(route, { code: "onboarding_conflict", error: "Onboarding revision changed.", current: clone(current) }, 409);
    }

    if (request.method() === "PUT" && pathname === "/api/onboarding/goal") {
      const goal = body.goal;
      if (current.status !== "not_started" || !R33_GOALS.includes(goal as R33Goal)) {
        return json(route, { code: "invalid_goal_transition", error: "Goal cannot be selected.", current: clone(current) }, 409);
      }
      const now = timestamp();
      const next: R33OnboardingState = {
        ...current,
        revision: current.revision + 1,
        status: "in_progress",
        goal: goal as R33Goal,
        goalSelectedAt: now,
        completedAt: null,
        dismissedAt: null,
        updatedAt: now
      };
      states.set(ownerHeader, next);
      return json(route, { onboarding: clone(next) });
    }

    if (request.method() === "POST" && pathname === "/api/onboarding/milestones") {
      const milestone = body.milestone as R33Milestone;
      if (
        current.status !== "in_progress" ||
        current.goal === null ||
        !R33_MILESTONES.includes(milestone) ||
        GOAL_MILESTONE[current.goal] !== milestone
      ) {
        return json(route, { code: "invalid_milestone_transition", error: "Milestone does not match the active goal.", current: clone(current) }, 409);
      }
      const now = timestamp();
      const field = MILESTONE_FIELD[milestone];
      const next: R33OnboardingState = {
        ...current,
        revision: current.revision + 1,
        status: "completed",
        milestones: { ...current.milestones, [field]: now },
        completedAt: now,
        updatedAt: now
      };
      states.set(ownerHeader, next);
      return json(route, { onboarding: clone(next) });
    }

    if (request.method() === "POST" && pathname === "/api/onboarding/dismiss") {
      const now = timestamp();
      const next: R33OnboardingState = {
        ...current,
        revision: current.revision + 1,
        status: "dismissed",
        dismissedAt: now,
        updatedAt: now
      };
      states.set(ownerHeader, next);
      return json(route, { onboarding: clone(next) });
    }

    if (request.method() === "POST" && pathname === "/api/onboarding/restart") {
      const now = timestamp();
      const next: R33OnboardingState = {
        ...freshState(now),
        revision: current.revision + 1,
        createdAt: current.createdAt
      };
      states.set(ownerHeader, next);
      return json(route, { onboarding: clone(next) });
    }

    return json(route, { code: "unexpected_onboarding_request", error: `${request.method()} ${pathname}` }, 500);
  });

  await page.route("**/api/workspaces**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    if (ownerHeader !== R33_OWNER_ID) {
      ownerViolations.push(`${request.method()} ${pathname}: workspace owner header ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    if (request.method() === "GET" && pathname === "/api/workspaces") {
      return json(route, {
        workspaces: workspaceDocuments.map((document) => ({ ...document })),
        page: { hasMore: false },
        quota: workspaceQuota(workspaceDocuments.length)
      });
    }
    if (request.method() === "POST" && pathname === "/api/workspaces") {
      const body = safeBody(request.postData() ?? "");
      const clientId = string(body.clientId);
      const name = string(body.name);
      const payload = record(body.payload);
      if (!clientId || !name || !payload) {
        return json(route, { code: "invalid_workspace", error: "Workspace payload is invalid." }, 400);
      }
      const existing = workspaceDocuments.find((candidate) => candidate.clientId === clientId);
      if (existing) return json(route, { code: "workspace_conflict", error: "Workspace already exists.", current: existing }, 409);
      const document: WorkspaceDocument = {
        id: `remote-r33-${workspaceDocuments.length + 1}`,
        clientId,
        revision: 1,
        status: "active",
        name,
        payload
      };
      workspaceDocuments.push(document);
      return json(route, {
        workspace: { ...document },
        quota: workspaceQuota(workspaceDocuments.length)
      });
    }
    const documentMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/u);
    if (request.method() === "PUT" && documentMatch) {
      const index = workspaceDocuments.findIndex((candidate) => candidate.id === decodeURIComponent(documentMatch[1]));
      const current = workspaceDocuments[index];
      const body = safeBody(request.postData() ?? "");
      const payload = record(body.payload);
      if (!current || body.revision !== current.revision || !payload) {
        return json(route, { code: "workspace_conflict", error: "Workspace revision changed.", current }, 409);
      }
      const next: WorkspaceDocument = {
        ...current,
        revision: current.revision + 1,
        name: string(body.name) || current.name,
        payload
      };
      workspaceDocuments[index] = next;
      return json(route, {
        workspace: { ...next },
        quota: workspaceQuota(workspaceDocuments.length)
      });
    }
    return json(route, { code: "unexpected_workspace_request", error: `${request.method()} ${pathname}` }, 500);
  });

  await page.route("**/api/trade/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "GET" && pathname === "/api/trade/auth") {
      return json(route, {
        ok: true,
        demo: true,
        liveTradingEnabled: false,
        secureTradingOrigin: false,
        role: "paper-trade",
        csrfToken: "csrf-r33",
        runtimeProfile: "public-http-paper",
        executionMode: "paper-only",
        privateExchangeRequests: false,
        credentialWrites: false
      });
    }
    if (request.method() === "POST" && pathname === "/api/trade/ws-ticket") {
      return json(route, { ticket: "r33-browser-ticket" });
    }
    if (pathname === "/api/trade/bots" && request.method() === "GET") {
      return json(route, { bots: clone(bots) });
    }
    if (pathname === "/api/trade/bots" && request.method() === "POST") {
      const body = safeBody(request.postData() ?? "");
      const now = Date.now();
      const bot = {
        ...body,
        id: `paper-r33-${bots.length + 1}`,
        name: string(body.name) || `R3.3 paper bot ${bots.length + 1}`,
        strategyName: string(body.strategyName) || "Strategy",
        symbol: string(body.symbol) || "BTCUSDT",
        timeframe: string(body.timeframe) || "1m",
        exchange: "paper",
        market: body.market === "spot" ? "spot" : "futures",
        sizeMode: body.sizeMode === "base" || body.sizeMode === "equity_pct" || body.sizeMode === "risk_pct" ? body.sizeMode : "quote",
        sizeValue: number(body.sizeValue, 100),
        leverage: number(body.leverage, 1),
        notifyMarkers: body.notifyMarkers !== false,
        status: "stopped",
        createdAt: now,
        updatedAt: now
      } as TradingBot;
      bots.push(bot);
      return json(route, { bot: clone(bot) });
    }
    const detail = pathname.match(/^\/api\/trade\/bots\/([^/]+)\/(fills|logs|orders|order-journal)$/u);
    if (request.method() === "GET" && detail) {
      const key = detail[2] === "order-journal" ? "orders" : detail[2];
      return json(route, { [key]: [] });
    }
    const live = pathname.match(/^\/api\/trade\/bots\/([^/]+)\/live$/u);
    if (request.method() === "GET" && live) {
      return json(route, { account: { balance: 10_000, equity: 10_000, currency: "USDT" }, position: null, price: 100, paused: false });
    }
    return json(route, { code: "unexpected_trade_request", error: `${request.method()} ${pathname}` }, 500);
  });

  return {
    onboardingRequests,
    ownerViolations,
    workspaceDocuments,
    bots,
    state: () => clone(states.get(R33_OWNER_ID)!)
  };
}

export async function installR33SocketFixture(page: Page, candles: readonly Record<string, unknown>[]): Promise<void> {
  await page.addInitScript((rows) => {
    class R33WebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly protocol = "";
      readonly extensions = "";
      readonly bufferedAmount = 0;
      readonly binaryType = "blob";
      readyState = R33WebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = R33WebSocket.OPEN;
          const open = new Event("open");
          this.onopen?.(open);
          this.dispatchEvent(open);
          this.publishInitialMessage(rows);
        }, 0);
      }

      close(code = 1000, reason = "") {
        if (this.readyState === R33WebSocket.CLOSED) return;
        this.readyState = R33WebSocket.CLOSED;
        const close = new CloseEvent("close", { code, reason, wasClean: true });
        this.onclose?.(close);
        this.dispatchEvent(close);
      }

      send() {}

      private publishInitialMessage(rows: readonly Record<string, unknown>[]) {
        const url = new URL(this.url, window.location.href);
        if (url.pathname === "/trade-stream" || url.pathname === "/orderbook" || url.pathname === "/trade-flow") return;
        if (url.pathname === "/quotes") {
          const symbols = (url.searchParams.get("symbols") ?? "BTCUSDT").split(",").filter(Boolean);
          const series = Object.fromEntries(symbols.map((symbol) => [symbol, { last: 118.4, changePct: 1.2, points: [117.8, 118.4] }]));
          this.emit({ type: "quotes_snapshot", timeframe: "1m", provider: "r33-fixture", series, ts: Date.now() });
          return;
        }
        if (url.pathname === "/stream") {
          this.emit({
            type: "snapshot",
            symbol: url.searchParams.get("symbol") ?? "BTCUSDT",
            timeframe: url.searchParams.get("timeframe") ?? "1m",
            candles: rows,
            provider: "r33-fixture",
            ts: Date.now()
          });
        }
      }

      private emit(value: unknown) {
        const message = new MessageEvent<string>("message", { data: JSON.stringify(value) });
        this.onmessage?.(message);
        this.dispatchEvent(message);
      }
    }

    window.WebSocket = R33WebSocket as unknown as typeof WebSocket;
  }, candles);
}

function freshState(now = "2026-07-16T20:00:00.000Z"): R33OnboardingState {
  return {
    schemaVersion: 1,
    revision: 0,
    status: "not_started",
    goal: null,
    goalSelectedAt: null,
    milestones: {
      chartReadyAt: null,
      priceAlertCreatedAt: null,
      backtestCompletedAt: null,
      paperBotCreatedAt: null
    },
    completedAt: null,
    dismissedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function workspaceQuota(count: number) {
  return {
    activeCount: count,
    activeLimit: 50,
    totalCount: count,
    totalLimit: 100,
    payloadBytesUsed: 0,
    payloadBytesLimit: 50 * 1_048_576,
    maxDocumentBytes: 1_048_576,
    maxDatabaseDocumentBytes: 1_048_576,
    maxRevisions: 25
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function safeBody(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
