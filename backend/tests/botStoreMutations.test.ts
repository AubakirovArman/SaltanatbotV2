import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPaperBotActiveAllocationInto,
  BotStoreMutationError,
  deleteBotIntoForOwner,
  updateBotRuntimeStatusInto
} from "../src/trading/botStoreMutations.js";
import {
  createPaperPortfolioIn,
  getPaperPortfolioFrom,
  listPaperBotAllocationsFrom,
  releaseFlatPaperBotAllocationIn,
  reserveAndBindPaperBotIn,
  resetPaperPortfolioIn,
  type PaperMutationIdentity
} from "../src/trading/paperPortfolioStore.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { BotConfig } from "../src/trading/types.js";

const OWNER = "owner-a";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => 1_000);
  return database;
}

function bot(id: string, exchange: BotConfig["exchange"] = "paper"): BotConfig {
  return {
    id,
    name: id,
    strategyName: "Runtime strategy",
    ir: { version: 1, nodes: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange,
    market: "spot",
    sizeMode: "quote",
    sizeValue: 1_000,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: 1_100,
    updatedAt: 1_100
  };
}

function mutation(id: string, now: number): PaperMutationIdentity {
  return {
    mutationId: `mutation-${id}`,
    idempotencyKey: `key-${id}`,
    requestHash: createHash("sha256").update(id).digest("hex"),
    now
  };
}

function allocatePaperBot(database: DatabaseSync, id: string) {
  const stored = upsertBotIntoForOwner(database, OWNER, bot(id));
  const portfolio = createPaperPortfolioIn(database, OWNER, {
    ...mutation(`create-${id}`, 2_000),
    portfolioId: `portfolio-${id}`,
    name: `${id} portfolio`,
    initialCapitalMicros: 20_000_000
  });
  const bound = reserveAndBindPaperBotIn(database, OWNER, {
    ...mutation(`bind-${id}`, 3_000),
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId: id,
    expectedBotRevision: stored.revision!,
    allocationMicros: 10_000_000
  });
  return { portfolio, bound };
}

function storedBot(database: DatabaseSync, id: string): BotConfig {
  const row = database.prepare("SELECT ownerUserId, config, revision FROM bots WHERE id = ?").get(id) as {
    ownerUserId: string;
    config: string;
    revision: number;
  };
  return { ...(JSON.parse(row.config) as BotConfig), ownerUserId: row.ownerUserId, revision: row.revision };
}

function insertJournalEvidence(database: DatabaseSync, botId: string): void {
  database.prepare("INSERT INTO fills (id, botId, data, ts) VALUES ('fill-1', ?, '{}', 10)").run(botId);
  database.prepare("INSERT INTO orders (id, botId, status, data, ts, updatedAt) VALUES ('order-1', ?, 'filled', '{}', 10, 11)").run(botId);
  database.prepare("INSERT INTO order_events (id, orderId, botId, type, data, ts) VALUES ('order-event-1', 'order-1', ?, 'fill', '{}', 11)").run(botId);
  database.prepare("INSERT INTO logs (botId, level, message, ts) VALUES (?, 'info', 'durable', 12)").run(botId);
  database.prepare(`
    INSERT INTO strategy_runs (id, botId, strategyName, status, startedAt, endedAt, data)
    VALUES ('run-1', ?, 'Runtime strategy', 'stopped', 10, 12, '{}')
  `).run(botId);
  database.prepare(`
    INSERT INTO positions (botId, symbol, market, status, data, updatedAt)
    VALUES (?, 'BTCUSDT', 'spot', 'flat', '{}', 12)
  `).run(botId);
}

describe("bot runtime state store", () => {
  it("starts and stops without changing the config revision or revision evidence", () => {
    const database = setup();
    const created = upsertBotIntoForOwner(database, OWNER, bot("runtime-bot", "binance"));
    expect(created.revision).toBe(1);

    const running = updateBotRuntimeStatusInto(database, OWNER, {
      botId: created.id,
      expectedRevision: 1,
      status: "running",
      updatedAt: 2_000
    });
    expect(running).toMatchObject({ status: "running", updatedAt: 2_000, revision: 1 });
    expect(database.prepare("SELECT revision FROM bots WHERE id = ?").get(created.id)).toEqual({ revision: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM paper_bot_revision_evidence WHERE botId = ?").get(created.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT status, startedAt, endedAt FROM strategy_runs WHERE botId = ?").get(created.id)).toMatchObject({
      status: "running", startedAt: 2_000, endedAt: null
    });

    const stopped = updateBotRuntimeStatusInto(database, OWNER, {
      botId: created.id,
      expectedRevision: 1,
      status: "stopped",
      updatedAt: 3_000
    });
    expect(stopped).toMatchObject({ status: "stopped", updatedAt: 3_000, revision: 1 });
    expect(database.prepare("SELECT revision FROM bots WHERE id = ?").get(created.id)).toEqual({ revision: 1 });
    expect(database.prepare("SELECT status, endedAt FROM strategy_runs WHERE botId = ?").get(created.id)).toMatchObject({
      status: "stopped", endedAt: 3_000
    });
    expect(() => updateBotRuntimeStatusInto(database, OWNER, {
      botId: created.id,
      expectedRevision: 2,
      status: "running",
      updatedAt: 4_000
    })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(() => updateBotRuntimeStatusInto(database, "owner-b", {
      botId: created.id,
      expectedRevision: 1,
      status: "running",
      updatedAt: 4_000
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("leaves existing paper revision evidence byte-for-byte unchanged", () => {
    const database = setup();
    const { bound } = allocatePaperBot(database, "paper-runtime");
    const evidenceBefore = database.prepare(`
      SELECT botRevision, config, configHash, source, createdAt
      FROM paper_bot_revision_evidence
      WHERE ownerUserId = ? AND botId = ? ORDER BY botRevision
    `).all(OWNER, "paper-runtime");

    updateBotRuntimeStatusInto(database, OWNER, {
      botId: "paper-runtime",
      expectedRevision: bound.botRevision,
      status: "running",
      updatedAt: 3_500
    });
    updateBotRuntimeStatusInto(database, OWNER, {
      botId: "paper-runtime",
      expectedRevision: bound.botRevision,
      status: "stopped",
      updatedAt: 3_600
    });

    expect(database.prepare("SELECT revision FROM bots WHERE id = 'paper-runtime'").get())
      .toEqual({ revision: bound.botRevision });
    expect(database.prepare(`
      SELECT botRevision, config, configHash, source, createdAt
      FROM paper_bot_revision_evidence
      WHERE ownerUserId = ? AND botId = ? ORDER BY botRevision
    `).all(OWNER, "paper-runtime")).toEqual(evidenceBefore);
  });
});

describe("paper bot active-allocation start guard", () => {
  it("rejects an unbound bot and remains owner-scoped", () => {
    const database = setup();
    const config = upsertBotIntoForOwner(database, OWNER, bot("unbound-paper"));

    expect(() => assertPaperBotActiveAllocationInto(database, OWNER, config))
      .toThrowError(expect.objectContaining({ code: "ACTIVE_ALLOCATION_REQUIRED" }));
    expect(() => assertPaperBotActiveAllocationInto(database, "owner-b", config))
      .toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("accepts only the exact active allocation and rejects it after release", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "released-guard");
    const config = storedBot(database, "released-guard");

    expect(assertPaperBotActiveAllocationInto(database, OWNER, config)).toEqual({
      ownerUserId: OWNER,
      botId: "released-guard",
      botRevision: bound.botRevision,
      portfolioId: portfolio.id,
      ledgerEpoch: bound.portfolio.currentEpoch,
      allocationMicros: 10_000_000
    });
    releaseFlatPaperBotAllocationIn(database, OWNER, {
      ...mutation("release-guard", 4_000),
      portfolioId: portfolio.id,
      expectedRevision: bound.portfolio.revision,
      expectedLedgerEpoch: bound.portfolio.currentEpoch,
      evidence: {
        botId: config.id,
        botRevision: bound.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: 10_000_000,
        checkedAt: 3_900,
        source: "guard-test",
        verified: true
      }
    });

    expect(() => assertPaperBotActiveAllocationInto(database, OWNER, config))
      .toThrowError(expect.objectContaining({ code: "ACTIVE_ALLOCATION_REQUIRED" }));
  });

  it("rejects the prior allocation after a portfolio epoch reset", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "reset-guard");
    const config = storedBot(database, "reset-guard");

    resetPaperPortfolioIn(database, OWNER, {
      ...mutation("reset-guard", 4_000),
      portfolioId: portfolio.id,
      expectedRevision: bound.portfolio.revision,
      expectedLedgerEpoch: bound.portfolio.currentEpoch,
      initialCapitalMicros: 20_000_000,
      flatBots: [{
        botId: config.id,
        botRevision: bound.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: 10_000_000,
        checkedAt: 3_900,
        source: "guard-test",
        verified: true
      }]
    });

    expect(() => assertPaperBotActiveAllocationInto(database, OWNER, config))
      .toThrowError(expect.objectContaining({ code: "ACTIVE_ALLOCATION_REQUIRED" }));
  });

  it("rejects stale bot revisions and binding fields", () => {
    const database = setup();
    const { bound } = allocatePaperBot(database, "stale-guard");
    const config = storedBot(database, "stale-guard");

    expect(() => assertPaperBotActiveAllocationInto(database, OWNER, {
      ...config,
      revision: bound.botRevision + 1
    })).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(() => assertPaperBotActiveAllocationInto(database, OWNER, {
      ...config,
      paperAllocationMicros: config.paperAllocationMicros! + 1
    })).toThrowError(expect.objectContaining({ code: "PAPER_BINDING_CONFLICT" }));
  });
});

describe("owner-scoped bot deletion", () => {
  it("rolls back paper deletion while portfolio capital is active", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "active-paper");
    database.prepare("INSERT INTO settings (key, value) VALUES (?, 'snapshot')").run("paper:active-paper");

    expect(deleteBotIntoForOwner(database, "owner-b", "active-paper", {
      expectedRevision: bound.botRevision,
      deletedAt: 4_000
    })).toBe(false);
    expect(() => deleteBotIntoForOwner(database, OWNER, "active-paper", {
      expectedRevision: bound.botRevision,
      deletedAt: 4_000
    })).toThrowError(expect.objectContaining({ code: "ACTIVE_ALLOCATION" }));

    expect(database.prepare("SELECT revision FROM bots WHERE id = 'active-paper'").get()).toEqual({ revision: bound.botRevision });
    expect(database.prepare("SELECT value FROM settings WHERE key = 'paper:active-paper'").get()).toEqual({ value: "snapshot" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM paper_bot_tombstones WHERE botId = 'active-paper'").get()).toEqual({ count: 0 });
    expect(listPaperBotAllocationsFrom(database, OWNER, portfolio.id)).toEqual([
      expect.objectContaining({ status: "active" })
    ]);
  });

  it("atomically releases a flat migrated allocation before legacy token-mode deletion", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "legacy-flat-delete");

    expect(deleteBotIntoForOwner(database, OWNER, "legacy-flat-delete", {
      expectedRevision: bound.botRevision,
      reason: "legacy-token-delete",
      deletedAt: 4_000,
      releaseLegacyFlatAllocation: true
    })).toBe(true);

    expect(database.prepare("SELECT id FROM bots WHERE id = 'legacy-flat-delete'").get()).toBeUndefined();
    expect(listPaperBotAllocationsFrom(database, OWNER, portfolio.id)).toEqual([
      expect.objectContaining({
        status: "released",
        releasedCapitalMicros: 10_000_000,
        releasedAt: 4_000
      })
    ]);
    expect(database.prepare(`
      SELECT cashBalanceMicros FROM paper_portfolio_epochs
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = 1
    `).get(OWNER, portfolio.id)).toEqual({ cashBalanceMicros: 20_000_000 });
    expect(database.prepare(`
      SELECT reason FROM paper_bot_tombstones WHERE ownerUserId = ? AND botId = ?
    `).get(OWNER, "legacy-flat-delete")).toEqual({ reason: "legacy-token-delete" });
  });

  it("keeps the bot and active capital when legacy deletion evidence contains open risk", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "legacy-open-delete");
    database.prepare(`
      INSERT INTO paper_events
        (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
      VALUES (?, ?, 1, 2, 'order_upserted', NULL, ?, 3_500)
    `).run(
      "legacy-open-delete-order",
      "legacy-open-delete",
      JSON.stringify({
        order: {
          id: "pending-order",
          symbol: "BTCUSDT",
          side: "buy",
          type: "limit",
          qty: 1,
          price: 100,
          reduceOnly: false,
          tif: "GTC",
          createdAt: 3_500
        }
      })
    );

    expect(() => deleteBotIntoForOwner(database, OWNER, "legacy-open-delete", {
      expectedRevision: bound.botRevision,
      deletedAt: 4_000,
      releaseLegacyFlatAllocation: true
    })).toThrowError(expect.objectContaining({ code: "OPEN_RISK" }));

    expect(database.prepare("SELECT id FROM bots WHERE id = 'legacy-open-delete'").get())
      .toEqual({ id: "legacy-open-delete" });
    expect(listPaperBotAllocationsFrom(database, OWNER, portfolio.id)).toEqual([
      expect.objectContaining({ status: "active" })
    ]);
    expect(database.prepare(`
      SELECT releasedCapitalMicros FROM paper_bot_allocations
      WHERE ownerUserId = ? AND portfolioId = ? AND botId = ?
    `).get(OWNER, portfolio.id, "legacy-open-delete")).toEqual({ releasedCapitalMicros: null });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM paper_portfolio_mutations
      WHERE ownerUserId = ? AND action = 'release'
    `).get(OWNER)).toEqual({ count: 0 });
  });

  it("soft-deletes a released paper bot while preserving every durable journal and evidence row", () => {
    const database = setup();
    const { portfolio, bound } = allocatePaperBot(database, "released-paper");
    const immutableConfig = (database.prepare(`
      SELECT config FROM paper_bot_revision_evidence
      WHERE ownerUserId = ? AND botId = ? AND botRevision = ?
    `).get(OWNER, "released-paper", bound.botRevision) as { config: string }).config;
    updateBotRuntimeStatusInto(database, OWNER, {
      botId: "released-paper",
      expectedRevision: bound.botRevision,
      status: "running",
      updatedAt: 3_500
    });
    updateBotRuntimeStatusInto(database, OWNER, {
      botId: "released-paper",
      expectedRevision: bound.botRevision,
      status: "stopped",
      updatedAt: 3_600
    });
    releaseFlatPaperBotAllocationIn(database, OWNER, {
      ...mutation("release-paper", 4_000),
      portfolioId: portfolio.id,
      expectedRevision: bound.portfolio.revision,
      expectedLedgerEpoch: bound.portfolio.currentEpoch,
      evidence: {
        botId: "released-paper",
        botRevision: bound.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: 9_000_000,
        checkedAt: 3_900,
        source: "test-projector",
        verified: true
      }
    });
    insertJournalEvidence(database, "released-paper");
    database.prepare("INSERT INTO settings (key, value) VALUES (?, 'snapshot')").run("paper:released-paper");
    database.prepare("INSERT INTO settings (key, value) VALUES (?, 'state')").run("state:released-paper");
    const before = database.prepare("SELECT config, revision FROM bots WHERE id = 'released-paper'").get() as { config: string; revision: number };
    expect(before.config).not.toBe(immutableConfig);
    const durableTables = ["paper_events", "fills", "orders", "order_events", "logs", "strategy_runs", "positions"] as const;
    const durableCounts = new Map(durableTables.map((table) => [
      table,
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE botId = ?`).get("released-paper") as { count: number }).count
    ]));

    expect(deleteBotIntoForOwner(database, OWNER, "released-paper", {
      expectedRevision: before.revision,
      reason: "user-delete",
      deletedAt: 5_000
    })).toBe(true);

    expect(database.prepare("SELECT id FROM bots WHERE id = 'released-paper'").get()).toBeUndefined();
    expect(database.prepare("SELECT key FROM settings WHERE key LIKE '%released-paper%'").all()).toEqual([]);
    for (const table of durableTables) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE botId = ?`).get("released-paper"), table)
        .toMatchObject({ count: durableCounts.get(table) });
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM paper_bot_revision_evidence WHERE botId = 'released-paper'").get()).toMatchObject({ count: 2 });
    expect(getPaperPortfolioFrom(database, OWNER, portfolio.id)).toBeDefined();
    expect(listPaperBotAllocationsFrom(database, OWNER, portfolio.id)).toEqual([
      expect.objectContaining({ botId: "released-paper", status: "released" })
    ]);
    expect(database.prepare(`
      SELECT botRevision, config, reason, deletedAt FROM paper_bot_tombstones WHERE ownerUserId = ? AND botId = ?
    `).get(OWNER, "released-paper")).toEqual({
      botRevision: before.revision,
      config: immutableConfig,
      reason: "user-delete",
      deletedAt: 5_000
    });
  });

  it("keeps live deletion cleanup semantics without ever deleting immutable paper events", () => {
    const database = setup();
    const created = upsertBotIntoForOwner(database, OWNER, bot("live-bot", "bybit"));
    insertJournalEvidence(database, created.id);
    database.prepare(`
      INSERT INTO paper_events (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
      VALUES ('orphan-paper-event', 'live-bot', 1, 1, 'account_initialized', 'account-initialized', '{}', 10)
    `).run();
    database.prepare("INSERT INTO settings (key, value) VALUES ('state:live-bot', 'state')").run();

    expect(deleteBotIntoForOwner(database, OWNER, created.id, {
      expectedRevision: created.revision,
      deletedAt: 5_000
    })).toBe(true);

    expect(database.prepare("SELECT id FROM bots WHERE id = 'live-bot'").get()).toBeUndefined();
    for (const table of ["fills", "orders", "order_events", "logs", "strategy_runs", "positions"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE botId = 'live-bot'`).get(), table)
        .toMatchObject({ count: 0 });
    }
    expect(database.prepare("SELECT id FROM paper_events WHERE botId = 'live-bot'").get()).toEqual({ id: "orphan-paper-event" });
    expect(database.prepare("SELECT key FROM settings WHERE key = 'state:live-bot'").get()).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM paper_bot_tombstones WHERE botId = 'live-bot'").get()).toEqual({ count: 0 });
  });
});
