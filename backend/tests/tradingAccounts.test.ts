import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { describeTradingAccount, legacyTradingAccountId, tradingAccountBindingIssue, withResolvedBotAccountId } from "../src/trading/tradingAccounts.js";
import {
  configureTradingAccountStore,
  credentialAad,
  deleteTradingAccountCredentialsForOwner,
  deleteTradingAccountFrom,
  deleteTradingAccountFromForOwner,
  getTradingAccountAuthorizationStateFromForOwner,
  getTradingAccountCredentialsForOwner,
  getTradingAccountFrom,
  getTradingAccountFromForOwner,
  getTradingOwnerAuthorityFromForOwner,
  insertTradingAccountInto,
  insertTradingAccountIntoForOwner,
  listTradingAccountsFrom,
  listTradingAccountsFromForOwner,
  setTradingAccountCredentialsForOwner,
  setTradingOwnerArmedInForOwner,
  TradingAccountInUseError,
  upsertBotIntoForOwner,
  updateTradingAccountIn,
  updateTradingAccountInForOwner
} from "../src/trading/store.js";
import { openCredentialPayload, sealCredentialPayload } from "../src/trading/credentialCrypto.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { buildPortfolioSummary } from "../src/trading/enginePortfolio.js";
import type { RunningBot } from "../src/trading/engineRuntime.js";
import type { BotConfig, ExchangeAdapter, PendingOrder, PositionState, TradingAccount } from "../src/trading/types.js";
import { TradingResourceQuotaError } from "../src/trading/resourceQuotas.js";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";

const databases: DatabaseSync[] = [];
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const FUTURE_LIVE_POLICY = runtimePolicyFromConfig({ runtimeProfile: "private-live" });

function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateTradingStore(db, () => 1);
  return db;
}

function account(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    id: "metadata-account",
    ownerUserId: OWNER_A,
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
  it("enforces owner-local account and bot creation quotas without hiding existing rows", () => {
    const db = database();
    const firstAccount = account({ id: "account-a-1" });
    insertTradingAccountIntoForOwner(db, OWNER_A, firstAccount, 1);

    expect(() => insertTradingAccountIntoForOwner(db, OWNER_A, account({ id: "account-a-2" }), 1)).toThrow(TradingResourceQuotaError);
    expect(() => insertTradingAccountIntoForOwner(db, OWNER_B, account({ id: "account-b-1", ownerUserId: OWNER_B }), 1)).not.toThrow();
    expect(listTradingAccountsFromForOwner(db, OWNER_A)).toEqual([firstAccount]);

    const firstBot = bot({ id: "bot-a-1", ownerUserId: OWNER_A, exchange: "paper" });
    upsertBotIntoForOwner(db, OWNER_A, firstBot, { maxBots: 1 });
    expect(() =>
      upsertBotIntoForOwner(db, OWNER_A, bot({ id: "bot-a-2", ownerUserId: OWNER_A, exchange: "paper" }), {
        maxBots: 1
      })
    ).toThrow(TradingResourceQuotaError);

    expect(() => upsertBotIntoForOwner(db, OWNER_A, { ...firstBot, name: "Still editable", updatedAt: 2 }, { maxBots: 1 })).not.toThrow();
  });

  it("persists and updates non-secret account metadata", () => {
    const db = database();
    const initial = account();
    insertTradingAccountInto(db, initial);

    expect(getTradingAccountFrom(db, initial.id)).toEqual(initial);
    expect(listTradingAccountsFrom(db)).toEqual([initial]);

    const updated = { ...initial, label: "Desk paused", enabled: false, updatedAt: 20 };
    expect(updateTradingAccountIn(db, updated)).toBe(true);
    expect(getTradingAccountFrom(db, initial.id)).toEqual(updated);
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)).toMatchObject({
      authorizationRevision: 2,
      credentialRevision: 0,
      credentialsConfigured: false
    });
  });

  it("keeps monotonic account, credential and owner-arm revisions", () => {
    const db = database();
    const key = Buffer.alloc(32, 13);
    configureTradingAccountStore(db, {
      seal: (plain, aad) => sealCredentialPayload(key, plain, aad),
      open: (payload, aad) => openCredentialPayload(key, payload, aad)
    });
    const initial = account({ id: "revision-account" });
    insertTradingAccountIntoForOwner(db, OWNER_A, initial);

    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)).toMatchObject({
      enabled: true,
      authorizationRevision: 1,
      credentialRevision: 0,
      credentialsConfigured: false
    });
    expect(getTradingOwnerAuthorityFromForOwner(db, OWNER_A)).toMatchObject({ armed: false, epoch: 1 });

    expect(setTradingOwnerArmedInForOwner(db, OWNER_A, true, 20)).toMatchObject({ armed: true, epoch: 2 });
    expect(setTradingOwnerArmedInForOwner(db, OWNER_A, false, 21)).toMatchObject({ armed: false, epoch: 3 });
    expect(setTradingOwnerArmedInForOwner(db, OWNER_A, false, 22)).toMatchObject({ armed: false, epoch: 4 });
    expect(getTradingOwnerAuthorityFromForOwner(db, OWNER_B)).toMatchObject({ armed: false, epoch: 0 });

    setTradingAccountCredentialsForOwner(OWNER_A, initial.id, { apiKey: "one", apiSecret: "secret-one" }, FUTURE_LIVE_POLICY);
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)).toMatchObject({
      authorizationRevision: 1,
      credentialRevision: 1,
      credentialsConfigured: true
    });
    setTradingAccountCredentialsForOwner(OWNER_A, initial.id, { apiKey: "two", apiSecret: "secret-two" }, FUTURE_LIVE_POLICY);
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)?.credentialRevision).toBe(2);
    expect(deleteTradingAccountCredentialsForOwner(OWNER_A, initial.id)).toBe(true);
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)).toMatchObject({
      credentialRevision: 3,
      credentialsConfigured: false
    });
    expect(deleteTradingAccountCredentialsForOwner(OWNER_A, initial.id)).toBe(false);
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)?.credentialRevision).toBe(3);
  });

  it("rolls back credential writes and revisions together", () => {
    const db = database();
    const initial = account({ id: "rollback-account" });
    insertTradingAccountIntoForOwner(db, OWNER_A, initial);
    configureTradingAccountStore(db, {
      seal: () => {
        throw new Error("seal unavailable");
      },
      open: () => {
        throw new Error("not used");
      }
    });

    expect(() => setTradingAccountCredentialsForOwner(OWNER_A, initial.id, { apiKey: "not-written" }, FUTURE_LIVE_POLICY)).toThrow("seal unavailable");
    expect(getTradingAccountAuthorizationStateFromForOwner(db, OWNER_A, initial.id)).toMatchObject({
      credentialRevision: 0,
      credentialsConfigured: false
    });
  });

  it("keeps account deletion atomic and rejects legacy bot bindings", () => {
    const db = database();
    const legacy = account({ id: "bybit:default", ownership: "own" });
    insertTradingAccountInto(db, legacy);
    db.prepare("INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)").run("legacy-bot", OWNER_A, JSON.stringify(bot({ id: "legacy-bot", accountId: undefined })), 1);

    expect(() => deleteTradingAccountFrom(db, legacy.id)).toThrow(TradingAccountInUseError);
    expect(getTradingAccountFrom(db, legacy.id)).toEqual(legacy);

    db.prepare("DELETE FROM bots WHERE id = ?").run("legacy-bot");
    expect(deleteTradingAccountFrom(db, legacy.id)).toBe(true);
    expect(getTradingAccountFrom(db, legacy.id)).toBeUndefined();
  });

  it("scopes every account read and mutation to its explicit owner", () => {
    const db = database();
    const initial = account();
    insertTradingAccountIntoForOwner(db, OWNER_A, initial);

    expect(getTradingAccountFromForOwner(db, OWNER_A, initial.id)).toEqual(initial);
    expect(getTradingAccountFromForOwner(db, OWNER_B, initial.id)).toBeUndefined();
    expect(listTradingAccountsFromForOwner(db, OWNER_B)).toEqual([]);
    expect(updateTradingAccountInForOwner(db, OWNER_B, { ...initial, label: "stolen" })).toBe(false);
    expect(deleteTradingAccountFromForOwner(db, OWNER_B, initial.id)).toBe(false);
    expect(getTradingAccountFromForOwner(db, OWNER_A, initial.id)?.label).toBe("Desk");
    db.prepare(`
      INSERT INTO trading_account_credentials (ownerUserId, accountId, encryptedValue, updatedAt)
      VALUES (?, ?, 'opaque-aead', 1)
    `).run(OWNER_A, initial.id);
    expect(deleteTradingAccountFromForOwner(db, OWNER_A, initial.id)).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM trading_account_credentials").get()).toEqual({ count: 0 });
  });

  it("binds encrypted credentials to owner, account and exchange AAD", () => {
    const key = Buffer.alloc(32, 7);
    const aad = credentialAad(OWNER_A, "account-a", "bybit");
    const payload = sealCredentialPayload(key, JSON.stringify({ apiKey: "key", apiSecret: "secret" }), aad);

    expect(JSON.parse(openCredentialPayload(key, payload, aad))).toEqual({ apiKey: "key", apiSecret: "secret" });
    expect(() => openCredentialPayload(key, payload, credentialAad(OWNER_B, "account-a", "bybit"))).toThrow();
    expect(() => openCredentialPayload(key, payload, credentialAad(OWNER_A, "account-b", "bybit"))).toThrow();
    expect(() => openCredentialPayload(key, payload, credentialAad(OWNER_A, "account-a", "binance"))).toThrow();
  });

  it("persists encrypted credentials behind owner-scoped account access", () => {
    const db = database();
    const key = Buffer.alloc(32, 9);
    configureTradingAccountStore(db, {
      seal: (plain, aad) => sealCredentialPayload(key, plain, aad),
      open: (payload, aad) => openCredentialPayload(key, payload, aad)
    });
    const accountA = account({ id: "account-a", ownerUserId: OWNER_A });
    const accountB = account({ id: "account-b", ownerUserId: OWNER_B });
    insertTradingAccountIntoForOwner(db, OWNER_A, accountA);
    insertTradingAccountIntoForOwner(db, OWNER_B, accountB);

    setTradingAccountCredentialsForOwner(OWNER_A, accountA.id, { apiKey: "public-a", apiSecret: "secret-a" }, FUTURE_LIVE_POLICY);

    expect(getTradingAccountCredentialsForOwner(OWNER_A, accountA.id, FUTURE_LIVE_POLICY)).toEqual({
      apiKey: "public-a",
      apiSecret: "secret-a"
    });
    expect(getTradingAccountCredentialsForOwner(OWNER_B, accountA.id, FUTURE_LIVE_POLICY)).toBeUndefined();
    expect(() => setTradingAccountCredentialsForOwner(OWNER_B, accountA.id, { apiKey: "stolen" }, FUTURE_LIVE_POLICY)).toThrow("does not belong to owner");
    expect(deleteTradingAccountCredentialsForOwner(OWNER_B, accountA.id)).toBe(false);
    const stored = db
      .prepare(`
      SELECT encryptedValue FROM trading_account_credentials
      WHERE ownerUserId = ? AND accountId = ?
    `)
      .get(OWNER_A, accountA.id) as { encryptedValue: string };
    expect(stored.encryptedValue).not.toContain("secret-a");
    expect(deleteTradingAccountCredentialsForOwner(OWNER_A, accountA.id)).toBe(true);
    expect(getTradingAccountCredentialsForOwner(OWNER_A, accountA.id, FUTURE_LIVE_POLICY)).toBeUndefined();
  });

  it("maps legacy bot configs to deterministic account ids", () => {
    expect(withResolvedBotAccountId(bot({ accountId: undefined })).accountId).toBe("bybit:default");
    expect(withResolvedBotAccountId(bot({ exchange: "paper", accountId: undefined })).accountId).toBe("paper:bot");
  });

  it("reports account-isolated credential capabilities", () => {
    const metadata = account();
    expect(describeTradingAccount(metadata, true)).toMatchObject({
      status: "ready",
      credential: { mode: "account_isolated", status: "configured", isolated: true },
      capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true }
    });
    expect(tradingAccountBindingIssue(bot({ accountId: metadata.id }), metadata)).toBeUndefined();

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
        async price() {
          return 100;
        },
        async account() {
          accountCalls.push(accountId);
          return { balance, equity: balance, currency: "USDT" };
        },
        async position() {
          return null;
        },
        async execute() {
          return { ok: true, message: "ok", fills: [] };
        }
      };
      return { config: bot({ id, accountId }), adapter } as unknown as RunningBot;
    };

    const summary = await buildPortfolioSummary([running("a-1", "account-a", 100), running("a-2", "account-a", 100), running("b-1", "account-b", 200)], () => 0);

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
      async price() {
        return 100;
      },
      async account() {
        return { balance: 1_000, equity: 1_050, currency: "USDT" };
      },
      async position() {
        throw new Error("symbol fallback must not run");
      },
      async positions() {
        positionsCalls += 1;
        return positions;
      },
      async orders(symbol) {
        ordersCalls += 1;
        if (symbol) throw new Error("symbol fallback must not run");
        return orders;
      },
      async execute() {
        return { ok: true, message: "ok", fills: [] };
      }
    };

    const summary = await buildPortfolioSummary([{ config: bot({ id: "btc-bot", accountId: "bybit:default", symbol: "BTCUSDT" }), adapter } as unknown as RunningBot], () => 0);

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
      async price() {
        return 100;
      },
      async account() {
        return { balance: 500, equity: 500, currency: "USDT" };
      },
      async position() {
        throw new Error("position unavailable");
      },
      async positions() {
        throw new Error("positions unavailable");
      },
      async orders() {
        throw new Error("orders unavailable");
      },
      async execute() {
        return { ok: true, message: "ok", fills: [] };
      }
    };

    const summary = await buildPortfolioSummary([{ config: bot({ id: "unavailable", exchange: "binance", accountId: "binance:default" }), adapter } as unknown as RunningBot], () => 0);

    expect(summary.exchanges[0]).toMatchObject({
      positions: [],
      positionsCoverage: "unavailable",
      openOrders: [],
      openOrdersCoverage: "unavailable"
    });
  });
});
