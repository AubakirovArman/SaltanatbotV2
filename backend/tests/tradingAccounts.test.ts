import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeTradingAccount,
  legacyTradingAccountId,
  tradingAccountBindingIssue,
  withResolvedBotAccountId
} from "../src/trading/tradingAccounts.js";
import {
  deleteTradingAccountFrom,
  getTradingAccountFrom,
  insertTradingAccountInto,
  listTradingAccountsFrom,
  TradingAccountInUseError,
  updateTradingAccountIn
} from "../src/trading/store.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { buildPortfolioSummary } from "../src/trading/enginePortfolio.js";
import type { RunningBot } from "../src/trading/engineRuntime.js";
import type { BotConfig, ExchangeAdapter, PendingOrder, PositionState, TradingAccount } from "../src/trading/types.js";

const databases: DatabaseSync[] = [];

function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateTradingStore(db, () => 1);
  return db;
}

function account(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    id: "metadata-account",
    label: "Desk",
    exchange: "bybit",
    ownership: "managed",
    enabled: true,
    createdAt: 10,
    updatedAt: 10,
    ...overrides
  };
}

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "bot",
    name: "Bot",
    strategyName: "Strategy",
    ir: { version: 1, nodes: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "bybit",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("trading account registry", () => {
  it("persists and updates non-secret account metadata", () => {
    const db = database();
    const initial = account();
    insertTradingAccountInto(db, initial);

    expect(getTradingAccountFrom(db, initial.id)).toEqual(initial);
    expect(listTradingAccountsFrom(db)).toEqual([initial]);

    const updated = { ...initial, label: "Desk paused", enabled: false, updatedAt: 20 };
    expect(updateTradingAccountIn(db, updated)).toBe(true);
    expect(getTradingAccountFrom(db, initial.id)).toEqual(updated);
  });

  it("keeps account deletion atomic and rejects legacy bot bindings", () => {
    const db = database();
    const legacy = account({ id: "bybit:default", ownership: "own" });
    insertTradingAccountInto(db, legacy);
    db.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?)").run(
      "legacy-bot",
      JSON.stringify(bot({ id: "legacy-bot", accountId: undefined })),
      1
    );

    expect(() => deleteTradingAccountFrom(db, legacy.id)).toThrow(TradingAccountInUseError);
    expect(getTradingAccountFrom(db, legacy.id)).toEqual(legacy);

    db.prepare("DELETE FROM bots WHERE id = ?").run("legacy-bot");
    expect(deleteTradingAccountFrom(db, legacy.id)).toBe(true);
    expect(getTradingAccountFrom(db, legacy.id)).toBeUndefined();
  });

  it("maps legacy bot configs to deterministic account ids", () => {
    expect(withResolvedBotAccountId(bot({ accountId: undefined })).accountId).toBe("bybit:default");
    expect(withResolvedBotAccountId(bot({ exchange: "paper", accountId: undefined })).accountId).toBe("paper:bot");
  });

  it("reports credential truth and rejects metadata-only execution", () => {
    const metadata = account();
    expect(describeTradingAccount(metadata, true)).toMatchObject({
      status: "metadata_only",
      credential: { mode: "unsupported", status: "unsupported", isolated: false },
      capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false }
    });
    expect(tradingAccountBindingIssue(bot({ accountId: metadata.id }), metadata)?.code).toBe("MULTI_ACCOUNT_CREDENTIALS_UNSUPPORTED");

    const legacy = account({ id: legacyTradingAccountId("bybit"), ownership: "own" });
    expect(describeTradingAccount(legacy, false)).toMatchObject({ status: "credentials_missing", credential: { status: "missing" } });
    expect(describeTradingAccount(legacy, true)).toMatchObject({ status: "ready", capabilities: { liveExecution: true } });
    expect(tradingAccountBindingIssue(bot({ accountId: legacy.id }), legacy)).toBeUndefined();
  });

  it("deduplicates portfolio reads by account and market, not only exchange", async () => {
    const accountCalls: string[] = [];
    const running = (id: string, accountId: string, balance: number): RunningBot => {
      const adapter: ExchangeAdapter = {
        id: "bybit",
        market: "futures",
        accountId,
        async price() { return 100; },
        async account() {
          accountCalls.push(accountId);
          return { balance, equity: balance, currency: "USDT" };
        },
        async position() { return null; },
        async execute() { return { ok: true, message: "ok", fills: [] }; }
      };
      return { config: bot({ id, accountId }), adapter } as unknown as RunningBot;
    };

    const summary = await buildPortfolioSummary(
      [running("a-1", "account-a", 100), running("a-2", "account-a", 100), running("b-1", "account-b", 200)],
      () => 0
    );

    expect(summary.exchanges.map((entry) => entry.id).sort()).toEqual(["account-a:futures", "account-b:futures"]);
    expect(summary.exchanges.map((entry) => entry.accountId).sort()).toEqual(["account-a", "account-b"]);
    expect(accountCalls.sort()).toEqual(["account-a", "account-b"]);
  });

  it("uses one account-wide enumeration and keeps off-bot symbols plus both hedge legs", async () => {
    const positions: PositionState[] = [
      { symbol: "ETHUSDT", side: "long", qty: 2, entryPrice: 3_000, leverage: 2, openedAt: 1 },
      { symbol: "BTCUSDT", side: "long", qty: 0.2, entryPrice: 60_000, leverage: 3, hedged: true, positionIndex: 1, openedAt: 2 },
      { symbol: "BTCUSDT", side: "short", qty: 0.1, entryPrice: 62_000, leverage: 3, hedged: true, positionIndex: 2, openedAt: 3 }
    ];
    const orders: PendingOrder[] = [{ id: "eth-order", symbol: "ETHUSDT", side: "sell", type: "limit", qty: 1, price: 3_200, reduceOnly: false, tif: "GTC", createdAt: 4 }];
    let positionsCalls = 0;
    let ordersCalls = 0;
    const adapter: ExchangeAdapter = {
      id: "bybit",
      market: "futures",
      accountId: "bybit:default",
      async price() { return 100; },
      async account() { return { balance: 1_000, equity: 1_050, currency: "USDT" }; },
      async position() { throw new Error("symbol fallback must not run"); },
      async positions() { positionsCalls += 1; return positions; },
      async orders(symbol) { ordersCalls += 1; if (symbol) throw new Error("symbol fallback must not run"); return orders; },
      async execute() { return { ok: true, message: "ok", fills: [] }; }
    };

    const summary = await buildPortfolioSummary(
      [{ config: bot({ id: "btc-bot", accountId: "bybit:default", symbol: "BTCUSDT" }), adapter } as unknown as RunningBot],
      () => 0
    );

    expect(positionsCalls).toBe(1);
    expect(ordersCalls).toBe(1);
    expect(summary.exchanges[0]).toMatchObject({
      positions,
      positionsCoverage: "account-wide",
      openOrders: orders,
      openOrdersCoverage: "account-wide"
    });
  });

  it("does not present failed account enumeration as trustworthy zeroes", async () => {
    const adapter: ExchangeAdapter = {
      id: "binance",
      market: "futures",
      accountId: "binance:default",
      async price() { return 100; },
      async account() { return { balance: 500, equity: 500, currency: "USDT" }; },
      async position() { throw new Error("position unavailable"); },
      async positions() { throw new Error("positions unavailable"); },
      async orders() { throw new Error("orders unavailable"); },
      async execute() { return { ok: true, message: "ok", fills: [] }; }
    };

    const summary = await buildPortfolioSummary(
      [{ config: bot({ id: "unavailable", exchange: "binance", accountId: "binance:default" }), adapter } as unknown as RunningBot],
      () => 0
    );

    expect(summary.exchanges[0]).toMatchObject({
      positions: [],
      positionsCoverage: "unavailable",
      openOrders: [],
      openOrdersCoverage: "unavailable"
    });
  });
});
