import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    listFills: () => [],
    insertLog: () => {},
    listLogs: () => [],
    getSetting: (k: string) => (settings.has(k) ? clone(settings.get(k)) : undefined),
    setSetting: (k: string, v: unknown) => settings.set(k, clone(v)),
  };
});

let base: string;
let server: Server;

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
  const api = createTradingApi(fakeProvider);
  const app = express();
  app.use(express.json());
  app.use("/api/trade", api.router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/api/trade`;
});

afterAll(() => {
  server?.close();
});

const post = (p: string, b: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const del = (p: string) => fetch(base + p, { method: "DELETE" });
const get = (p: string) => fetch(base + p);

describe("trading API E2E (real router, in-memory store)", () => {
  it("GET /auth reports server + live-arm state", async () => {
    const res = await get("/auth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.liveTradingEnabled).toBe(false);
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
