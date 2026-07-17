import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import express, { Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    isDatabaseAuthMode: vi.fn(() => true),
    revalidateTradingAuthorization: vi.fn(async () => ({ assertCurrent: () => true }))
  };
});

vi.mock("../src/trading/store.js", () => {
  const database = () => state.database as DatabaseSync;
  const readBot = (ownerUserId: string, id: string) => {
    const row = database().prepare("SELECT ownerUserId, config, revision FROM bots WHERE ownerUserId = ? AND id = ?")
      .get(ownerUserId, id) as { ownerUserId: string; config: string; revision: number } | undefined;
    return row ? { ...JSON.parse(row.config), ownerUserId: row.ownerUserId, revision: row.revision } : undefined;
  };
  const transaction = <T>(operation: () => T): T => {
    const value = database();
    const ownsTransaction = !value.isTransaction;
    if (ownsTransaction) value.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (ownsTransaction) value.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction && value.isTransaction) value.exec("ROLLBACK");
      throw error;
    }
  };
  const upsert = (ownerUserId: string, bot: Record<string, unknown>, options: { maxBots?: number } = {}) => transaction(() => {
    const value = database();
    const foreign = value.prepare("SELECT ownerUserId FROM bots WHERE id = ?").get(bot.id) as { ownerUserId: string } | undefined;
    if (foreign && foreign.ownerUserId !== ownerUserId) throw new Error("foreign bot owner");
    const prior = value.prepare("SELECT revision FROM bots WHERE ownerUserId = ? AND id = ?").get(ownerUserId, bot.id) as { revision: number } | undefined;
    if (!prior && options.maxBots !== undefined) {
      const count = value.prepare("SELECT COUNT(*) AS value FROM bots WHERE ownerUserId = ?").get(ownerUserId) as { value: number };
      if (count.value >= options.maxBots) throw new Error("bot quota exceeded");
    }
    const revision = (prior?.revision ?? 0) + 1;
    const normalized = { ...bot, ownerUserId, revision };
    value.prepare(`
      INSERT INTO bots (id, ownerUserId, config, updatedAt, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET config = excluded.config, updatedAt = excluded.updatedAt,
        revision = excluded.revision WHERE bots.ownerUserId = excluded.ownerUserId
    `).run(bot.id, ownerUserId, JSON.stringify(normalized), bot.updatedAt, revision);
    return normalized;
  });
  return {
    LEGACY_TRADING_OWNER_ID: "legacy-owner",
    getBotForOwner: readBot,
    getBotOwnerUserId: (id: string) => (database().prepare("SELECT ownerUserId FROM bots WHERE id = ?").get(id) as { ownerUserId: string } | undefined)?.ownerUserId,
    getTradingAccountForOwner: () => undefined,
    upsertBotForOwner: (owner: string, bot: Record<string, unknown>, options?: { maxBots?: number }) => upsert(owner, bot, options),
    upsertBotIntoForOwner: (_database: DatabaseSync, owner: string, bot: Record<string, unknown>, options?: { maxBots?: number }) => upsert(owner, bot, options),
    withDatabaseTransaction: (_database: DatabaseSync, operation: () => unknown) => transaction(operation),
    deleteBotForOwner: () => false,
    deleteSetting: () => undefined
  };
});

import type { ExecutorCommandRepository } from "../src/database/executorCommandTypes.js";
import type { IdentityService } from "../src/identity/service.js";
import type { IdentitySession, IdentityUser } from "../src/identity/types.js";
import { registerBotLifecycleMutationRoutes } from "../src/trading/botLifecycleMutationRoutes.js";
import type { TradingEngine } from "../src/trading/engine.js";
import { createPaperPortfolioRuntime, type PaperPortfolioRuntime } from "../src/trading/paperPortfolioRuntime.js";
import { formatMicros } from "../src/trading/paperPortfolioProjectionStore.js";
import { createPaperPortfolioIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { BotConfig } from "../src/trading/types.js";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";
import { ExecutorCommandRepositoryDouble } from "./support/executorCommandRepositoryDouble.js";

const OWNER = "canonical-http-owner";
const OTHER_OWNER = "canonical-http-other";
const SESSION = "e".repeat(64);
const AUTH_REVISION = 9;
const AUTH_EPOCH = 13;
const NOW = 2_000_000_000_000;

let database: DatabaseSync;
let repository: ExecutorCommandRepositoryDouble;
let runtime: PaperPortfolioRuntime;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  database = new DatabaseSync(":memory:");
  state.database = database;
  migrateTradingStore(database, () => NOW, { legacyOwnerUserId: OWNER });
  repository = new ExecutorCommandRepositoryDouble(3, () => NOW + 1);
  const engine = engineDouble();
  runtime = createPaperPortfolioRuntime({
    database,
    engine,
    executorCommands: repository as ExecutorCommandRepository,
    identityService: identityDouble(),
    workerId: "canonical-http-worker"
  });
  const router = Router();
  router.use((_request, response, next) => {
    response.locals.authUserId = OWNER;
    response.locals.authRole = "paper-trade";
    response.locals.authPrincipal = {
      user: publicUser(),
      sessionIdHash: SESSION,
      csrfHash: "f".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      authorizationEpoch: AUTH_EPOCH,
      effectiveTradingRole: "paper-trade"
    };
    next();
  });
  registerBotLifecycleMutationRoutes(router, engine, {
    maxBotsPerOwner: 10,
    runtimePolicy: runtimePolicyFromConfig({ runtimeProfile: "public-http-paper" }),
    paperPortfolioCommands: runtime.commands,
    view: (_owner, bot) => publicBotView(bot)
  });
  const app = express();
  app.use(express.json());
  app.use("/api/trade", router);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error instanceof Error ? error.message : "unexpected" });
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/trade`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await runtime.close();
  database.close();
  state.database = undefined;
});

describe("database-auth canonical paper bot HTTP binding", () => {
  it("returns only public fixed-decimal allocation fields and forwards the exact session fence", async () => {
    const portfolio = createPortfolio();
    const response = await postBot("canonical-create", botBody(portfolio.id));
    const body = await response.json() as { bot: Record<string, unknown> };

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.bot).toMatchObject({
      id: deterministicBotId("canonical-create"),
      paperPortfolioId: portfolio.id,
      paperLedgerEpoch: 1,
      paperAllocation: "10.000000",
      revision: 2,
      status: "stopped"
    });
    expect(body.bot).not.toHaveProperty("ownerUserId");
    expect(body.bot).not.toHaveProperty("paperAllocationMicros");
    expect(JSON.stringify(body)).not.toContain("Micros");
    const durableBot = database.prepare("SELECT config FROM bots WHERE id = ?").get(body.bot.id) as { config: string };
    expect(JSON.parse(durableBot.config)).toMatchObject({
      ownerUserId: OWNER,
      paperAllocationMicros: 10_000_000
    });
    const command = [...repository.commands.values()][0];
    expect(command).toMatchObject({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: AUTH_REVISION,
      authorizationEpoch: AUTH_EPOCH,
      commandType: "paper-robot.create",
      targetType: "paper-robot",
      targetId: deterministicBotId("canonical-create"),
      status: "applied"
    });
    expect(command.payload).toMatchObject({
      portfolioId: portfolio.id,
      expectedPortfolioRevision: 1,
      expectedLedgerEpoch: 1,
      allocationMicros: 10_000_000
    });
  });

  it("replays the same request exactly and conflicts when the request changes", async () => {
    const portfolio = createPortfolio();
    const request = botBody(portfolio.id);
    const first = await postBot("canonical-replay", request);
    const replay = await postBot("canonical-replay", request);
    const conflict = await postBot("canonical-replay", { ...request, paperAllocation: "11.000000" });

    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    expect(replay.status, JSON.stringify(replayBody)).toBe(200);
    expect(replayBody).toEqual(firstBody);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(database.prepare("SELECT COUNT(*) AS value FROM bots").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM paper_bot_allocations").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM paper_events").get()).toEqual({ value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 2 });
    expect(repository.commands.size).toBe(1);
  });

  it.each([
    ["portfolio revision", { expectedPortfolioRevision: 2 }],
    ["ledger epoch", { expectedLedgerEpoch: 2 }]
  ])("fails closed on a stale %s", async (_name, override) => {
    const portfolio = createPortfolio();
    const response = await postBot(`stale-${_name}`, { ...botBody(portfolio.id), ...override });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: expect.stringMatching(/revision_conflict|epoch_conflict/) });
    expect(database.prepare("SELECT COUNT(*) AS value FROM bots").get()).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS value FROM paper_bot_allocations").get()).toEqual({ value: 0 });
  });

  it("rejects owner-context drift and missing idempotency before queueing", async () => {
    const portfolio = createPortfolio();
    const mismatched = await fetch(`${baseUrl}/bots`, {
      method: "POST",
      headers: mutationHeaders("owner-mismatch", OTHER_OWNER),
      body: JSON.stringify(botBody(portfolio.id))
    });
    const missingKey = await fetch(`${baseUrl}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sbv2-expected-user": OWNER },
      body: JSON.stringify(botBody(portfolio.id))
    });

    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toMatchObject({ code: "owner_context_mismatch" });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: "idempotency_key_required" });
    expect(repository.commands.size).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM bots").get()).toEqual({ value: 0 });
  });

  it("maps a zero paper allocation to a typed 400 without queueing", async () => {
    const portfolio = createPortfolio();
    const response = await postBot("zero-allocation", {
      ...botBody(portfolio.id),
      paperAllocation: "0.000000"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_money" });
    expect(repository.commands.size).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS value FROM bots").get()).toEqual({ value: 0 });
  });
});

function createPortfolio() {
  return createPaperPortfolioIn(database, OWNER, {
    mutationId: "portfolio-create",
    idempotencyKey: "portfolio-create-key",
    requestHash: "a".repeat(64),
    now: NOW,
    portfolioId: "canonical-portfolio",
    name: "Canonical",
    initialCapitalMicros: 100_000_000,
    makeDefault: true
  });
}

function botBody(portfolioId: string) {
  return {
    name: "Canonical bot",
    strategyName: "Canonical strategy",
    ir: { name: "canonical", inputs: [], body: [] },
    symbol: "btcusdt",
    timeframe: "1m",
    exchange: "paper",
    market: "spot",
    sizeMode: "quote",
    sizeValue: 1,
    leverage: 1,
    notifyMarkers: false,
    paperPortfolioId: portfolioId,
    paperAllocation: "10.000000",
    expectedPortfolioRevision: 1,
    expectedLedgerEpoch: 1
  };
}

function mutationHeaders(key: string, owner = OWNER): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-sbv2-expected-user": owner,
    "idempotency-key": key
  };
}

function postBot(key: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/bots`, {
    method: "POST",
    headers: mutationHeaders(key),
    body: JSON.stringify(body)
  });
}

function deterministicBotId(key: string): string {
  return `bot-${createHash("sha256").update(`${OWNER}\0paper-robot\0${key}`).digest("hex").slice(0, 32)}`;
}

function publicBotView(bot: BotConfig): Omit<BotConfig, "ownerUserId"> & { paperAllocation?: string } {
  const { ownerUserId: _owner, paperAllocationMicros, ...publicBot } = bot;
  return {
    ...publicBot,
    ...(paperAllocationMicros === undefined ? {} : { paperAllocation: formatMicros(paperAllocationMicros) }),
    status: "stopped"
  };
}

function engineDouble(): TradingEngine {
  return {
    runtimeConfigForOwner: () => undefined,
    isRunningForOwner: () => false,
    isPausedForOwner: () => false,
    withBotLifecycleLock: async (_owner: string, _bot: string, operation: () => Promise<unknown>) => operation(),
    withAccountLifecycleLock: async (_owner: string, _account: string, operation: () => Promise<unknown>) => operation(),
    async startForOwner() {},
    async pauseForOwner() { return false; },
    async confirmResumeForOwner() { return false; },
    async stopSafelyForOwner() {}
  } as unknown as TradingEngine;
}

function identityDouble(): IdentityService {
  const user = identityUser();
  const session: IdentitySession = {
    publicId: "22222222-2222-4222-8222-222222222222",
    idHash: SESSION,
    userId: OWNER,
    csrfHash: "f".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    createdAt: new Date()
  };
  return {
    repository: { findSession: vi.fn(async () => ({ session, user })) },
    executionAuthorizationSnapshot: vi.fn(async () => ({
      ownerUserId: OWNER,
      authorizationRevision: AUTH_REVISION,
      authorizationEpoch: AUTH_EPOCH,
      role: "paper-trade"
    })),
    isExecutionAuthorizationCurrent: vi.fn(() => true)
  } as unknown as IdentityService;
}

function identityUser(): IdentityUser {
  return {
    id: OWNER,
    login: OWNER,
    loginNormalized: OWNER,
    passwordHash: "test-only-password-hash",
    status: "active",
    appRole: "user",
    tradingRole: "paper-trade",
    mustChangePassword: false,
    authorizationRevision: AUTH_REVISION,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW)
  };
}

function publicUser() {
  return {
    id: OWNER,
    login: OWNER,
    status: "active" as const,
    appRole: "user" as const,
    tradingRole: "paper-trade" as const,
    mustChangePassword: false,
    authorizationRevision: AUTH_REVISION,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString()
  };
}
