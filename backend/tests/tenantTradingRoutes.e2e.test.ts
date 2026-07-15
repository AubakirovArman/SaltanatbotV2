import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureIdentityAuth } from "../src/auth.js";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityService } from "../src/identity/service.js";
import type { IdentityPrincipal, SessionCredentials } from "../src/identity/types.js";
import { createTradingApi } from "../src/trading/routes.js";

const storeState = vi.hoisted(() => ({
  bots: new Map<string, unknown>(),
  accounts: new Map<string, unknown>(),
  credentials: new Map<string, unknown>(),
  fills: new Map<string, unknown[]>(),
  logs: new Map<string, unknown[]>(),
  orders: new Map<string, unknown[]>(),
  orderEvents: new Map<string, unknown[]>(),
  audit: [] as unknown[],
  settings: new Map<string, unknown>()
}));

vi.mock("../src/trading/store.js", () => {
  const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
  const ownerOf = (value: unknown) => (value as { ownerUserId?: string } | undefined)?.ownerUserId;
  const ownedBot = (ownerUserId: string, botId: string) => {
    const bot = storeState.bots.get(botId);
    return bot && ownerOf(bot) === ownerUserId ? clone(bot) : undefined;
  };
  const ownedAccount = (ownerUserId: string, accountId: string) => {
    const account = storeState.accounts.get(accountId);
    return account && ownerOf(account) === ownerUserId ? clone(account) : undefined;
  };

  class TradingAccountInUseError extends Error {
    constructor(readonly accountId: string, readonly botIds: readonly string[]) {
      super(`Trading account ${accountId} is used by ${botIds.length} bot(s).`);
    }
  }

  return {
    LEGACY_TRADING_OWNER_ID: "legacy-owner",
    TradingAccountInUseError,
    initStore: () => undefined,
    listBots: () => [...storeState.bots.values()].map(clone),
    listBotsForOwner: (ownerUserId: string) => [...storeState.bots.values()].filter((bot) => ownerOf(bot) === ownerUserId).map(clone),
    getBotForOwner: ownedBot,
    getBotOwnerUserId: (botId: string) => ownerOf(storeState.bots.get(botId)),
    upsertBotForOwner: (ownerUserId: string, bot: { id: string }) => storeState.bots.set(bot.id, clone({ ...bot, ownerUserId })),
    deleteBotForOwner: (ownerUserId: string, botId: string) => {
      if (!ownedBot(ownerUserId, botId)) return false;
      return storeState.bots.delete(botId);
    },
    listTradingAccountsForOwner: (ownerUserId: string) => [...storeState.accounts.values()].filter((account) => ownerOf(account) === ownerUserId).map(clone),
    getTradingAccountForOwner: ownedAccount,
    insertTradingAccountForOwner: (ownerUserId: string, account: { id: string }) => storeState.accounts.set(account.id, clone({ ...account, ownerUserId })),
    updateTradingAccountForOwner: (ownerUserId: string, account: { id: string }) => {
      if (!ownedAccount(ownerUserId, account.id)) return false;
      storeState.accounts.set(account.id, clone({ ...account, ownerUserId }));
      return true;
    },
    deleteTradingAccountForOwner: (ownerUserId: string, accountId: string) => {
      if (!ownedAccount(ownerUserId, accountId)) return false;
      return storeState.accounts.delete(accountId);
    },
    getTradingAccountCredentialsForOwner: (ownerUserId: string, accountId: string) => clone(storeState.credentials.get(`${ownerUserId}:${accountId}`)),
    setTradingAccountCredentialsForOwner: (ownerUserId: string, accountId: string, value: unknown) => storeState.credentials.set(`${ownerUserId}:${accountId}`, clone(value)),
    deleteTradingAccountCredentialsForOwner: (ownerUserId: string, accountId: string) => storeState.credentials.delete(`${ownerUserId}:${accountId}`),
    listFillsForOwner: (ownerUserId: string, botId: string) => ownedBot(ownerUserId, botId) ? clone(storeState.fills.get(botId) ?? []) : [],
    listLogsForOwner: (ownerUserId: string, botId: string) => ownedBot(ownerUserId, botId) ? clone(storeState.logs.get(botId) ?? []) : [],
    listOrderJournalForOwner: (ownerUserId: string, botId: string) => ownedBot(ownerUserId, botId) ? clone(storeState.orders.get(botId) ?? []) : [],
    listOrderEventsForOwner: (ownerUserId: string, botId: string, orderId: string) => {
      if (!ownedBot(ownerUserId, botId)) return [];
      return clone((storeState.orderEvents.get(orderId) ?? []).filter((event) => (event as { botId?: string }).botId === botId));
    },
    insertAuditLogForOwner: (ownerUserId: string, row: unknown) => storeState.audit.unshift(clone({ ...(row as object), ownerUserId })),
    listAuditLogForOwner: (ownerUserId: string, limit: number) => storeState.audit.filter((row) => ownerOf(row) === ownerUserId).slice(0, limit).map(clone),
    getSetting: (key: string) => clone(storeState.settings.get(key)),
    setSetting: (key: string, value: unknown) => storeState.settings.set(key, clone(value)),
    deleteSetting: (key: string) => storeState.settings.delete(key),
    insertFill: () => true,
    listFills: () => [],
    insertLog: () => undefined,
    listLogs: () => [],
    upsertOrderJournal: () => undefined,
    getOrderJournal: () => undefined,
    insertOrderEvent: () => undefined,
    listOrderJournal: () => [],
    listRiskOrderJournal: () => [],
    listExecutionReconciliationJournal: () => [],
    listOrderEvents: () => [],
    appendPaperLedgerEvents: () => 0,
    listPaperLedgerEvents: () => [],
    upsertPositionSnapshot: () => undefined,
    withStoreTransaction: <T>(operation: () => T) => operation()
  };
});

const provider = {
  name: "tenant-isolation-test",
  async getCandles() { return []; },
  async subscribe() { return { close() {} }; }
} as never;

interface AuthContext {
  userId: string;
  cookie: string;
  csrf: string;
}

let server: Server;
let baseUrl: string;
let identity: IdentityService;
let trading: ReturnType<typeof createTradingApi>;
let adminAuth: AuthContext;
let traderAuth: AuthContext;
let adminPrincipal: IdentityPrincipal;
let previousAuthMode: string | undefined;

function bot(ownerUserId: string, id: string) {
  const now = Date.now();
  return {
    id,
    ownerUserId,
    accountId: `paper:${id}`,
    name: id,
    strategyName: "tenant-test",
    ir: { name: "tenant-test", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "spot",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: now,
    updatedAt: now
  };
}

function account(ownerUserId: string, id: string) {
  const now = Date.now();
  return { id, ownerUserId, label: id, exchange: "binance", ownership: "own", enabled: true, createdAt: now, updatedAt: now };
}

function authContext(userId: string, credentials: SessionCredentials): AuthContext {
  return {
    userId,
    cookie: `sbv2_session=${encodeURIComponent(credentials.sessionToken)}`,
    csrf: credentials.csrfToken
  };
}

function headers(auth: AuthContext, mutation = false): Record<string, string> {
  return {
    cookie: auth.cookie,
    ...(mutation ? { "content-type": "application/json", "x-csrf-token": auth.csrf } : {})
  };
}

beforeAll(async () => {
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "database";
  identity = new IdentityService(new MemoryIdentityRepository(), { allowNonAdminTrading: true });
  configureIdentityAuth(identity);

  const admin = await identity.bootstrapAdmin("isolation-admin", "temporary-Admin-password-2026");
  await identity.repository.updateUser(admin.id, { mustChangePassword: false, updatedAt: new Date() });
  const trader = await identity.register("isolation-trader", "correct-horse-battery-staple");
  const adminCredentials = await identity.login(admin.login, "temporary-Admin-password-2026");
  adminPrincipal = (await identity.authenticate(adminCredentials.sessionToken))!;
  await identity.activateUser(adminPrincipal, trader.id);
  await identity.updatePermissions(adminPrincipal, trader.id, { tradingRole: "live-trade" });
  const freshAdminCredentials = await identity.login(admin.login, "temporary-Admin-password-2026");
  const traderCredentials = await identity.login(trader.login, "correct-horse-battery-staple");
  adminAuth = authContext(admin.id, freshAdminCredentials);
  traderAuth = authContext(trader.id, traderCredentials);

  storeState.bots.set("admin-bot", bot(admin.id, "admin-bot"));
  storeState.bots.set("trader-bot", bot(trader.id, "trader-bot"));
  storeState.accounts.set("admin-account", account(admin.id, "admin-account"));
  storeState.accounts.set("trader-account", account(trader.id, "trader-account"));
  storeState.credentials.set(`${trader.id}:trader-account`, { apiKey: "trader-api-key", apiSecret: "trader-api-secret" });
  storeState.audit.push(
    { id: "audit-admin", ownerUserId: admin.id, actorUserId: admin.id, actor: admin.id, role: "admin", action: "admin-own", statusCode: 200, ts: 2 },
    { id: "audit-trader", ownerUserId: trader.id, actorUserId: trader.id, actor: trader.id, role: "live-trade", action: "trader-own", statusCode: 200, ts: 1 }
  );
  storeState.orders.set("trader-bot", [{ id: "trader-order", botId: "trader-bot" }]);
  storeState.orderEvents.set("trader-order", [{ id: "trader-event", orderId: "trader-order", botId: "trader-bot", type: "result", data: {}, ts: 1 }]);

  trading = createTradingApi(provider, undefined, { paperMultiLeg: false });
  const app = express();
  app.use(express.json());
  app.use("/api/trade", trading.router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api/trade`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  configureIdentityAuth(undefined);
  if (previousAuthMode === undefined) Reflect.deleteProperty(process.env, "AUTH_MODE");
  else process.env.AUTH_MODE = previousAuthMode;
});

describe("database-auth trading tenant boundary", () => {
  it("never lets an admin role bypass resource ownership", async () => {
    const botsResponse = await fetch(`${baseUrl}/bots`, { headers: headers(adminAuth) });
    expect(botsResponse.status).toBe(200);
    const botBody = await botsResponse.json() as { bots: Array<{ id: string; ownerUserId?: string }> };
    expect(botBody.bots.map((item) => item.id)).toEqual(["admin-bot"]);
    expect(botBody.bots[0]).not.toHaveProperty("ownerUserId");

    expect((await fetch(`${baseUrl}/bots/trader-bot/fills`, { headers: headers(adminAuth) })).status).toBe(404);
    expect((await fetch(`${baseUrl}/bots/trader-bot/logs`, { headers: headers(adminAuth) })).status).toBe(404);
    expect((await fetch(`${baseUrl}/bots/trader-bot/order-journal`, { headers: headers(adminAuth) })).status).toBe(404);
    expect((await fetch(`${baseUrl}/bots/trader-bot/order-journal/trader-order/events`, { headers: headers(adminAuth) })).status).toBe(404);
    expect((await fetch(`${baseUrl}/bots/trader-bot/start`, {
      method: "POST",
      headers: headers(adminAuth, true),
      body: "{}"
    })).status).toBe(404);

    const ownBotForeignOrder = await fetch(`${baseUrl}/bots/admin-bot/order-journal/trader-order/events`, { headers: headers(adminAuth) });
    expect(ownBotForeignOrder.status).toBe(200);
    expect(await ownBotForeignOrder.json()).toEqual({ events: [] });
  });

  it("isolates account metadata and credentials in both read and mutation paths", async () => {
    expect((await fetch(`${baseUrl}/accounts/trader-account`, { headers: headers(adminAuth) })).status).toBe(404);

    const foreignCredentialWrite = await fetch(`${baseUrl}/accounts/trader-account/credentials`, {
      method: "PUT",
      headers: headers(adminAuth, true),
      body: JSON.stringify({ apiKey: "replacement-key", apiSecret: "replacement-secret" })
    });
    expect(foreignCredentialWrite.status).toBe(404);
    expect(storeState.credentials.get(`${traderAuth.userId}:trader-account`)).toEqual({
      apiKey: "trader-api-key",
      apiSecret: "trader-api-secret"
    });
    expect(storeState.credentials.has(`${adminAuth.userId}:trader-account`)).toBe(false);

    const adminKeys = await fetch(`${baseUrl}/keys`, { headers: headers(adminAuth) });
    expect(adminKeys.status).toBe(200);
    expect(await adminKeys.json()).toEqual({ binance: false, bybit: false });

    const traderAccount = await fetch(`${baseUrl}/accounts/trader-account`, { headers: headers(traderAuth) });
    expect(traderAccount.status).toBe(200);
    const traderAccountBody = await traderAccount.json() as { account: Record<string, unknown> };
    expect(traderAccountBody.account).toMatchObject({ id: "trader-account", credential: { status: "configured", isolated: true } });
    expect(JSON.stringify(traderAccountBody)).not.toContain("trader-api-key");
    expect(JSON.stringify(traderAccountBody)).not.toContain("trader-api-secret");
    expect(traderAccountBody.account).not.toHaveProperty("ownerUserId");
  });

  it("returns only the authenticated owner's audit and bot collections", async () => {
    const adminAudit = await fetch(`${baseUrl}/audit`, { headers: headers(adminAuth) });
    expect(adminAudit.status).toBe(200);
    const adminAuditBody = await adminAudit.json() as { events: Array<{ ownerUserId?: string; action: string }> };
    expect(adminAuditBody.events.some((event) => event.action === "trader-own")).toBe(false);
    expect(adminAuditBody.events.every((event) => event.ownerUserId === adminAuth.userId)).toBe(true);

    const traderBots = await fetch(`${baseUrl}/bots`, { headers: headers(traderAuth) });
    expect(traderBots.status).toBe(200);
    const traderBotBody = await traderBots.json() as { bots: Array<{ id: string }> };
    expect(traderBotBody.bots.map((item) => item.id)).toEqual(["trader-bot"]);
  });

  it("rejects a credential rotation queued before a durable trading-role downgrade", async () => {
    const queuedUser = await identity.register("queued-trader", "correct-horse-battery-staple");
    await identity.activateUser(adminPrincipal, queuedUser.id);
    await identity.updatePermissions(adminPrincipal, queuedUser.id, { tradingRole: "live-trade" });
    const queuedCredentials = await identity.login(queuedUser.login, "correct-horse-battery-staple");
    const queuedAuth = authContext(queuedUser.id, queuedCredentials);
    const accountId = "queued-account";
    storeState.accounts.set(accountId, account(queuedUser.id, accountId));
    storeState.credentials.set(`${queuedUser.id}:${accountId}`, { apiKey: "original-api-key", apiSecret: "original-api-secret" });

    const originalLock = trading.engine.withAccountLifecycleLock.bind(trading.engine);
    let releaseBlock = () => {};
    let markBlockEntered = () => {};
    const blockEntered = new Promise<void>((resolve) => {
      markBlockEntered = resolve;
    });
    const blockGate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const blocker = originalLock(queuedUser.id, accountId, async () => {
      markBlockEntered();
      await blockGate;
    });
    await blockEntered;

    let markRequestQueued = () => {};
    const requestQueued = new Promise<void>((resolve) => {
      markRequestQueued = resolve;
    });
    const lockSpy = vi.spyOn(trading.engine, "withAccountLifecycleLock").mockImplementation((ownerUserId, candidateAccountId, operation) => {
      if (ownerUserId === queuedUser.id && candidateAccountId === accountId) markRequestQueued();
      return originalLock(ownerUserId, candidateAccountId, operation);
    });

    try {
      const rotation = fetch(`${baseUrl}/accounts/${accountId}/credentials`, {
        method: "PUT",
        headers: headers(queuedAuth, true),
        body: JSON.stringify({ apiKey: "replacement-api-key", apiSecret: "replacement-api-secret" })
      });
      await requestQueued;
      await identity.updatePermissions(adminPrincipal, queuedUser.id, { tradingRole: "none" });
      releaseBlock();

      const response = await rotation;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "authorization_stale" });
      expect(storeState.credentials.get(`${queuedUser.id}:${accountId}`)).toEqual({
        apiKey: "original-api-key",
        apiSecret: "original-api-secret"
      });
    } finally {
      releaseBlock();
      await blocker;
      lockSpy.mockRestore();
    }
  });

  it("rejects a bot update queued before a durable trading-role downgrade", async () => {
    const queuedUser = await identity.register("queued-bot-trader", "correct-horse-battery-staple");
    await identity.activateUser(adminPrincipal, queuedUser.id);
    await identity.updatePermissions(adminPrincipal, queuedUser.id, { tradingRole: "paper-trade" });
    const queuedCredentials = await identity.login(queuedUser.login, "correct-horse-battery-staple");
    const queuedAuth = authContext(queuedUser.id, queuedCredentials);
    const botId = "queued-paper-bot";
    const initial = bot(queuedUser.id, botId);
    storeState.bots.set(botId, initial);

    const originalLock = trading.engine.withBotLifecycleLock.bind(trading.engine);
    let releaseBlock = () => {};
    let markBlockEntered = () => {};
    const blockEntered = new Promise<void>((resolve) => {
      markBlockEntered = resolve;
    });
    const blockGate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const blocker = originalLock(queuedUser.id, botId, async () => {
      markBlockEntered();
      await blockGate;
    });
    await blockEntered;

    let markRequestQueued = () => {};
    const requestQueued = new Promise<void>((resolve) => {
      markRequestQueued = resolve;
    });
    const lockSpy = vi.spyOn(trading.engine, "withBotLifecycleLock").mockImplementation((ownerUserId, candidateBotId, operation) => {
      if (ownerUserId === queuedUser.id && candidateBotId === botId) markRequestQueued();
      return originalLock(ownerUserId, candidateBotId, operation);
    });

    try {
      const update = fetch(`${baseUrl}/bots`, {
        method: "POST",
        headers: headers(queuedAuth, true),
        body: JSON.stringify({
          id: botId,
          name: "must-not-persist",
          strategyName: initial.strategyName,
          ir: initial.ir,
          symbol: initial.symbol,
          timeframe: initial.timeframe,
          exchange: initial.exchange,
          market: initial.market,
          sizeMode: initial.sizeMode,
          sizeValue: initial.sizeValue,
          leverage: initial.leverage,
          notifyMarkers: initial.notifyMarkers
        })
      });
      await requestQueued;
      await identity.updatePermissions(adminPrincipal, queuedUser.id, { tradingRole: "none" });
      releaseBlock();

      const response = await update;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "authorization_stale" });
      expect(storeState.bots.get(botId)).toMatchObject({ name: botId, ownerUserId: queuedUser.id });
    } finally {
      releaseBlock();
      await blocker;
      lockSpy.mockRestore();
    }
  });

  it("disarms only the revoked owner's live gate", async () => {
    storeState.settings.set(`owner:${adminAuth.userId}:liveTradingEnabled`, true);
    storeState.settings.set(`owner:${traderAuth.userId}:liveTradingEnabled`, true);

    await trading.revokeOwnerAccess(traderAuth.userId);

    expect(storeState.settings.get(`owner:${traderAuth.userId}:liveTradingEnabled`)).toBe(false);
    expect(storeState.settings.get(`owner:${adminAuth.userId}:liveTradingEnabled`)).toBe(true);
  });
});
