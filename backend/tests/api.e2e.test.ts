import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAuthToken } from "../src/auth.js";
import { createTradingApi } from "../src/trading/routes.js";

// The HTTP tests never start a bot, so a no-op provider is enough — and it avoids
// pulling the real provider layer (and its native node:sqlite candle store).
const fakeProvider = {
  name: "fake",
  async getCandles() {
    return [];
  },
  async subscribe() {
    return { close() {} };
  },
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
  const audit: unknown[] = [];
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
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
    insertFill: () => {},
    withStoreTransaction: <T>(operation: () => T) => operation(),
    listFills: () => [],
    upsertOrderJournal: () => {},
    insertOrderEvent: () => {},
    listOrderJournal: () => [],
    listOrderEvents: () => [],
    insertLog: () => {},
    listLogs: () => [],
    insertAuditLog: (row: unknown) => audit.unshift(clone(row)),
    listAuditLog: (limit: number) => audit.slice(0, limit).map((row) => clone(row)),
    getSetting: (k: string) => (settings.has(k) ? clone(settings.get(k)) : undefined),
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v)),
  };
});

let base: string;
let server: Server;
let sessionCookie: string;
let csrfToken: string;
let readOnlyCookie: string;
let readOnlyCsrf: string;
let paperCookie: string;
let paperCsrf: string;

const validBody = (over: Record<string, unknown> = {}) => ({
  name: "E2E",
  ir: { name: "t", inputs: [], body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange: "paper",
  market: "spot",
  sizeMode: "quote",
  sizeValue: 1000,
  ...over,
});

beforeAll(async () => {
  process.env.AUTH_READONLY_TOKEN = "readonly-test-token";
  process.env.AUTH_PAPER_TRADE_TOKEN = "paper-test-token";
  const api = createTradingApi(fakeProvider);
  const app = express();
  app.use(express.json());
  app.use("/api/trade", api.router);
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
});

const authHeaders = (unsafe = false) => ({
  cookie: sessionCookie,
  ...(unsafe ? { "x-csrf-token": csrfToken } : {}),
});
const post = (p: string, b: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(true) }, body: JSON.stringify(b) });
const del = (p: string) => fetch(base + p, { method: "DELETE", headers: authHeaders(true) });
const get = (p: string) => fetch(base + p, { headers: authHeaders() });

async function loginAs(token: string): Promise<{ cookie: string; csrf: string; role: string }> {
  const login = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
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
    expect((await fetch(base + "/settings", { method: "POST", headers: { "content-type": "application/json", cookie: sessionCookie }, body: JSON.stringify({ liveTradingEnabled: true }) })).status).toBe(403);
  });

  it("GET /auth reports server + live-arm state", async () => {
    const res = await get("/auth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.liveTradingEnabled).toBe(false);
    expect(body.role).toBe("admin");
  });

  it("enforces session roles for mutating endpoints", async () => {
    const readOnlyRes = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: readOnlyCookie, "x-csrf-token": readOnlyCsrf },
      body: JSON.stringify(validBody()),
    });
    expect(readOnlyRes.status).toBe(403);

    const paperLiveRes = await fetch(base + "/bots", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: paperCookie, "x-csrf-token": paperCsrf },
      body: JSON.stringify(validBody({ exchange: "binance", market: "futures" })),
    });
    expect(paperLiveRes.status).toBe(403);

    const readOnlyUta = await fetch(base + "/bybit/uta", { headers: { cookie: readOnlyCookie } });
    expect(readOnlyUta.status).toBe(403);
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
    const res = await post(
      "/bots",
      validBody({ ir: { name: "x", inputs: [], body: [{ k: "exit", when: { k: "bool", v: true }, sneaky: 1 }] } })
    );
    expect(res.status).toBe(400);
  });

  it("rejects IR stamped with a future schema version", async () => {
    const res = await post(
      "/bots",
      validBody({ ir: { name: "x", inputs: [], body: [{ k: "exit", when: { k: "bool", v: true } }], v: 999 } })
    );
    expect(res.status).toBe(400);
  });

  it("gates a live bot start behind the arm flag (403, no network)", async () => {
    const created = await (await post("/bots", validBody({ exchange: "binance", market: "futures" }))).json();
    const res = await post(`/bots/${created.bot.id}/start`, {});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not armed/i);
  });

  it("rejects live spot start until the inventory model is explicitly enabled", async () => {
    expect((await post("/settings", { liveTradingEnabled: true })).status).toBe(200);
    const created = await (await post("/bots", validBody({ exchange: "binance", market: "spot" }))).json();
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
  });

  it("deletes a bot", async () => {
    const created = await (await post("/bots", validBody())).json();
    const res = await del(`/bots/${created.bot.id}`);
    expect(res.status).toBe(200);
    const list = await (await get("/bots")).json();
    expect(list.bots.some((b: { id: string }) => b.id === created.bot.id)).toBe(false);
  });

  it("kill switch responds ok", async () => {
    expect((await (await post("/kill", {})).json()).ok).toBe(true);
  });

  it("delivers a price alert through the notify channel", async () => {
    expect((await post("/notify-alert", { symbol: "BTCUSDT", price: 65000, direction: "above", hitPrice: 65010 })).status).toBe(200);
    expect((await post("/notify-alert", { symbol: "", price: "x", direction: "sideways" })).status).toBe(400);
  });
});
