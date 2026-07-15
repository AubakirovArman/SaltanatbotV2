import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAuthToken } from "../src/auth.js";
import { createTradingApi } from "../src/trading/routes.js";
import { PaperMultiLegJournal, PaperMultiLegService, type PaperMultiLegPlan } from "../src/arbitrage/paperMultiLeg/index.js";

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
  const audit: unknown[] = [];
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
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
    initStore: () => {},
    listBots: () => [...bots.values()].map((b) => clone(b)),
    upsertBot: (b: { id: string }) => bots.set(b.id, clone(b)),
    deleteBot: (id: string) => {
      bots.delete(id);
      settings.delete(`paper:${id}`);
      settings.delete(`state:${id}`);
    },
    deleteSetting: (k: string) => settings.delete(k),
    listTradingAccounts: () => [...accounts.values()].map((account) => clone(account)),
    getTradingAccount: (id: string) => (accounts.has(id) ? clone(accounts.get(id)) : undefined),
    insertTradingAccount: (account: { id: string }) => accounts.set(account.id, clone(account)),
    updateTradingAccount: (account: { id: string }) => {
      if (!accounts.has(account.id)) return false;
      accounts.set(account.id, clone(account));
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
    TradingAccountInUseError,
    insertFill: () => true,
    withStoreTransaction: <T>(operation: () => T) => operation(),
    listFills: () => [],
    upsertOrderJournal: () => {},
    insertOrderEvent: () => {},
    listOrderJournal: () => [],
    listRiskOrderJournal: () => [],
    listExecutionReconciliationJournal: () => [],
    listOrderEvents: () => [],
    insertLog: () => {},
    listLogs: () => [],
    insertAuditLog: (row: unknown) => audit.unshift(clone(row)),
    listAuditLog: (limit: number) => audit.slice(0, limit).map((row) => clone(row)),
    getSetting: (k: string) => (settings.has(k) ? clone(settings.get(k)) : undefined),
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v))
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
const startupRecoveryRunId = "api-startup-recovery-run";

const validBody = (over: Record<string, unknown> = {}) => ({
  name: "E2E",
  ir: { name: "t", inputs: [], body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange: "paper",
  market: "spot",
  sizeMode: "quote",
  sizeValue: 1000,
  maxPositionQuote: 5_000,
  maxOrderQuote: 1_000,
  maxDailyLossQuote: 500,
  maxOpenOrders: 10,
  ...over
});

beforeAll(async () => {
  process.env.AUTH_READONLY_TOKEN = "readonly-test-token";
  process.env.AUTH_PAPER_TRADE_TOKEN = "paper-test-token";
  paperMultiLegJournal = PaperMultiLegJournal.open(":memory:");
  const paperMultiLeg = new PaperMultiLegService(paperMultiLegJournal);
  const interrupted = paperMultiLegPlan(startupRecoveryRunId, [10_000, 5_000, 10_000, 10_000]);
  paperMultiLegJournal.createRun(interrupted, "idem-api-startup-recovery", interrupted.createdAt);
  paperMultiLegJournal.advance(interrupted.runId, interrupted.createdAt + 1);
  paperMultiLegJournal.advance(interrupted.runId, interrupted.createdAt + 2);
  tradingApi = createTradingApi(fakeProvider, undefined, { emergencyAdapters: () => [], paperMultiLeg });
  const app = express();
  app.use(express.json());
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
});

afterAll(() => {
  server?.close();
  paperMultiLegJournal?.close();
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
    expect((await fetch(base + "/accounts", { headers: { cookie: readOnlyCookie } })).status).toBe(403);
  });

  it("exposes honest metadata-only capabilities for additional accounts", async () => {
    const createdResponse = await post("/accounts", { label: "Managed desk", exchange: "bybit", ownership: "managed" });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.account).toMatchObject({
      label: "Managed desk",
      exchange: "bybit",
      ownership: "managed",
      status: "metadata_only",
      credential: { mode: "unsupported", status: "unsupported", isolated: false },
      capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false }
    });

    const unsupportedBot = await post("/bots", validBody({ exchange: "bybit", market: "futures", accountId: created.account.id }));
    expect(unsupportedBot.status).toBe(409);
    expect(await unsupportedBot.json()).toMatchObject({ code: "MULTI_ACCOUNT_CREDENTIALS_UNSUPPORTED" });

    const updated = await patch(`/accounts/${created.account.id}`, { label: "Managed desk paused", enabled: false });
    expect(updated.status).toBe(200);
    expect((await updated.json()).account).toMatchObject({ label: "Managed desk paused", enabled: false, status: "disabled" });

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

    const recovery = await fetch(base + "/paper-multi-leg/recovery", { headers: { cookie: paperCookie } });
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      safety: { executionMode: "paper-only", liveOrders: false, privateRequests: false, credentialsAccepted: false },
      recovery: { status: "ready", recoveredRuns: 1 }
    });
    const recovered = await fetch(`${base}/paper-multi-leg/runs/${startupRecoveryRunId}`, { headers: { cookie: paperCookie } });
    expect(await recovered.json()).toMatchObject({ run: { state: { status: "compensated", lastSequence: 7 } } });

    const plan = paperMultiLegPlan(`api-paper-run-${Date.now()}`, [10_000, 4_000, 10_000, 10_000]);
    const withoutCsrf = await fetch(base + "/paper-multi-leg/runs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: paperCookie, "idempotency-key": `idem-${plan.runId}` },
      body: JSON.stringify({ plan })
    });
    expect(withoutCsrf.status).toBe(403);

    const created = await fetch(base + "/paper-multi-leg/runs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: paperCookie, "x-csrf-token": paperCsrf, "idempotency-key": `idem-${plan.runId}` },
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

  it("creates a paper bot with valid IR and lists it", async () => {
    const res = await post("/bots", validBody());
    expect(res.status).toBe(200);
    const { bot } = await res.json();
    expect(bot.id).toBeTruthy();
    expect(bot.status).toBe("stopped");
    const list = await (await get("/bots")).json();
    expect(list.bots.some((b: { id: string }) => b.id === bot.id)).toBe(true);
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
    expect(created.bot.accountId).toBe("bybit:default");
    const disabled = await patch("/accounts/bybit:default", { enabled: false });
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ code: "TRADING_ACCOUNT_IN_USE", botIds: expect.arrayContaining([created.bot.id]) });
    const response = await del("/accounts/bybit:default");
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
    const res = await post("/keys", { exchange: "binance", apiKey: "abcdefgh", apiSecret: "supersecret" });
    expect(res.status).toBe(200);
    const audit = await (await get("/audit?limit=20")).json();
    const event = audit.events.find((item: { action: string }) => item.action.includes("/keys"));
    expect(event).toBeTruthy();
    expect(event.role).toBe("admin");
    expect(event.data.body.apiKey).toBe("[redacted]");
    expect(event.data.body.apiSecret).toBe("[redacted]");
    const accounts = await (await get("/accounts")).json();
    expect(accounts.accounts.find((account: { id: string }) => account.id === "binance:default")).toMatchObject({
      status: "ready",
      credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false },
      capabilities: { liveExecution: true, credentialIsolation: false, multipleCredentialAccounts: false }
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
