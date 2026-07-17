import type { Page, Route } from "@playwright/test";
import type {
  EvidenceValue,
  PaperMoney,
  PaperPortfolioDetail,
  PaperPortfolioMetadata,
  PaperPortfolioMutationResult,
  PaperPortfolioProjection,
  PaperRobotControlStatus,
  PaperRobotJournal,
  PaperRobotProjection
} from "../../frontend/src/trading/paperPortfolioTypes";

export const R4_OWNER_ID = "10000000-0000-4000-8000-000000000044";
export const R4_OWNER_LOGIN = "r4-paper-owner";
export const R4_PRIMARY_PORTFOLIO_ID = "20000000-0000-4000-8000-000000000041";
export const R4_ARCHIVE_PORTFOLIO_ID = "20000000-0000-4000-8000-000000000042";
export const R4_PRIMARY_BOT_ID = "30000000-0000-4000-8000-000000000041";

const CSRF = "csrf-r4-paper";
const BASE_TIME = Date.parse("2026-07-16T20:00:00.000Z");

type PaperAction = "start" | "pause" | "resume" | "stop";

interface PortfolioState {
  metadata: PaperPortfolioMetadata;
  initialCapital: PaperMoney;
  hasRobot: boolean;
  botStatus: PaperRobotControlStatus;
  botRevision: number;
}

export interface R4PaperRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  idempotencyKey: string | null;
  body?: Record<string, unknown>;
}

export interface R4PaperPortfolioFixture {
  readonly requests: R4PaperRequest[];
  readonly violations: string[];
  readonly unexpectedApiRequests: string[];
  failNextDetailRefresh(): void;
  portfolio(id: string): PaperPortfolioMetadata | undefined;
  detail(id: string): PaperPortfolioDetail | undefined;
}

export async function installR4PaperPortfolioFixture(page: Page): Promise<R4PaperPortfolioFixture> {
  const requests: R4PaperRequest[] = [];
  const violations: string[] = [];
  const unexpectedApiRequests: string[] = [];
  const portfolios = initialPortfolios();
  let mutationClock = BASE_TIME + 20_000;
  let createdPortfolioSequence = 0;
  let failDetailRequests = 0;

  // Fail closed on every API that is not explicitly mocked below. The document
  // and static assets still come from Playwright's isolated web server, but no
  // application request can reach its database or trading runtime.
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    unexpectedApiRequests.push(`${request.method()} ${path}`);
    return json(route, { code: "unexpected_mock_request", error: `${request.method()} ${path}` }, 501);
  });

  await page.route("**/api/catalog", (route) => json(route, {
    instruments: [instrument("BTCUSDT", "Bitcoin / Tether", 64_700, 2)],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
    chartTypes: ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]
  }));
  await page.route("**/api/candles?**", (route) => {
    const rows = chartCandles();
    return json(route, {
      instrument: instrument("BTCUSDT", "Bitcoin / Tether", rows.at(-1)!.close, 2),
      candles: rows,
      provider: "r4-browser-fixture",
      hasMore: false
    });
  });
  await page.route("**/api/sparklines?**", (route) => json(route, {
    timeframe: "1m",
    series: { BTCUSDT: { last: 64_700, changePct: 0.42, points: [64_620, 64_680, 64_700] } }
  }));

  await page.route("**/api/auth/config", (route) => json(route, {
    mode: "database",
    authRequired: true,
    registrationEnabled: true,
    tradingRoleAssignmentsEnabled: true
  }));
  await page.route("**/api/auth/me", (route) => json(route, {
    user: {
      id: R4_OWNER_ID,
      login: R4_OWNER_LOGIN,
      status: "active",
      appRole: "user",
      tradingRole: "paper-trade",
      mustChangePassword: false,
      authorizationRevision: 4,
      approvedAt: "2026-07-16T19:00:00.000Z",
      createdAt: "2026-07-16T18:00:00.000Z",
      updatedAt: "2026-07-16T19:00:00.000Z"
    },
    csrfToken: CSRF,
    expiresAt: "2026-07-18T20:00:00.000Z",
    tradingAvailable: true
  }));

  await page.route("**/api/onboarding**", (route) => {
    const request = route.request();
    const owner = request.headers()["x-sbv2-expected-user"] ?? null;
    if (owner !== R4_OWNER_ID) violations.push(`onboarding owner: ${owner ?? "<missing>"}`);
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
    const request = route.request();
    const owner = request.headers()["x-sbv2-expected-user"] ?? null;
    if (owner !== R4_OWNER_ID) violations.push(`workspace owner: ${owner ?? "<missing>"}`);
    return json(route, {
      workspaces: [],
      page: { hasMore: false },
      quota: workspaceQuota()
    });
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
        csrfToken: CSRF,
        runtimeProfile: "public-http-paper",
        executionMode: "paper-only",
        privateExchangeRequests: false,
        credentialWrites: false
      });
    }
    if (request.method() === "POST" && pathname === "/api/trade/ws-ticket") {
      return json(route, { ticket: "r4-browser-ticket" });
    }
    if (request.method() === "GET" && pathname === "/api/trade/bots") return json(route, { bots: [] });
    unexpectedApiRequests.push(`${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_trade_request", error: `${request.method()} ${pathname}` }, 501);
  });

  // Registered after the broad trading route so Playwright dispatches the
  // canonical portfolio API to this stateful handler first.
  await page.route("**/api/trade/paper-portfolios**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const body = parseBody(request.postData());
    const ownerHeader = request.headers()["x-sbv2-expected-user"] ?? null;
    const csrfHeader = request.headers()["x-csrf-token"] ?? null;
    const idempotencyKey = request.headers()["idempotency-key"] ?? null;
    const record: R4PaperRequest = {
      method: request.method(),
      path: pathname,
      ownerHeader,
      csrfHeader,
      idempotencyKey,
      ...(body ? { body } : {})
    };
    requests.push(record);

    if (ownerHeader !== R4_OWNER_ID) {
      violations.push(`${request.method()} ${pathname}: owner ${ownerHeader ?? "<missing>"}`);
      return json(route, { code: "owner_context_changed", error: "Owner context changed." }, 409);
    }
    const mutating = request.method() !== "GET";
    if (mutating && csrfHeader !== CSRF) {
      violations.push(`${request.method()} ${pathname}: CSRF ${csrfHeader ?? "<missing>"}`);
      return json(route, { code: "csrf_invalid", error: "CSRF token is invalid." }, 403);
    }
    if (mutating && !idempotencyKey) {
      violations.push(`${request.method()} ${pathname}: idempotency key missing`);
      return json(route, { code: "idempotency_key_required", error: "Idempotency-Key is required." }, 400);
    }

    if (request.method() === "GET" && pathname === "/api/trade/paper-portfolios") {
      return json(route, listResponse(portfolios));
    }

    const detailMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)$/u);
    if (request.method() === "GET" && detailMatch) {
      if (failDetailRequests > 0) {
        failDetailRequests -= 1;
        return json(route, { code: "fixture_refresh_unavailable", error: "Fixture refresh is unavailable." }, 503);
      }
      const state = portfolios.get(decodeURIComponent(detailMatch[1]!));
      return state ? json(route, detailFor(state)) : json(route, { code: "not_found", error: "Portfolio not found." }, 404);
    }

    if (request.method() === "POST" && pathname === "/api/trade/paper-portfolios") {
      const name = string(body?.name);
      const initialCapital = canonicalMoney(body?.initialCapital);
      if (!name || !initialCapital) return json(route, { code: "invalid_input", error: "Invalid portfolio input." }, 400);
      createdPortfolioSequence += 1;
      const id = `20000000-0000-4000-8000-${String(100 + createdPortfolioSequence).padStart(12, "0")}`;
      const state: PortfolioState = {
        metadata: metadata(id, name, false, mutationClock),
        initialCapital,
        hasRobot: false,
        botStatus: "stopped",
        botRevision: 1
      };
      mutationClock += 1_000;
      portfolios.set(id, state);
      return json(route, mutationFor(state), 201);
    }

    const renameMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)$/u);
    if (request.method() === "PATCH" && renameMatch) {
      const state = portfolios.get(decodeURIComponent(renameMatch[1]!));
      if (!state) return json(route, { code: "not_found", error: "Portfolio not found." }, 404);
      const name = string(body?.name);
      if (!name) return json(route, { code: "invalid_input", error: "Name is required." }, 400);
      touch(state, mutationClock, { name });
      mutationClock += 1_000;
      return json(route, mutationFor(state));
    }

    const defaultMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)\/default$/u);
    if (request.method() === "POST" && defaultMatch) {
      const state = portfolios.get(decodeURIComponent(defaultMatch[1]!));
      if (!state) return json(route, { code: "not_found", error: "Portfolio not found." }, 404);
      for (const candidate of portfolios.values()) candidate.metadata.isDefault = false;
      touch(state, mutationClock, { isDefault: true });
      mutationClock += 1_000;
      return json(route, mutationFor(state));
    }

    const archiveMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)\/archive$/u);
    if (request.method() === "POST" && archiveMatch) {
      const state = portfolios.get(decodeURIComponent(archiveMatch[1]!));
      if (!state) return json(route, { code: "not_found", error: "Portfolio not found." }, 404);
      if (body?.confirm !== "ARCHIVE_PAPER_PORTFOLIO") return json(route, { code: "confirmation_required", error: "Archive confirmation is required." }, 400);
      touch(state, mutationClock, { status: "archived", isDefault: false, archivedAt: mutationClock });
      mutationClock += 1_000;
      return json(route, mutationFor(state));
    }

    const resetMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)\/reset$/u);
    if (request.method() === "POST" && resetMatch) {
      const state = portfolios.get(decodeURIComponent(resetMatch[1]!));
      if (!state) return json(route, { code: "not_found", error: "Portfolio not found." }, 404);
      if (body?.confirm !== "RESET_PAPER_PORTFOLIO") return json(route, { code: "confirmation_required", error: "Reset confirmation is required." }, 400);
      const initialCapital = body?.initialCapital === undefined ? state.initialCapital : canonicalMoney(body.initialCapital);
      if (!initialCapital) return json(route, { code: "invalid_money", error: "Initial capital is invalid." }, 400);
      state.initialCapital = initialCapital;
      state.hasRobot = false;
      touch(state, mutationClock, { currentEpoch: state.metadata.currentEpoch + 1 });
      mutationClock += 1_000;
      return json(route, mutationFor(state));
    }

    const actionMatch = pathname.match(/^\/api\/trade\/paper-portfolios\/([^/]+)\/robots\/([^/]+)\/actions$/u);
    if (request.method() === "POST" && actionMatch) {
      const state = portfolios.get(decodeURIComponent(actionMatch[1]!));
      const botId = decodeURIComponent(actionMatch[2]!);
      const action = paperAction(body?.action);
      if (!state || !state.hasRobot || botId !== R4_PRIMARY_BOT_ID) return json(route, { code: "not_found", error: "Robot not found." }, 404);
      if (!action || body?.confirm !== true) return json(route, { code: "confirmation_required", error: "Robot action confirmation is required." }, 400);
      state.botStatus = nextBotStatus(action);
      state.botRevision += 1;
      touch(state, mutationClock);
      mutationClock += 1_000;
      return json(route, mutationFor(state));
    }

    unexpectedApiRequests.push(`${request.method()} ${pathname}`);
    return json(route, { code: "unexpected_portfolio_request", error: `${request.method()} ${pathname}` }, 501);
  });

  await installSocketFixture(page);
  return {
    requests,
    violations,
    unexpectedApiRequests,
    failNextDetailRefresh: () => {
      failDetailRequests += 1;
    },
    portfolio: (id) => clone(portfolios.get(id)?.metadata),
    detail: (id) => {
      const state = portfolios.get(id);
      return state ? clone(detailFor(state)) : undefined;
    }
  };
}

function initialPortfolios(): Map<string, PortfolioState> {
  return new Map([
    [R4_PRIMARY_PORTFOLIO_ID, {
      metadata: metadata(R4_PRIMARY_PORTFOLIO_ID, "Primary Paper", true, BASE_TIME),
      initialCapital: "10000.000000",
      hasRobot: true,
      botStatus: "running",
      botRevision: 7
    }],
    [R4_ARCHIVE_PORTFOLIO_ID, {
      metadata: metadata(R4_ARCHIVE_PORTFOLIO_ID, "Archive Candidate", false, BASE_TIME + 1_000),
      initialCapital: "2500.000000",
      hasRobot: false,
      botStatus: "stopped",
      botRevision: 1
    }]
  ]);
}

function metadata(id: string, name: string, isDefault: boolean, createdAt: number): PaperPortfolioMetadata {
  return {
    ownerUserId: R4_OWNER_ID,
    id,
    name,
    status: "active",
    currency: "USDT",
    revision: 1,
    currentEpoch: 1,
    isDefault,
    createdAt,
    updatedAt: createdAt
  };
}

function listResponse(portfolios: Map<string, PortfolioState>) {
  return {
    schemaVersion: "paper-portfolio-list-v1",
    asOf: BASE_TIME + 60_000,
    portfolios: [...portfolios.values()].map((state) => clone(state.metadata))
  };
}

function mutationFor(state: PortfolioState): PaperPortfolioMutationResult {
  return { ...detailFor(state), replayed: false };
}

function detailFor(state: PortfolioState): PaperPortfolioDetail {
  const snapshot = projectionFor(state);
  const robots = state.hasRobot ? [{
    botId: R4_PRIMARY_BOT_ID,
    botRevision: state.botRevision,
    name: "Momentum Guardian",
    strategyName: "Structure momentum",
    symbol: "BTCUSDT",
    status: state.botStatus,
    lastError: "Previous quote refresh recovered; verify stale evidence before acting.",
    journal: journalFor(state)
  }] : [];
  return {
    portfolio: clone(state.metadata),
    snapshot,
    robots,
    ...(state.hasRobot ? { lastError: "Portfolio recovered from a delayed valuation mark." } : {})
  };
}

function projectionFor(state: PortfolioState): PaperPortfolioProjection {
  const epochStartedAt = BASE_TIME + (state.metadata.currentEpoch - 1) * 10_000;
  const asOf = BASE_TIME + 60_000;
  const robot = state.hasRobot ? robotFor(state, epochStartedAt) : undefined;
  const initial = state.initialCapital;
  const aggregates = robot ? {
    allocatedCapital: "6000.000000",
    unallocatedCash: "4000.000000",
    initialCapital: initial,
    cashBalance: "10024.500000",
    feesPaid: "2.500000",
    fundingNet: "1.000000",
    realizedNetCashPnl: "24.500000",
    legacyCashAdjustments: "0.000000",
    cashEventMaxDrawdown: "18.000000",
    unrealizedPnl: availableMoney("6.750000", BASE_TIME + 3_000),
    grossExposure: staleMoney("12942.000000", BASE_TIME + 3_000, "The latest closed-bar mark is older than the freshness window."),
    netExposure: availableMoney("12942.000000", BASE_TIME + 3_000),
    equity: staleMoney("10031.250000", BASE_TIME + 3_000, "The latest closed-bar mark is older than the freshness window."),
    reservedCapital: "6000.000000",
    availableCapital: "4024.500000",
    committedCapital: staleMoney("6000.000000", BASE_TIME + 3_000, "Position evidence is stale."),
    margin: unavailableMoney("Margin evidence is unavailable in the paper ledger."),
    borrowing: unavailableMoney("Borrowing evidence is unavailable in the paper ledger."),
    tradeStatistics: statistics()
  } : emptyAggregates(initial, asOf);
  return {
    schemaVersion: "paper-portfolio-v1",
    formulaVersion: "paper-metrics-v1",
    ownerUserId: R4_OWNER_ID,
    portfolioId: state.metadata.id,
    ledgerEpoch: state.metadata.currentEpoch,
    epochStartedAt,
    asOf,
    robots: robot ? [robot] : [],
    positions: [],
    openOrders: [],
    aggregates,
    cashConservation: conservation(aggregates.cashBalance)
  };
}

function robotFor(state: PortfolioState, epochStartedAt: number): PaperRobotProjection {
  return {
    ownerUserId: R4_OWNER_ID,
    portfolioId: state.metadata.id,
    ledgerEpoch: state.metadata.currentEpoch,
    botId: R4_PRIMARY_BOT_ID,
    botRevision: state.botRevision,
    market: "futures",
    allocation: "6000.000000",
    allocationStatus: "active",
    runtimeState: "idle",
    ledger: { eventCount: 4, lastSequence: 4, observedAt: epochStartedAt + 4_000 },
    metrics: {
      cashBalance: "6024.500000",
      feesPaid: "2.500000",
      fundingNet: "1.000000",
      realizedNetCashPnl: "24.500000",
      legacyCashAdjustments: "0.000000",
      cashEventMaxDrawdown: "18.000000",
      unrealizedPnl: availableMoney("6.750000", epochStartedAt + 3_000),
      grossExposure: staleMoney("12942.000000", epochStartedAt + 3_000, "The closed-bar mark is stale."),
      netExposure: availableMoney("12942.000000", epochStartedAt + 3_000),
      equity: staleMoney("6031.250000", epochStartedAt + 3_000, "The closed-bar equity mark is stale."),
      reservedCapital: "6000.000000",
      committedCapital: staleMoney("6000.000000", epochStartedAt + 3_000, "Position evidence is stale."),
      margin: unavailableMoney("No durable paper margin evidence exists."),
      borrowing: unavailableMoney("No durable paper borrowing evidence exists."),
      tradeStatistics: statistics()
    },
    positions: [],
    openOrders: [],
    cashConservation: conservation("6024.500000")
  };
}

function journalFor(state: PortfolioState): PaperRobotJournal {
  const epochStartedAt = BASE_TIME + (state.metadata.currentEpoch - 1) * 10_000;
  return {
    schemaVersion: "paper-robot-journal-v1",
    ownerUserId: R4_OWNER_ID,
    portfolioId: state.metadata.id,
    ledgerEpoch: state.metadata.currentEpoch,
    botId: R4_PRIMARY_BOT_ID,
    botRevision: state.botRevision,
    curve: {
      formulaVersion: "paper-realized-cash-curve-v1",
      basis: "current-epoch-realized-cash",
      pointOrder: "oldest-first",
      truncated: false,
      sourceCashPointCount: 2,
      points: [
        { basis: "cash-realized", sequence: 1, ts: epochStartedAt + 1_000, cashBalance: "6000.000000", realizedNetCashPnl: "0.000000" },
        { basis: "cash-realized", sequence: 4, ts: epochStartedAt + 4_000, cashBalance: "6024.500000", realizedNetCashPnl: "24.500000" }
      ]
    },
    recentFills: {
      order: "newest-first",
      truncated: false,
      items: [
        { fillId: "fill-close-1", sequence: 3, ts: epochStartedAt + 3_000, symbol: "BTCUSDT", side: "sell", kind: "close", qty: 0.1, price: "64700.000000", fee: "1.250000", feeAsset: "USDT", realizedPnl: "26.000000" },
        { fillId: "fill-open-1", sequence: 2, ts: epochStartedAt + 2_000, symbol: "BTCUSDT", side: "buy", kind: "open", qty: 0.1, price: "64440.000000", fee: "1.250000", feeAsset: "USDT", realizedPnl: "0.000000" }
      ]
    },
    recentEvents: {
      order: "newest-first",
      truncated: false,
      items: [
        { eventId: "event-command-1", sequence: 4, ts: epochStartedAt + 4_000, type: "command_completed" },
        { eventId: "event-fill-close-1", sequence: 3, ts: epochStartedAt + 3_000, type: "fill" },
        { eventId: "event-fill-open-1", sequence: 2, ts: epochStartedAt + 2_000, type: "fill" },
        { eventId: "event-account-1", sequence: 1, ts: epochStartedAt + 1_000, type: "account_initialized" }
      ]
    }
  };
}

function emptyAggregates(initialCapital: PaperMoney, observedAt: number): PaperPortfolioProjection["aggregates"] {
  return {
    allocatedCapital: "0.000000",
    unallocatedCash: initialCapital,
    initialCapital,
    cashBalance: initialCapital,
    feesPaid: "0.000000",
    fundingNet: "0.000000",
    realizedNetCashPnl: "0.000000",
    legacyCashAdjustments: "0.000000",
    cashEventMaxDrawdown: "0.000000",
    unrealizedPnl: availableMoney("0.000000", observedAt),
    grossExposure: availableMoney("0.000000", observedAt),
    netExposure: availableMoney("0.000000", observedAt),
    equity: availableMoney(initialCapital, observedAt),
    reservedCapital: "0.000000",
    availableCapital: initialCapital,
    committedCapital: availableMoney("0.000000", observedAt),
    margin: unavailableMoney("Margin is unavailable without a paper robot."),
    borrowing: unavailableMoney("Borrowing is unavailable without a paper robot."),
    tradeStatistics: statistics(false)
  };
}

function statistics(withTrades = true) {
  return {
    closedTrades: withTrades ? 2 : 0,
    winningTrades: withTrades ? 1 : 0,
    losingTrades: withTrades ? 1 : 0,
    breakevenTrades: 0,
    grossProfit: withTrades ? "42.500000" : "0.000000",
    grossLoss: withTrades ? "-18.000000" : "0.000000",
    winRate: withTrades ? availableNumber(0.5) : unavailableNumber("No closed trades."),
    profitFactor: withTrades ? availableNumber(2.361111) : unavailableNumber("No losses are available."),
    expectancy: withTrades ? availableMoney("12.250000", BASE_TIME + 3_000) : unavailableMoney("No closed trades.")
  };
}

function conservation(cashBalance: PaperMoney) {
  return {
    expectedCashBalance: cashBalance,
    actualCashBalance: cashBalance,
    difference: "0.000000",
    balanced: true as const
  };
}

function availableMoney(value: PaperMoney, observedAt: number): EvidenceValue<PaperMoney> {
  return { status: "available", value, observedAt, source: "r4-closed-bar-mark" };
}

function staleMoney(lastValue: PaperMoney, observedAt: number, reason: string): EvidenceValue<PaperMoney> {
  return { status: "stale", lastValue, observedAt, source: "r4-closed-bar-mark", staleByMs: 120_000, reason };
}

function unavailableMoney(reason: string): EvidenceValue<PaperMoney> {
  return { status: "unavailable", reason };
}

function availableNumber(value: number): EvidenceValue<number> {
  return { status: "available", value, observedAt: BASE_TIME + 3_000, source: "r4-ledger-statistics" };
}

function unavailableNumber(reason: string): EvidenceValue<number> {
  return { status: "unavailable", reason };
}

function touch(state: PortfolioState, updatedAt: number, patch: Partial<PaperPortfolioMetadata> = {}): void {
  state.metadata = {
    ...state.metadata,
    ...patch,
    revision: state.metadata.revision + 1,
    updatedAt
  };
}

function nextBotStatus(action: PaperAction): PaperRobotControlStatus {
  if (action === "pause") return "paused";
  if (action === "stop") return "stopped";
  return "running";
}

function paperAction(value: unknown): PaperAction | undefined {
  return value === "start" || value === "pause" || value === "resume" || value === "stop" ? value : undefined;
}

function canonicalMoney(value: unknown): PaperMoney | undefined {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.\d{6}$/u.test(value) && value !== "0.000000" ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBody(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
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

function instrument(symbol: string, displayName: string, basePrice: number, decimals: number) {
  return {
    symbol,
    displayName,
    assetClass: "crypto",
    exchange: "R4 fixture",
    currency: "USDT",
    provider: "synthetic",
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

async function installSocketFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class R4WebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly protocol = "";
      readonly extensions = "";
      readonly bufferedAmount = 0;
      readonly binaryType = "blob";
      readyState = R4WebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = R4WebSocket.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
          const path = new URL(this.url, window.location.href).pathname;
          if (path === "/quotes") this.emit({ type: "quotes_snapshot", timeframe: "1m", provider: "r4-fixture", series: { BTCUSDT: { last: 64_700, changePct: 0.42, points: [64_620, 64_700] } }, ts: Date.now() });
        }, 0);
      }

      send() {}

      close(code = 1000, reason = "") {
        if (this.readyState === R4WebSocket.CLOSED) return;
        this.readyState = R4WebSocket.CLOSED;
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
    window.WebSocket = R4WebSocket as unknown as typeof WebSocket;
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

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
