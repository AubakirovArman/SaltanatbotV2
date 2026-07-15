import express, { Router } from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: new Map<string, Record<string, unknown>>(),
  bots: new Map<string, Record<string, unknown>>()
}));

function quotaError(code: string, limit: number, message: string): Error {
  return Object.assign(new Error(message), {
    name: "TradingResourceQuotaError",
    status: 429,
    code,
    limit
  });
}

vi.mock("../src/trading/store.js", () => {
  class TradingAccountInUseError extends Error {
    constructor(
      readonly accountId: string,
      readonly botIds: readonly string[]
    ) {
      super("account in use");
    }
  }
  const owned = (values: Map<string, Record<string, unknown>>, owner: string) => [...values.values()].filter((value) => value.ownerUserId === owner).map((value) => structuredClone(value));
  return {
    LEGACY_TRADING_OWNER_ID: "legacy-operator",
    TradingAccountInUseError,
    listTradingAccountsForOwner: (owner: string) => owned(state.accounts, owner),
    getTradingAccountForOwner: (owner: string, id: string) => {
      const value = state.accounts.get(id);
      return value?.ownerUserId === owner ? structuredClone(value) : undefined;
    },
    insertTradingAccountForOwner: (owner: string, account: Record<string, unknown>, limit?: number) => {
      if (limit !== undefined && owned(state.accounts, owner).length >= limit) {
        throw quotaError("TRADING_ACCOUNT_QUOTA_EXCEEDED", limit, "Trading account limit reached.");
      }
      state.accounts.set(String(account.id), structuredClone({ ...account, ownerUserId: owner }));
    },
    updateTradingAccountForOwner: () => false,
    deleteTradingAccountForOwner: () => false,
    getTradingAccountCredentialsForOwner: () => undefined,
    setTradingAccountCredentialsForOwner: () => undefined,
    deleteTradingAccountCredentialsForOwner: () => false,
    listBotsForOwner: (owner: string) => owned(state.bots, owner),
    getBotOwnerUserId: (id: string) => state.bots.get(id)?.ownerUserId,
    getBotForOwner: (owner: string, id: string) => {
      const value = state.bots.get(id);
      return value?.ownerUserId === owner ? structuredClone(value) : undefined;
    },
    upsertBotForOwner: (owner: string, bot: Record<string, unknown>, options?: { maxBots?: number }) => {
      if (!state.bots.has(String(bot.id)) && options?.maxBots !== undefined && owned(state.bots, owner).length >= options.maxBots) {
        throw quotaError("BOT_QUOTA_EXCEEDED", options.maxBots, "Robot limit reached.");
      }
      state.bots.set(String(bot.id), structuredClone({ ...bot, ownerUserId: owner }));
    },
    deleteBotForOwner: () => false,
    deleteSetting: () => undefined
  };
});

import { registerBotLifecycleMutationRoutes } from "../src/trading/botLifecycleMutationRoutes.js";
import { registerTradingAccountRegistryRoutes } from "../src/trading/tradingAccountRoutes.js";
import type { TradingEngine } from "../src/trading/engine.js";
import type { BotConfig } from "../src/trading/types.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const router = Router();
  const ownerUserId = "quota-owner";
  router.use((_request, response, next) => {
    response.locals.authUserId = ownerUserId;
    response.locals.authRole = "admin";
    next();
  });
  const allow = (_request: express.Request, _response: express.Response, next: express.NextFunction) => next();
  registerTradingAccountRegistryRoutes(router, allow, { maxAccountsPerOwner: 1 });
  const engine = {
    runtimeConfigForOwner: () => undefined,
    withBotLifecycleLock: async (_owner: string, _bot: string, operation: () => Promise<unknown>) => operation(),
    withAccountLifecycleLock: async (_owner: string, _account: string, operation: () => Promise<unknown>) => operation()
  } as unknown as TradingEngine;
  registerBotLifecycleMutationRoutes(router, engine, {
    maxBotsPerOwner: 1,
    view: (_owner, bot) => {
      const { ownerUserId: _privateOwner, ...publicBot } = bot;
      return publicBot;
    }
  });

  const app = express();
  app.use(express.json());
  app.use("/api/trade", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/trade`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("trading quota HTTP contract", () => {
  it("returns stable 429 responses for new account and robot creation", async () => {
    const firstAccount = await post("/accounts", { label: "First", exchange: "binance" });
    expect(firstAccount.status).toBe(201);
    const accountQuota = await post("/accounts", { label: "Second", exchange: "bybit" });
    expect(accountQuota.status).toBe(429);
    expect(await accountQuota.json()).toMatchObject({
      code: "TRADING_ACCOUNT_QUOTA_EXCEEDED",
      limit: 1
    });

    const firstBot = await post("/bots", botInput("First"));
    expect(firstBot.status).toBe(200);
    const botQuota = await post("/bots", botInput("Second"));
    expect(botQuota.status).toBe(429);
    expect(await botQuota.json()).toMatchObject({ code: "BOT_QUOTA_EXCEEDED", limit: 1 });

    expect(state.accounts).toHaveLength(1);
    expect(state.bots).toHaveLength(1);
  });
});

function botInput(name: string): Omit<BotConfig, "id" | "ownerUserId" | "status" | "createdAt" | "updatedAt" | "accountId"> {
  return {
    name,
    strategyName: "quota-test",
    ir: { name: "quota-test", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "spot",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    bybitCrossCollateral: false,
    notifyMarkers: false
  };
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
