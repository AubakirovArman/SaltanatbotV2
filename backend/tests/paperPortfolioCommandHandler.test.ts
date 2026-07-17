import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaperPortfolioCommandHandler,
  type PaperPortfolioCommandRuntime
} from "../src/trading/paperPortfolioCommandHandler.js";
import {
  paperPortfolioRequestHash,
  type PaperPortfolioExecutorPayload
} from "../src/trading/paperPortfolioCommandContract.js";
import {
  createPaperPortfolioIn,
  getPaperPortfolioEpochFrom,
  listPaperBotAllocationsFrom,
  reserveAndBindPaperBotIn
} from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import type { BotConfig } from "../src/trading/types.js";

const NOW = 1_800_000_000_000;
const OWNER = "command-owner";
const databases: DatabaseSync[] = [];

class Runtime implements PaperPortfolioCommandRuntime {
  readonly running = new Set<string>();
  readonly paused = new Set<string>();
  readonly calls: string[] = [];

  isRunning(owner: string, botId: string) { return owner === OWNER && this.running.has(botId); }
  isPaused(owner: string, botId: string) { return owner === OWNER && this.paused.has(botId); }
  async start(owner: string, bot: BotConfig) {
    expect(owner).toBe(OWNER);
    this.calls.push(`start:${bot.id}`);
    this.running.add(bot.id);
  }
  async pause(owner: string, botId: string) {
    expect(owner).toBe(OWNER);
    this.calls.push(`pause:${botId}`);
    this.paused.add(botId);
    return true;
  }
  async resume(owner: string, botId: string) {
    expect(owner).toBe(OWNER);
    this.calls.push(`resume:${botId}`);
    this.paused.delete(botId);
    return true;
  }
  async stop(owner: string, botId: string) {
    expect(owner).toBe(OWNER);
    this.calls.push(`stop:${botId}`);
    this.running.delete(botId);
    this.paused.delete(botId);
  }
}

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  databases.push(value);
  migrateTradingStore(value, () => NOW, { legacyOwnerUserId: OWNER });
  return value;
}

function paperBot(id: string): BotConfig {
  return {
    id,
    ownerUserId: OWNER,
    accountId: `paper:${id}`,
    name: "Command bot",
    strategyName: "Command strategy",
    ir: { name: "command", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: NOW,
    updatedAt: NOW
  };
}

function context(ownerUserId: string, commandId: string, key: string, payload: PaperPortfolioExecutorPayload) {
  return {
    commandId,
    ownerUserId,
    idempotencyKey: key,
    requestHash: paperPortfolioRequestHash(ownerUserId, payload),
    payload
  };
}

function boundFixture(value: DatabaseSync) {
  const portfolio = createPaperPortfolioIn(value, OWNER, {
    mutationId: "fixture-create",
    idempotencyKey: "fixture-create-key",
    requestHash: "a".repeat(64),
    now: NOW,
    portfolioId: "main",
    name: "Main",
    initialCapitalMicros: 100_000_000_000,
    makeDefault: true
  });
  const bot = upsertBotIntoForOwner(value, OWNER, paperBot("bot-1"));
  return reserveAndBindPaperBotIn(value, OWNER, {
    mutationId: "fixture-bind",
    idempotencyKey: "fixture-bind-key",
    requestHash: "b".repeat(64),
    now: NOW + 1,
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId: bot.id,
    expectedBotRevision: bot.revision!,
    allocationMicros: 10_000_000_000
  });
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("paper portfolio executor command handler", () => {
  it("creates and replays from the exact SQLite receipt", async () => {
    const value = database();
    const runtime = new Runtime();
    let clock = NOW + 1;
    const handler = new PaperPortfolioCommandHandler(value, runtime, () => clock++);
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-portfolio.create",
      portfolioId: "created",
      name: "Created",
      initialCapitalMicros: 25_000_000_000,
      makeDefault: true
    };
    const input = context(OWNER, "command-create", "command-create-key", payload);

    const first = await handler.apply(input);
    const replay = await handler.apply(input);

    expect(first).toMatchObject({
      replayed: false,
      result: { id: "created", revision: 1, currentEpoch: 1 }
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get()).toEqual({ value: 1 });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 1 });

    const exactProbe = {
      commandId: input.commandId,
      ownerUserId: input.ownerUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash
    };
    expect(handler.probeAppliedReceipt(exactProbe)).toEqual({
      sqliteReceiptHash: first.sqliteReceiptHash
    });
    expect(Object.keys(handler.probeAppliedReceipt(exactProbe)!)).toEqual(["sqliteReceiptHash"]);
    expect(handler.probeAppliedReceipt({ ...exactProbe, commandId: "another-command" })).toBeUndefined();
    expect(handler.probeAppliedReceipt({ ...exactProbe, ownerUserId: "another-owner" })).toBeUndefined();
    expect(handler.probeAppliedReceipt({ ...exactProbe, idempotencyKey: "another-key" })).toBeUndefined();
    expect(handler.probeAppliedReceipt({ ...exactProbe, requestHash: "b".repeat(64) })).toBeUndefined();
  });

  it("starts a bound robot once even when the command is delivered twice", async () => {
    const value = database();
    const runtime = new Runtime();
    const fixture = boundFixture(value);
    const handler = new PaperPortfolioCommandHandler(value, runtime, () => NOW + 10);
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-robot.action",
      portfolioId: fixture.portfolio.id,
      expectedPortfolioRevision: fixture.portfolio.revision,
      expectedLedgerEpoch: fixture.portfolio.currentEpoch,
      botId: fixture.allocation.botId,
      expectedBotRevision: fixture.allocation.botRevision,
      action: "start",
      confirm: true
    };
    const input = context(OWNER, "command-start", "command-start-key", payload);

    expect((await handler.apply(input)).replayed).toBe(false);
    expect((await handler.apply(input)).replayed).toBe(true);
    expect(runtime.calls).toEqual(["start:bot-1"]);
    expect(runtime.running.has("bot-1")).toBe(true);
  });

  it("creates, reserves and initializes a paper robot atomically", async () => {
    const value = database();
    const portfolio = createPaperPortfolioIn(value, OWNER, {
      mutationId: "robot-portfolio-create",
      idempotencyKey: "robot-portfolio-create-key",
      requestHash: "c".repeat(64),
      now: NOW,
      portfolioId: "robot-portfolio",
      name: "Robot portfolio",
      initialCapitalMicros: 100_000_000_000,
      makeDefault: true
    });
    const runtime = new Runtime();
    const handler = new PaperPortfolioCommandHandler(value, runtime, () => NOW + 10);
    const {
      ownerUserId: _owner,
      status: _status,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...bot
    } = paperBot("created-bot");
    const payload = {
      version: 1,
      kind: "paper-robot.create",
      portfolioId: portfolio.id,
      expectedPortfolioRevision: portfolio.revision,
      expectedLedgerEpoch: portfolio.currentEpoch,
      botId: bot.id,
      expectedBotRevision: 1,
      allocationMicros: 10_000_000_000,
      maxBots: 10,
      bot: { ...bot, bybitCrossCollateral: false }
    } as const satisfies PaperPortfolioExecutorPayload;
    const input = context(OWNER, "command-robot-create", "command-robot-create-key", payload);

    expect((await handler.apply(input)).replayed).toBe(false);
    expect((await handler.apply(input)).replayed).toBe(true);
    const stored = value.prepare("SELECT revision, config FROM bots WHERE id = ?").get("created-bot") as {
      revision: number;
      config: string;
    };
    expect(stored.revision).toBe(2);
    expect(JSON.parse(stored.config)).toMatchObject({
      id: "created-bot",
      createdAt: NOW + 10,
      updatedAt: NOW + 10,
      paperPortfolioId: "robot-portfolio",
      paperAllocationMicros: 10_000_000_000,
      paperLedgerEpoch: 1,
      revision: 2
    });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_bot_allocations WHERE botId = ?").get("created-bot"))
      .toEqual({ value: 1 });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_events WHERE botId = ?").get("created-bot"))
      .toEqual({ value: 1 });
  });

  it("stops flat robots, closes the old epoch and retains its immutable ledger on reset", async () => {
    const value = database();
    const runtime = new Runtime();
    const fixture = boundFixture(value);
    runtime.running.add("bot-1");
    const handler = new PaperPortfolioCommandHandler(value, runtime, () => NOW + 10);
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-portfolio.reset",
      portfolioId: fixture.portfolio.id,
      expectedPortfolioRevision: fixture.portfolio.revision,
      expectedLedgerEpoch: fixture.portfolio.currentEpoch,
      confirmName: "Main",
      confirmation: "RESET_PAPER_PORTFOLIO",
      initialCapitalMicros: 50_000_000_000
    };

    const result = await handler.apply(context(OWNER, "command-reset", "command-reset-key", payload));

    expect(runtime.calls).toEqual(["stop:bot-1"]);
    expect(result.result).toMatchObject({
      portfolio: {
        id: "main",
        revision: 3,
        currentEpoch: 2
      },
      rebindRequired: [{ botId: "bot-1", priorBotRevision: 2 }]
    });
    expect(getPaperPortfolioEpochFrom(value, OWNER, "main", 1)).toMatchObject({ status: "closed" });
    expect(getPaperPortfolioEpochFrom(value, OWNER, "main", 2)).toMatchObject({
      status: "active",
      initialCapitalMicros: 50_000_000_000,
      cashBalanceMicros: 50_000_000_000
    });
    expect(listPaperBotAllocationsFrom(value, OWNER, "main", 1)[0]).toMatchObject({ status: "closed" });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_events WHERE botId = ?").get("bot-1"))
      .toEqual({ value: 1 });
  });

  it("rejects wrong confirmation and cross-owner access without a mutation receipt", async () => {
    const value = database();
    const fixture = boundFixture(value);
    const handler = new PaperPortfolioCommandHandler(value, new Runtime(), () => NOW + 10);
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-portfolio.archive",
      portfolioId: fixture.portfolio.id,
      expectedPortfolioRevision: fixture.portfolio.revision,
      expectedLedgerEpoch: fixture.portfolio.currentEpoch,
      confirmName: "Wrong",
      confirmation: "ARCHIVE_PAPER_PORTFOLIO"
    };

    await expect(handler.apply(context(OWNER, "command-archive", "command-archive-key", payload)))
      .rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(handler.apply(context("another-owner", "command-other", "command-other-key", payload)))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(value.prepare(`
      SELECT COUNT(*) AS value FROM paper_portfolio_mutations
      WHERE id IN ('command-archive', 'command-other')
    `).get()).toEqual({ value: 0 });
  });
});
