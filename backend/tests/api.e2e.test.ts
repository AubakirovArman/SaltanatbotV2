import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAuthToken } from "../src/auth.js";
import { initializeRuntimeConfig, resetRuntimeConfigForTests } from "../src/config/runtimeConfig.js";
import { createTradingApi } from "../src/trading/routes.js";
import {
  getBotForOwner,
  getSetting,
  getTradingAccountForOwner,
  getTradingAccountCredentialsForOwner,
  LEGACY_TRADING_OWNER_ID,
  setSetting,
  upsertBotForOwner
} from "../src/trading/store.js";
import { PaperMultiLegJournal, PaperMultiLegService, type PaperMultiLegPlan } from "../src/arbitrage/paperMultiLeg/index.js";
import { resolveRuntimeProfile, runtimePolicyFromConfig } from "../src/runtimeProfile.js";

// The HTTP tests never start a bot, so a no-op provider is enough — and it avoids
// pulling the real provider layer (and its native node:sqlite candle store).
const fakeProvider = {
  name: "fake",
  async getCandles() {
    return [];
  },
  async subscribe() {
    return { close() {} };
  }
} as never;

/**
 * End-to-end HTTP test of the trading API: boots the REAL Express router and
 * drives it over a live socket. The SQLite store is replaced with an in-memory
 * fake so the test never touches the working database. The IR validator, route
 * gating, and bot lifecycle are all real.
 */

vi.mock("../src/trading/store.js", () => {
  const bots = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  const accounts = new Map<string, unknown>();
  const credentials = new Map<string, unknown>();
  const audit: unknown[] = [];
  const LEGACY_TRADING_OWNER_ID = "legacy-operator";
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  class TradingAccountInUseError extends Error {
    constructor(readonly accountId: string, readonly botIds: readonly string[]) {
      super(`Trading account ${accountId} is used by ${botIds.length} bot(s).`);
    }
  }
  const defaultId = (exchange: string) => `${exchange}:default`;
  const ensureLegacyTradingAccount = (exchange: "binance" | "bybit") => {
    const id = defaultId(exchange);
    const existing = accounts.get(id);
    if (existing) return clone(existing);
    const now = Date.now();
    const account = { id, label: `${exchange} default`, exchange, ownership: "own", enabled: true, createdAt: now, updatedAt: now };
    accounts.set(id, clone(account));
    return clone(account);
  };
  return {
    LEGACY_TRADING_OWNER_ID,
    initStore: () => {},
    listBots: () => [...bots.values()].map((b) => clone(b)),
    listBotsForOwner: (owner: string) => [...bots.values()].map((b) => clone(b as { ownerUserId?: string })).filter((b) => (b.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner),
    getBotForOwner: (owner: string, id: string) => {
      const bot = bots.get(id) as { ownerUserId?: string } | undefined;
      return bot && (bot.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner ? clone(bot) : undefined;
    },
    getBotOwnerUserId: (id: string) => (bots.get(id) as { ownerUserId?: string } | undefined)?.ownerUserId ?? (bots.has(id) ? LEGACY_TRADING_OWNER_ID : undefined),
    upsertBot: (b: { id: string; ownerUserId?: string }) => bots.set(b.id, clone({ ...b, ownerUserId: b.ownerUserId ?? LEGACY_TRADING_OWNER_ID })),
    upsertBotForOwner: (owner: string, b: { id: string }) => bots.set(b.id, clone({ ...b, ownerUserId: owner })),
    deleteBot: (id: string) => {
      bots.delete(id);
      settings.delete(`paper:${id}`);
      settings.delete(`state:${id}`);
    },
    deleteBotForOwner: (owner: string, id: string) => {
      const bot = bots.get(id) as { ownerUserId?: string } | undefined;
      if (bot && (bot.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner) bots.delete(id);
    },
    deleteSetting: (k: string) => settings.delete(k),
    listTradingAccounts: () => [...accounts.values()].map((account) => clone(account)),
    listTradingAccountsForOwner: (owner: string) => [...accounts.values()].map((account) => clone(account as { ownerUserId?: string })).filter((account) => (account.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner),
    getTradingAccount: (id: string) => (accounts.has(id) ? clone(accounts.get(id)) : undefined),
    getTradingAccountForOwner: (owner: string, id: string) => {
      const account = accounts.get(id) as { ownerUserId?: string } | undefined;
      return account && (account.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner ? clone(account) : undefined;
    },
    insertTradingAccount: (account: { id: string }) => accounts.set(account.id, clone(account)),
    insertTradingAccountForOwner: (owner: string, account: { id: string }) => accounts.set(account.id, clone({ ...account, ownerUserId: owner })),
    updateTradingAccount: (account: { id: string }) => {
      if (!accounts.has(account.id)) return false;
      accounts.set(account.id, clone(account));
      return true;
    },
    updateTradingAccountForOwner: (owner: string, account: { id: string }) => {
      const current = accounts.get(account.id) as { ownerUserId?: string } | undefined;
      if (!current || (current.ownerUserId ?? LEGACY_TRADING_OWNER_ID) !== owner) return false;
      accounts.set(account.id, clone({ ...account, ownerUserId: owner }));
      return true;
    },
    ensureLegacyTradingAccount,
    deleteTradingAccount: (id: string) => {
      const botIds = [...bots.values()]
        .map((bot) => bot as { id: string; exchange: string; accountId?: string })
        .filter((bot) => (bot.accountId ?? (bot.exchange === "paper" ? `paper:${bot.id}` : defaultId(bot.exchange))) === id)
        .map((bot) => bot.id);
      if (botIds.length) throw new TradingAccountInUseError(id, botIds);
      return accounts.delete(id);
    },
    deleteTradingAccountForOwner: (owner: string, id: string) => {
      const account = accounts.get(id) as { ownerUserId?: string } | undefined;
      return !!account && (account.ownerUserId ?? LEGACY_TRADING_OWNER_ID) === owner && accounts.delete(id);
    },
    getTradingAccountCredentialsForOwner: (owner: string, id: string) => clone(credentials.get(`${owner}:${id}`)),
    hasTradingAccountCredentialsForOwner: (owner: string, id: string) => credentials.has(`${owner}:${id}`),
    setTradingAccountCredentialsForOwner: (owner: string, id: string, value: unknown) => credentials.set(`${owner}:${id}`, clone(value)),
    deleteTradingAccountCredentialsForOwner: (owner: string, id: string) => credentials.delete(`${owner}:${id}`),
    TradingAccountInUseError,
    insertFill: () => true,
    withStoreTransaction: <T>(operation: () => T) => operation(),
    listFills: () => [],
    listFillsForOwner: () => [],
    upsertOrderJournal: () => {},
    insertOrderEvent: () => {},
    listOrderJournal: () => [],
    listOrderJournalForOwner: () => [],
    listRiskOrderJournal: () => [],
    listExecutionReconciliationJournal: () => [],
    listOrderEvents: () => [],
    listOrderEventsForOwner: () => [],
    insertLog: () => {},
    listLogs: () => [],
    listLogsForOwner: () => [],
    insertAuditLog: (row: unknown) => audit.unshift(clone(row)),
    insertAuditLogForOwner: (owner: string, row: unknown) => audit.unshift(clone({ ...(row as object), ownerUserId: owner })),
    listAuditLog: (limit: number) => audit.slice(0, limit).map((row) => clone(row)),
    listAuditLogForOwner: (owner: string, limit: number) => audit.filter((row) => (row as { ownerUserId?: string }).ownerUserId === owner).slice(0, limit).map((row) => clone(row)),
    getSetting: (k: string) => (settings.has(k) ? clone(settings.get(k)) : undefined),
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v)),
    disarmAllLiveTradingSettings: () => {
      let changed = 0;
      for (const key of settings.keys()) {
        if (key === "liveTradingEnabled" || (key.startsWith("owner:") && key.endsWith(":liveTradingEnabled"))) {
          settings.set(key, false);
          changed += 1;
        }
      }
      return changed;
    }
  };
});

let base: string;
let server: Server;
let tradingApi: ReturnType<typeof createTradingApi>;
let sessionCookie: string;
let csrfToken: string;
let readOnlyCookie: string;
let readOnlyCsrf: string;
let paperCookie: string;
let paperCsrf: string;
let paperMultiLegJournal: PaperMultiLegJournal;
let binanceAccountId: string;
let bybitAccountId: string;
const startupRecoveryRunId = "api-startup-recovery-run";

const validBody = (over: Record<string, unknown> = {}) => {
  const exchange = (over.exchange as string | undefined) ?? "paper";
  return {
    name: "E2E",
    ir: { name: "t", inputs: [], body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange,
    ...(exchange === "binance" ? { accountId: binanceAccountId } : exchange === "bybit" ? { accountId: bybitAccountId } : {}),
    market: "spot",
    sizeMode: "quote",
    sizeValue: 1000,
    maxPositionQuote: 5_000,
    maxOrderQuote: 1_000,
    maxDailyLossQuote: 500,
    maxOpenOrders: 10,
    ...over
  };
};

beforeAll(async () => {
  resetRuntimeConfigForTests();
  initializeRuntimeConfig({ NODE_ENV: "test", RUNTIME_PROFILE: "public-http-paper", AUTH_MODE: "legacy" } as NodeJS.ProcessEnv);
  process.env.AUTH_READONLY_TOKEN = "readonly-test-token";
  process.env.AUTH_PAPER_TRADE_TOKEN = "paper-test-token";
  paperMultiLegJournal = PaperMultiLegJournal.open(":memory:");
  const paperMultiLeg = new PaperMultiLegService(paperMultiLegJournal);
  const interrupted = paperMultiLegPlan(startupRecoveryRunId, [10_000, 5_000, 10_000, 10_000]);
  paperMultiLegJournal.createRun(interrupted, "idem-api-startup-recovery", interrupted.createdAt);
  paperMultiLegJournal.advance(interrupted.runId, interrupted.createdAt + 1);
  paperMultiLegJournal.advance(interrupted.runId, interrupted.createdAt + 2);
  tradingApi = createTradingApi(fakeProvider, undefined, {
    emergencyAdapters: () => [],
    paperMultiLeg,
    runtimePolicy: runtimePolicyFromConfig({ runtimeProfile: "private-live" })
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const owner = req.headers["x-test-owner"];
    if (typeof owner === "string") res.locals.authUserId = owner;
    next();
  });
  app.use("/api/trade", tradingApi.router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/api/trade`;
  ({ cookie: sessionCookie, csrf: csrfToken } = await loginAs(getAuthToken()));
  ({ cookie: readOnlyCookie, csrf: readOnlyCsrf } = await loginAs("readonly-test-token"));
  ({ cookie: paperCookie, csrf: paperCsrf } = await loginAs("paper-test-token"));
  expect(sessionCookie).toMatch(/^sbv2_session=/);
  expect(csrfToken).toBeTruthy();
  binanceAccountId = ((await (await post("/accounts", { label: "Binance E2E", exchange: "binance" })).json()) as { account: { id: string } }).account.id;
  bybitAccountId = ((await (await post("/accounts", { label: "Bybit E2E", exchange: "bybit" })).json()) as { account: { id: string } }).account.id;
});

afterAll(() => {
  server?.close();
  paperMultiLegJournal?.close();
  resetRuntimeConfigForTests();
});

const authHeaders = (unsafe = false) => ({
  cookie: sessionCookie,
  ...(unsafe ? { "x-csrf-token": csrfToken } : {})
});
const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(true) }, body: JSON.stringify(b) });
const del = (p: string) => fetch(base + p, { method: "DELETE", headers: authHeaders(true) });
const patch = (p: string, b: unknown) => fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(true) }, body: JSON.stringify(b) });
const get = (p: string) => fetch(base + p, { headers: authHeaders() });

async function loginAs(token: string): Promise<{ cookie: string; csrf: string; role: string }> {
  const login = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const body = (await login.json()) as { csrfToken: string; role: string };
  return { cookie, csrf: body.csrfToken, role: body.role };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const flushPendingHttp = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

describe("trading API E2E (real router, in-memory store)", () => {
  it("rejects unauthenticated and session requests without CSRF", async () => {
    expect(await (await fetch(base + "/auth")).json()).toMatchObject({ ok: false });
    expect((await fetch(base + "/bots")).status).toBe(401);
    expect((await fetch(base + "/account-telemetry")).status).toBe(401);
    expect((await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie }, body: JSON.stringify({ liveTradingEnabled: true }) })).status).toBe(403);
  });

  it("GET /auth reports server + live-arm state", async () => {
    const res = await get("/auth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.liveTradingEnabled).toBe(false);
    expect(body.role).toBe("admin");
    expect(body.secureTradingOrigin).toBe(true);
    expect(await (await get("/settings")).json()).toMatchObject({ role: "admin", secureTradingOrigin: true });
  });

  it("enforces session roles for mutating endpoints", async () => {
    const readOnlyRes = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: readOnlyCookie, "x-csrf-token": readOnlyCsrf },
      body: JSON.stringify(validBody())
    });
    expect(readOnlyRes.status).toBe(403);

    const paperLiveRes = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: paperCookie, "x-csrf-token": paperCsrf },
      body: JSON.stringify(validBody({ exchange: "binance", market: "futures" }))
    });
    expect(paperLiveRes.status).toBe(403);

    const readOnlyUta = await fetch(base + "/bybit/uta", { headers: { cookie: readOnlyCookie } });
    expect(readOnlyUta.status).toBe(403);
    const readOnlyAccountTelemetry = await fetch(base + "/account-telemetry", { headers: { cookie: readOnlyCookie } });
    expect(readOnlyAccountTelemetry.status).toBe(403);
    expect((await fetch(base + "/accounts", { headers: { cookie: readOnlyCookie } })).status).toBe(200);
  });

  it("exposes account-isolated capabilities for additional accounts", async () => {
    const createdResponse = await post("/accounts", { label: "Managed desk", exchange: "bybit", ownership: "managed" });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.account).toMatchObject({
      label: "Managed desk",
      exchange: "bybit",
      ownership: "managed",
      status: "credentials_missing",
      credential: { mode: "account_isolated", status: "missing", isolated: true },
      capabilities: { liveExecution: false, credentialIsolation: true, multipleCredentialAccounts: true }
    });
    const configured = await fetch(`${base}/accounts/${created.account.id}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(true) },
      body: JSON.stringify({ apiKey: "abcdefgh", apiSecret: "supersecret" })
    });
    expect(configured.status).toBe(200);
    expect((await configured.json()).account).toMatchObject({ status: "ready", credential: { status: "configured", isolated: true } });
    expect((await fetch(`${base}/accounts/${created.account.id}/credentials`, { method: "DELETE", headers: authHeaders(true) })).status).toBe(200);
    expect((await del(`/accounts/${created.account.id}`)).status).toBe(200);
  });

  it("requires admin plus a secure origin for account mutations", async () => {
    const paperResponse = await fetch(base + "/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: paperCookie, "x-csrf-token": paperCsrf },
      body: JSON.stringify({ label: "Nope", exchange: "binance" })
    });
    expect(paperResponse.status).toBe(403);

    const insecure = await fetch(base + "/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(true),
        "x-forwarded-for": "203.0.113.8",
        "x-forwarded-proto": "http"
      },
      body: JSON.stringify({ label: "Nope", exchange: "binance" })
    });
    expect(insecure.status).toBe(426);
  });

  it("mounts the multi-leg journal only behind paper role and session CSRF", async () => {
    expect((await fetch(base + "/paper-multi-leg/runs")).status).toBe(401);
    expect((await fetch(base + "/paper-multi-leg/runs", { headers: { cookie: readOnlyCookie } })).status).toBe(403);
    expect((await fetch(base.replace(/\/api\/trade$/, "") + "/paper-multi-leg/runs")).status).toBe(404);

    expect((await fetch(base + "/paper-multi-leg/recovery", { headers: { cookie: paperCookie } })).status).toBe(403);
    const recovery = await get("/paper-multi-leg/recovery");
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      safety: { executionMode: "paper-only", liveOrders: false, privateRequests: false, credentialsAccepted: false },
      recovery: { status: "ready", recoveredRuns: 1 }
    });
    const recovered = await get(`/paper-multi-leg/runs/${startupRecoveryRunId}`);
    expect(await recovered.json()).toMatchObject({ run: { state: { status: "compensated", lastSequence: 7 } } });

    const plan = paperMultiLegPlan(`api-paper-run-${Date.now()}`, [10_000, 4_000, 10_000, 10_000]);
    const withoutCsrf = await fetch(base + "/paper-multi-leg/runs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "idempotency-key": `idem-${plan.runId}` },
      body: JSON.stringify({ plan })
    });
    expect(withoutCsrf.status).toBe(403);

    const created = await fetch(base + "/paper-multi-leg/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(true), "idempotency-key": `idem-${plan.runId}` },
      body: JSON.stringify({ plan })
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({ created: true, run: { state: { runId: plan.runId, status: "compensated" } } });
    expect(JSON.stringify(body)).not.toMatch(/idempotencyKey|apiKey|apiSecret|placeOrder/i);
  });

  it("cannot downgrade a running live runtime through a paper bot upsert", async () => {
    const created = (await (await post("/bots", validBody())).json()) as { bot: Record<string, unknown> & { id: string } };
    const runtimeConfig = {
      ...created.bot,
      exchange: "bybit",
      market: "futures",
      status: "running"
    };
    const running = (tradingApi.engine as unknown as { running: Map<string, { config: typeof runtimeConfig }> }).running;
    running.set(created.bot.id, { config: runtimeConfig });

    try {
      const paperHeaders = {
        "content-type": "application/json",
        cookie: paperCookie,
        "x-csrf-token": paperCsrf
      };
      const paperMutation = (path: string, body: unknown) =>
        fetch(base + path, {
          method: "POST",
          headers: paperHeaders,
          body: JSON.stringify(body)
        });

      expect((await paperMutation("/bots", validBody({ id: created.bot.id }))).status).toBe(403);
      expect((await post("/bots", validBody({ id: created.bot.id }))).status).toBe(409);
      expect((await paperMutation(`/bots/${created.bot.id}/command`, { command: "action=openposition;side=buy;qty=1" })).status).toBe(403);
      expect((await paperMutation(`/bots/${created.bot.id}/stop`, {})).status).toBe(403);
      expect((await paperMutation(`/bots/${created.bot.id}/confirm-resume`, {})).status).toBe(403);
    } finally {
      running.delete(created.bot.id);
    }
  });

  it("keeps Bybit UTA mutations closed until keys and live arm are configured", async () => {
    const status = await get("/bybit/uta");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false });

    const borrow = await post("/bybit/uta/borrow", { coin: "USDT", amount: 100, confirm: true });
    expect(borrow.status).toBe(409);
    expect((await borrow.json()).error).toMatch(/keys are not configured/i);
  });

  it("never selects a disabled configured account for telemetry or direct Bybit UTA mutations", async () => {
    const created = await (await post("/accounts", {
      label: "Disabled Bybit",
      exchange: "bybit",
      enabled: false
    })).json() as { account: { id: string } };
    const id = created.account.id;
    const credentials = await fetch(`${base}/accounts/${id}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(true) },
      body: JSON.stringify({ apiKey: "disabled-api-key", apiSecret: "disabled-api-secret" })
    });
    expect(credentials.status).toBe(200);
    expect(await (await get("/keys")).json()).toMatchObject({ bybit: false });

    const mutations = [
      ["borrow", { coin: "USDT", amount: 1, confirm: true }],
      ["repay", { coin: "USDT", repaymentType: "ALL", convertCollateral: false, confirm: true }],
      ["collateral", { coin: "BTC", enabled: false, confirm: true }]
    ] as const;
    for (const [operation, body] of mutations) {
      const response = await post(`/bybit/uta/${operation}?accountId=${encodeURIComponent(id)}`, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "TRADING_ACCOUNT_DISABLED" });
    }

    expect((await fetch(`${base}/accounts/${id}/credentials`, {
      method: "DELETE",
      headers: authHeaders(true)
    })).status).toBe(200);
    expect((await del(`/accounts/${id}`)).status).toBe(200);
  });

  it("serializes credential rotation and removal with account-bound bot lifecycle checks", async () => {
    const createdAccount = await (await post("/accounts", {
      label: "Lifecycle locked Bybit",
      exchange: "bybit"
    })).json() as { account: { id: string } };
    const accountId = createdAccount.account.id;
    const originalKeys = { apiKey: "original-api-key", apiSecret: "original-api-secret" };
    expect((await fetch(`${base}/accounts/${accountId}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(true) },
      body: JSON.stringify(originalKeys)
    })).status).toBe(200);
    const createdBot = await (await post("/bots", validBody({
      exchange: "bybit",
      market: "futures",
      accountId
    }))).json() as { bot: Record<string, unknown> & { id: string } };
    const running = (tradingApi.engine as unknown as {
      running: Map<string, { config: typeof createdBot.bot }>;
    }).running;

    const rotationGate = deferred();
    const rotationEntered = deferred();
    const rotationBlocker = tradingApi.engine.withAccountLifecycleLock(
      LEGACY_TRADING_OWNER_ID,
      accountId,
      async () => {
        rotationEntered.resolve();
        await rotationGate.promise;
      }
    );
    await rotationEntered.promise;
    const rotation = fetch(`${base}/accounts/${accountId}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(true) },
      body: JSON.stringify({ apiKey: "replacement-api-key", apiSecret: "replacement-api-secret" })
    });
    let rotationSettled = false;
    void rotation.then(
      () => { rotationSettled = true; },
      () => { rotationSettled = true; }
    );
    await flushPendingHttp();
    expect(rotationSettled).toBe(false);
    running.set(createdBot.bot.id, { config: { ...createdBot.bot, status: "running" } });
    rotationGate.resolve();
    await rotationBlocker;
    const rotationResponse = await rotation;
    expect(rotationResponse.status).toBe(409);
    expect(await rotationResponse.json()).toMatchObject({ code: "TRADING_ACCOUNT_RUNNING" });
    expect(getTradingAccountCredentialsForOwner(LEGACY_TRADING_OWNER_ID, accountId)).toEqual(originalKeys);
    running.delete(createdBot.bot.id);
    expect((await del(`/bots/${createdBot.bot.id}`)).status).toBe(200);

    const removalGate = deferred();
    const removalEntered = deferred();
    const removalBlocker = tradingApi.engine.withAccountLifecycleLock(
      LEGACY_TRADING_OWNER_ID,
      accountId,
      async () => {
        removalEntered.resolve();
        await removalGate.promise;
      }
    );
    await removalEntered.promise;
    const removal = fetch(`${base}/accounts/${accountId}/credentials`, {
      method: "DELETE",
      headers: authHeaders(true)
    });
    let removalSettled = false;
    void removal.then(
      () => { removalSettled = true; },
      () => { removalSettled = true; }
    );
    await flushPendingHttp();
    expect(removalSettled).toBe(false);
    const reboundBotId = `${createdBot.bot.id}-rebound`;
    upsertBotForOwner(LEGACY_TRADING_OWNER_ID, { ...createdBot.bot, id: reboundBotId, accountId, status: "stopped" } as never);
    removalGate.resolve();
    await removalBlocker;
    const removalResponse = await removal;
    expect(removalResponse.status).toBe(409);
    expect(await removalResponse.json()).toMatchObject({ code: "TRADING_ACCOUNT_IN_USE" });
    expect(getTradingAccountCredentialsForOwner(LEGACY_TRADING_OWNER_ID, accountId)).toEqual(originalKeys);

    expect((await del(`/bots/${reboundBotId}`)).status).toBe(200);
    expect((await fetch(`${base}/accounts/${accountId}/credentials`, {
      method: "DELETE",
      headers: authHeaders(true)
    })).status).toBe(200);
    expect((await del(`/accounts/${accountId}`)).status).toBe(200);
  });

  it("creates a paper bot with valid IR and lists it", async () => {
    const res = await post("/bots", validBody());
    expect(res.status).toBe(200);
    const { bot } = await res.json();
    expect(bot.id).toBeTruthy();
    expect(bot.status).toBe("stopped");
    const list = await (await get("/bots")).json();
    expect(list.bots.some((b: { id: string }) => b.id === bot.id)).toBe(true);
  });

  it("isolates bot REST resources by authenticated owner, including admin sessions", async () => {
    const ownerA = "11111111-1111-4111-8111-111111111111";
    const ownerB = "22222222-2222-4222-8222-222222222222";
    const create = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(true), "x-test-owner": ownerA },
      body: JSON.stringify(validBody({ name: "Only A" }))
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { bot: { id: string; ownerUserId?: string } };
    expect(created.bot.ownerUserId).toBeUndefined();

    const listA = await fetch(base + "/bots", { headers: { ...authHeaders(), "x-test-owner": ownerA } });
    const listB = await fetch(base + "/bots", { headers: { ...authHeaders(), "x-test-owner": ownerB } });
    expect((await listA.json()).bots).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.bot.id })]));
    expect((await listB.json()).bots).toEqual([]);
    expect((await get("/bots")).status).toBe(200);
    expect(((await (await get("/bots")).json()).bots as Array<{ id: string }>).some((bot) => bot.id === created.bot.id)).toBe(false);

    const foreignRead = await fetch(`${base}/bots/${created.bot.id}/fills`, { headers: { ...authHeaders(), "x-test-owner": ownerB } });
    expect(foreignRead.status).toBe(404);
    const foreignMutation = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(true), "x-test-owner": ownerB },
      body: JSON.stringify(validBody({ id: created.bot.id, name: "Stolen" }))
    });
    expect(foreignMutation.status).toBe(404);
  });

  it("requires every positive risk cap for live bots but not paper bots", async () => {
    const paper = validBody({ maxPositionQuote: undefined, maxOrderQuote: undefined, maxDailyLossQuote: undefined, maxOpenOrders: undefined });
    expect((await post("/bots", paper)).status).toBe(200);

    const live = { ...paper, exchange: "binance", market: "futures" };
    const missing = await post("/bots", live);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/Live risk limits are incomplete/);
    expect((await post("/bots", { ...validBody({ exchange: "binance", maxOrderQuote: 6_000 }) })).status).toBe(400);
  });

  it("refuses to delete an account while a bot is bound to it", async () => {
    const created = await (await post("/bots", validBody({ exchange: "bybit", market: "futures" }))).json();
    expect(created.bot.accountId).toBe(bybitAccountId);
    const disabled = await patch(`/accounts/${bybitAccountId}`, { enabled: false });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ code: "TRADING_ACCOUNT_IN_USE", botIds: expect.arrayContaining([created.bot.id]) });
    const response = await del(`/accounts/${bybitAccountId}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TRADING_ACCOUNT_IN_USE", botIds: expect.arrayContaining([created.bot.id]) });
  });

  it("blocks dangerous live mutations behind an untrusted HTTP proxy marker while keeping paper available", async () => {
    const insecurePost = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(true),
          "x-forwarded-for": "203.0.113.7",
          "x-forwarded-proto": "http"
        },
        body: JSON.stringify(body)
      });

    expect((await insecurePost("/bots", validBody())).status).toBe(200);
    expect((await insecurePost("/settings", { liveTradingEnabled: true })).status).toBe(426);
    expect((await insecurePost("/keys", { exchange: "binance", apiKey: "abcdefgh", apiSecret: "supersecret" })).status).toBe(426);
    expect((await insecurePost("/bybit/uta/borrow", { coin: "USDT", amount: 100, confirm: true })).status).toBe(426);
    expect((await insecurePost("/bots", validBody({ exchange: "binance", market: "futures" }))).status).toBe(426);
  });

  it("persists explicit Bybit cross-collateral opt-in only for Bybit futures", async () => {
    const live = await (await post("/bots", validBody({ exchange: "bybit", market: "futures", bybitCrossCollateral: true }))).json();
    expect(live.bot.bybitCrossCollateral).toBe(true);
    const paper = await (await post("/bots", validBody({ bybitCrossCollateral: true }))).json();
    expect(paper.bot.bybitCrossCollateral).toBe(false);
  });

  it("rejects IR with an unknown node kind (structural whitelist)", async () => {
    const res = await post("/bots", validBody({ ir: { name: "x", inputs: [], body: [{ k: "eval", code: "x" }] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid strategy IR/);
  });

  it("rejects IR with an unknown extra field (strict schema)", async () => {
    const res = await post("/bots", validBody({ ir: { name: "x", inputs: [], body: [{ k: "exit", when: { k: "bool", v: true }, sneaky: 1 }] } }));
    expect(res.status).toBe(400);
  });

  it("rejects IR stamped with a future schema version", async () => {
    const res = await post("/bots", validBody({ ir: { name: "x", inputs: [], body: [{ k: "exit", when: { k: "bool", v: true } }], v: 999 } }));
    expect(res.status).toBe(400);
  });

  it("gates a live bot start behind the arm flag (403, no network)", async () => {
    const created = await (await post("/bots", validBody({ exchange: "binance", market: "futures" }))).json();
    const res = await post(`/bots/${created.bot.id}/start`, {});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not armed/i);
  });

  it("disables Binance spot accounting and keeps Bybit spot behind the inventory flag", async () => {
    expect((await post("/settings", { liveTradingEnabled: true })).status).toBe(200);
    const binance = await post("/bots", validBody({ exchange: "binance", market: "spot" }));
    expect(binance.status).toBe(400);
    expect((await binance.json()).error).toMatch(/Binance live spot is disabled/i);
    const created = await (await post("/bots", validBody({ exchange: "bybit", market: "spot" }))).json();
    const res = await post(`/bots/${created.bot.id}/start`, { confirmLive: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Live spot trading is disabled/i);
    expect((await post("/settings", { liveTradingEnabled: false })).status).toBe(200);
  });

  it("confirm-resume returns false when the bot isn't paused", async () => {
    const created = await (await post("/bots", validBody())).json();
    const res = await post(`/bots/${created.bot.id}/confirm-resume`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });

  it("reset-state succeeds for a stopped bot", async () => {
    const created = await (await post("/bots", validBody())).json();
    const res = await post(`/bots/${created.bot.id}/reset-state`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("re-checks runtime state inside config-update and reset lifecycle locks", async () => {
    const created = await (await post("/bots", validBody({ name: "Before race" }))).json() as { bot: { id: string } };
    const id = created.bot.id;
    const persisted = getBotForOwner(LEGACY_TRADING_OWNER_ID, id)!;
    const running = (tradingApi.engine as unknown as { running: Map<string, { config: typeof persisted }> }).running;

    const updateGate = deferred();
    const updateEntered = deferred();
    const updateBlocker = tradingApi.engine.withBotLifecycleLock(LEGACY_TRADING_OWNER_ID, id, async () => {
      updateEntered.resolve();
      await updateGate.promise;
    });
    await updateEntered.promise;
    const update = post("/bots", validBody({ id, name: "Raced update" }));
    let updateSettled = false;
    void update.then(() => { updateSettled = true; }, () => { updateSettled = true; });
    await flushPendingHttp();
    expect(updateSettled).toBe(false);
    running.set(id, { config: { ...persisted, status: "running" } });
    updateGate.resolve();
    await updateBlocker;
    expect((await update).status).toBe(409);
    expect(getBotForOwner(LEGACY_TRADING_OWNER_ID, id)?.name).toBe("Before race");
    running.delete(id);

    setSetting(`state:${id}`, { vars: { count: 7 } });
    const resetGate = deferred();
    const resetEntered = deferred();
    const resetBlocker = tradingApi.engine.withBotLifecycleLock(LEGACY_TRADING_OWNER_ID, id, async () => {
      resetEntered.resolve();
      await resetGate.promise;
    });
    await resetEntered.promise;
    const reset = post(`/bots/${id}/reset-state`, {});
    let resetSettled = false;
    void reset.then(() => { resetSettled = true; }, () => { resetSettled = true; });
    await flushPendingHttp();
    expect(resetSettled).toBe(false);
    running.set(id, { config: { ...persisted, status: "running" } });
    resetGate.resolve();
    await resetBlocker;
    expect((await reset).status).toBe(409);
    expect(getSetting(`state:${id}`)).toEqual({ vars: { count: 7 } });
    running.delete(id);
    expect((await del(`/bots/${id}`)).status).toBe(200);
  });

  it("rejects a queued start when a same-millisecond config edit changed its captured revision", async () => {
    const created = await (await post("/bots", validBody({ name: "Old revision" }))).json() as { bot: { id: string } };
    const id = created.bot.id;
    const originalRevision = getBotForOwner(LEGACY_TRADING_OWNER_ID, id)!.updatedAt;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(originalRevision);
    const gate = deferred();
    const entered = deferred();
    const blocker = tradingApi.engine.withBotLifecycleLock(LEGACY_TRADING_OWNER_ID, id, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const originalLifecycle = tradingApi.engine.withBotLifecycleLock.bind(tradingApi.engine);
    const editQueued = deferred();
    const lifecycleSpy = vi.spyOn(tradingApi.engine, "withBotLifecycleLock").mockImplementation((...args) => {
      editQueued.resolve();
      return originalLifecycle(...args);
    });
    let restoreStartSpy = () => {};
    try {
      const edit = post("/bots", validBody({ id, name: "New revision" }));
      await editQueued.promise;
      const originalStart = tradingApi.engine.startForOwner.bind(tradingApi.engine);
      const startQueued = deferred();
      const startSpy = vi.spyOn(tradingApi.engine, "startForOwner").mockImplementation((...args) => {
        startQueued.resolve();
        return originalStart(...args);
      });
      restoreStartSpy = () => startSpy.mockRestore();
      const start = post(`/bots/${id}/start`, {});
      await startQueued.promise;

      gate.resolve();
      await blocker;
      expect((await edit).status).toBe(200);
      const startResponse = await start;
      expect(startResponse.status).toBe(400);
      expect((await startResponse.json()).error).toMatch(/configuration changed/i);
      expect(getBotForOwner(LEGACY_TRADING_OWNER_ID, id)?.name).toBe("New revision");
      expect(getBotForOwner(LEGACY_TRADING_OWNER_ID, id)?.updatedAt).toBe(originalRevision + 1);
      expect(tradingApi.engine.isRunningForOwner(LEGACY_TRADING_OWNER_ID, id)).toBe(false);
    } finally {
      gate.resolve();
      await blocker;
      restoreStartSpy();
      lifecycleSpy.mockRestore();
      nowSpy.mockRestore();
      await del(`/bots/${id}`);
    }
  });

  it("tombstones a bot before a queued HTTP delete can be overtaken by stale start", async () => {
    const created = await (await post("/bots", validBody({ name: "Delete race" }))).json() as { bot: { id: string } };
    const id = created.bot.id;
    const stale = getBotForOwner(LEGACY_TRADING_OWNER_ID, id)!;
    const gate = deferred();
    const entered = deferred();
    const blocker = tradingApi.engine.withBotLifecycleLock(LEGACY_TRADING_OWNER_ID, id, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const originalDelete = tradingApi.engine.deleteSafelyForOwner.bind(tradingApi.engine);
    const deleteEntered = deferred();
    const deleteSpy = vi.spyOn(tradingApi.engine, "deleteSafelyForOwner").mockImplementation((...args) => {
      deleteEntered.resolve();
      return originalDelete(...args);
    });
    const deletion = del(`/bots/${id}`);
    await deleteEntered.promise;

    await expect(tradingApi.engine.start(stale)).rejects.toThrow(/access changed/i);
    gate.resolve();
    await blocker;
    expect((await deletion).status).toBe(200);
    expect(getBotForOwner(LEGACY_TRADING_OWNER_ID, id)).toBeUndefined();
    deleteSpy.mockRestore();
  });

  it("exposes the durable order journal endpoints", async () => {
    const created = await (await post("/bots", validBody())).json();
    const journal = await get(`/bots/${created.bot.id}/order-journal`);
    expect(journal.status).toBe(200);
    expect(await journal.json()).toEqual({ orders: [] });
    const events = await get(`/bots/${created.bot.id}/order-journal/order-1/events`);
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({ events: [] });
  });

  it("writes an audit log with redacted secrets for mutating routes", async () => {
    const res = await fetch(`${base}/accounts/${binanceAccountId}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(true) },
      body: JSON.stringify({ apiKey: "abcdefgh", apiSecret: "supersecret" })
    });
    expect(res.status).toBe(200);
    const audit = await (await get("/audit?limit=20")).json();
    const event = audit.events.find((item: { action: string }) => item.action.includes("/credentials"));
    expect(event).toBeTruthy();
    expect(event.role).toBe("admin");
    expect(event.data.body.apiKey).toBe("[redacted]");
    expect(event.data.body.apiSecret).toBe("[redacted]");
    const accounts = await (await get("/accounts")).json();
    expect(accounts.accounts.find((account: { id: string }) => account.id === binanceAccountId)).toMatchObject({
      status: "ready",
      credential: { mode: "account_isolated", status: "configured", isolated: true },
      capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true }
    });
    expect(JSON.stringify(accounts)).not.toContain("supersecret");
  });

  it("deletes a bot", async () => {
    const created = await (await post("/bots", validBody())).json();
    const res = await del(`/bots/${created.bot.id}`);
    expect(res.status).toBe(200);
    const list = await (await get("/bots")).json();
    expect(list.bots.some((b: { id: string }) => b.id === created.bot.id)).toBe(false);
  });

  it("runs an idempotent emergency stop and exposes its terminal status", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const first = await post("/kill", { operationId });
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ operationId, ok: true, phase: "terminal", flattenRequested: false });
    expect(await (await post("/kill", { operationId })).json()).toEqual(result);
    expect(await (await get("/kill")).json()).toEqual(result);
  });

  it("requires a second explicit confirmation before flattening positions", async () => {
    const response = await post("/kill", { flatten: true });
    expect(response.status).toBe(428);
    expect((await response.json()).error).toContain("FLATTEN_ALL_LIVE_POSITIONS");
  });

  it("clears a confirmed terminal emergency only through explicit live re-arm", async () => {
    const armed = await post("/settings", { liveTradingEnabled: true });
    expect(armed.status).toBe(200);
    expect(await (await get("/kill")).json()).toMatchObject({ phase: "idle", ok: true });
    expect((await post("/settings", { liveTradingEnabled: false })).status).toBe(200);
  });

  it("delivers a price alert through the notify channel", async () => {
    expect((await post("/notify-alert", { symbol: "BTCUSDT", price: 65000, direction: "above", hitPrice: 65010 })).status).toBe(200);
    expect((await post("/notify-alert", { symbol: "", price: "x", direction: "sideways" })).status).toBe(400);
  });
});

describe("public-http-paper API boundary", () => {
  it("keeps research/paper available while every private entry point fails closed", async () => {
    const runtimePolicy = resolveRuntimeProfile({ RUNTIME_PROFILE: "public-http-paper" } as NodeJS.ProcessEnv);
    const emergencyAdapters = vi.fn(() => []);
    const api = createTradingApi(fakeProvider, undefined, { emergencyAdapters, paperMultiLeg: false, runtimePolicy });
    const paperApp = express();
    paperApp.use(express.json());
    paperApp.use("/api/trade", api.router);
    const paperServer = await new Promise<Server>((resolve) => {
      const listener = paperApp.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = paperServer.address();
    if (!address || typeof address === "string") throw new Error("paper-only test server did not bind");
    const paperBase = `http://127.0.0.1:${address.port}/api/trade`;

    try {
      const login = await fetch(`${paperBase}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: getAuthToken() })
      });
      expect(login.status).toBe(200);
      const loginBody = await login.json() as { csrfToken: string; runtimeProfile: string; executionMode: string };
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const mutationHeaders = { cookie, "x-csrf-token": loginBody.csrfToken, "content-type": "application/json" };
      expect(loginBody).toMatchObject({ runtimeProfile: "public-http-paper", executionMode: "paper-only" });

      const paperBot = await fetch(`${paperBase}/bots`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify(validBody({ name: "Paper-only allowed" }))
      });
      expect(paperBot.status).toBe(200);

      const liveId = `paper-boundary-live-${Date.now()}`;
      upsertBotForOwner(LEGACY_TRADING_OWNER_ID, {
        ...validBody({ id: liveId, name: "Persisted live", exchange: "binance", market: "futures" }),
        id: liveId,
        ownerUserId: LEGACY_TRADING_OWNER_ID,
        status: "stopped",
        createdAt: Date.now(),
        updatedAt: Date.now()
      } as never);

      const rejected = await Promise.all([
        fetch(`${paperBase}/bots`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(validBody({ exchange: "binance", market: "futures" })) }),
        fetch(`${paperBase}/bots/${liveId}/start`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ confirmLive: true }) }),
        fetch(`${paperBase}/settings`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ liveTradingEnabled: true }) }),
        fetch(`${paperBase}/accounts/${binanceAccountId}/credentials`, { method: "PUT", headers: mutationHeaders, body: JSON.stringify({ apiKey: "abcdefgh", apiSecret: "supersecret" }) }),
        fetch(`${paperBase}/account-telemetry`, { headers: { cookie } }),
        fetch(`${paperBase}/bybit/uta`, { headers: { cookie } })
      ]);
      for (const response of rejected) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "PAPER_ONLY_MODE" });
      }

      const kill = await fetch(`${paperBase}/kill`, { method: "POST", headers: mutationHeaders, body: "{}" });
      expect(kill.status).toBe(200);
      expect(emergencyAdapters).not.toHaveBeenCalled();
    } finally {
      api.engine.shutdown();
      await new Promise<void>((resolve, reject) => paperServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function paperMultiLegPlan(runId: string, fillRatios: readonly [number, number, number, number]): PaperMultiLegPlan {
  const now = Date.now();
  return {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId,
    source: { kind: "n-leg", engine: "n-leg-v1", opportunityId: `opportunity:${runId}`, evaluatedAt: now - 10, provenanceHash: "a".repeat(64) },
    createdAt: now,
    expiresAt: now + 60_000,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: fillRatios.map((paperFillRatioBps, index) => ({
      legId: `leg-${index}`,
      venue: "test",
      instrumentId: `test:spot:ASSET${index}`,
      side: index % 2 === 0 ? "buy" : "sell",
      quantityUnit: "base",
      plannedQuantity: index + 1,
      referencePrice: 100 + index,
      feeBps: 2,
      paperFillRatioBps,
      paperCompensationFillRatioBps: 10_000,
      paperCompensationPrice: 100 + index + 0.5,
      paperCompensationFeeBps: 3,
      evidenceId: `fixture:book:${index}`
    }))
  };
}
