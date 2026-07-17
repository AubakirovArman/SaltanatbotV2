import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { replayPaperLedger } from "../src/trading/paperLedger.js";
import { listPaperLedgerEventsFrom } from "../src/trading/paperLedgerStore.js";
import { buildPaperPortfolioSnapshotFrom } from "../src/trading/paperPortfolioProjectionStore.js";
import {
  archivePaperPortfolioIn,
  appendPaperPortfolioEventsIn,
  createPaperPortfolioIn,
  getPaperMutationReceiptFrom,
  getPaperProjectionMetadataFrom,
  getPaperPortfolioEpochFrom,
  getPaperPortfolioFrom,
  listPaperBotAllocationsFrom,
  listPaperPortfolioEpochsFrom,
  listPaperPortfolioEventsFrom,
  listPaperPortfoliosFrom,
  listPaperBotHistoryFrom,
  readPaperValuationMarkFrom,
  releaseFlatPaperBotAllocationIn,
  recordPaperBotRevisionEvidenceIn,
  recordPaperBotTombstoneIn,
  renamePaperPortfolioIn,
  reserveAndBindPaperBotIn,
  resetPaperPortfolioIn,
  upsertPaperValuationMarkIn,
  upsertPaperProjectionMetadataIn,
  type PaperMutationIdentity,
  type VerifiedFlatBotEvidence
} from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function memoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => 1_000);
  return database;
}

function v8Database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL,
      config TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (ownerUserId, id)
    );
    CREATE TABLE paper_events (
      id TEXT PRIMARY KEY,
      botId TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      idempotencyKey TEXT,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE (botId, sequence)
    );
    CREATE UNIQUE INDEX idx_paper_events_idempotency
      ON paper_events(botId, idempotencyKey) WHERE idempotencyKey IS NOT NULL;
    CREATE TRIGGER paper_events_no_update BEFORE UPDATE ON paper_events BEGIN
      SELECT RAISE(ABORT, 'paper_events is append-only');
    END;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
    PRAGMA user_version = 8;
  `);
  return database;
}

function mutation(id: string, now = 2_000, payload = id): PaperMutationIdentity {
  return {
    mutationId: `mutation-${id}`,
    idempotencyKey: `key-${id}`,
    requestHash: createHash("sha256").update(payload).digest("hex"),
    now
  };
}

function insertPaperBot(database: DatabaseSync, owner: string, id: string, revision = 1): void {
  database.prepare(`
    INSERT INTO bots (id, ownerUserId, config, updatedAt, revision) VALUES (?, ?, ?, ?, ?)
  `).run(id, owner, JSON.stringify({ id, name: id, exchange: "paper", status: "stopped", revision }), 1_500, revision);
}

function createPortfolio(database: DatabaseSync, owner = "owner-a", capital = 100_000_000_000) {
  return createPaperPortfolioIn(database, owner, {
    ...mutation(`create-${owner}`),
    portfolioId: "portfolio-1",
    name: "Main paper",
    initialCapitalMicros: capital
  });
}

function flatEvidence(botId: string, botRevision: number, returnedCapitalMicros: number, checkedAt = 4_000): VerifiedFlatBotEvidence {
  return {
    botId,
    botRevision,
    positionFlat: true,
    openOrders: 0,
    returnedCapitalMicros,
    checkedAt,
    source: "paper-ledger-projector",
    verified: true
  };
}

describe("paper portfolio schema v9 migration", () => {
  it("isolates every legacy paper bot while preserving its exact event economics", () => {
    const database = v8Database();
    const eventData = JSON.stringify({ balance: 12_345.678901, leverage: 1, isolated: false, dualSide: false });
    database.prepare("INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)").run(
      "legacy-ledger", "owner-a",
      JSON.stringify({ id: "legacy-ledger", name: "Ledger bot", exchange: "paper", market: "spot", status: "stopped", sizeMode: "quote", sizeValue: 1_000, createdAt: 100 }),
      200
    );
    database.prepare("INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)").run(
      "legacy-snapshot", "owner-a",
      JSON.stringify({ id: "legacy-snapshot", name: "Snapshot bot", exchange: "paper", market: "spot", status: "stopped", sizeMode: "quote", sizeValue: 1_000, createdAt: 110 }),
      210
    );
    database.prepare(`
      INSERT INTO paper_events (id, botId, sequence, type, idempotencyKey, data, ts)
      VALUES ('event-1', 'legacy-ledger', 1, 'account_initialized', 'account-initialized', ?, 120)
    `).run(eventData);
    database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "paper:legacy-snapshot",
      JSON.stringify({ balance: 7_777.25, position: null, orders: [], leverage: 1, isolated: false, dualSide: false })
    );
    const exactBefore = database.prepare("SELECT id, botId, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE id = 'event-1'").get();

    const result = migrateTradingStore(database, () => 5_000);

    expect(result).toMatchObject({ fromVersion: 8, toVersion: 9 });
    expect(database.prepare("SELECT id, botId, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE id = 'event-1'").get()).toEqual(exactBefore);
    expect(database.prepare("SELECT ledgerEpoch FROM paper_events WHERE id = 'event-1'").get()).toEqual({ ledgerEpoch: 1 });
    const portfolios = listPaperPortfoliosFrom(database, "owner-a", true);
    expect(portfolios).toHaveLength(2);
    expect(new Set(portfolios.map((portfolio) => portfolio.id)).size).toBe(2);
    for (const portfolio of portfolios) {
      expect(listPaperBotAllocationsFrom(database, "owner-a", portfolio.id)).toEqual([
        expect.objectContaining({ status: "active", ledgerEpoch: 1 })
      ]);
      expect(getPaperPortfolioEpochFrom(database, "owner-a", portfolio.id, 1)).toMatchObject({ cashBalanceMicros: 0, status: "active" });
    }
    const ledgerConfig = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = 'legacy-ledger'").get() as { config: string }).config));
    expect(ledgerConfig).toMatchObject({ paperAllocationMicros: 12_345_678_901, paperLedgerEpoch: 1, revision: 1 });
    const snapshotConfig = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = 'legacy-snapshot'").get() as { config: string }).config));
    expect(snapshotConfig).toMatchObject({ paperAllocationMicros: 10_000_000_000, paperLedgerEpoch: 1, revision: 1 });
    const snapshotPortfolio = portfolios.find((portfolio) => portfolio.id === snapshotConfig.paperPortfolioId)!;
    expect(getPaperPortfolioEpochFrom(database, "owner-a", snapshotPortfolio.id, 1)?.evidenceState).toBe("legacy-incomplete");
    const synthesized = listPaperLedgerEventsFrom(database, "legacy-snapshot", 1);
    expect(synthesized.map((event) => event.type)).toEqual(["account_initialized", "cash", "settings"]);
    expect(replayPaperLedger(synthesized, "legacy-snapshot", 1).balance).toBe(7_777.25);
    const projection = buildPaperPortfolioSnapshotFrom(database, "owner-a", snapshotPortfolio.id, 6_000).snapshot;
    expect(projection).toMatchObject({
      ledgerEpoch: 1,
      robots: [{ botId: "legacy-snapshot", ledger: { eventCount: 3 } }],
      aggregates: { initialCapital: "10000.000000", cashBalance: "7777.250000" }
    });
  });

  it("rolls the whole v8 migration back when legacy evidence is invalid", () => {
    const database = v8Database();
    database.prepare("INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)").run(
      "broken", "owner-a", JSON.stringify({ id: "broken", exchange: "paper", sizeMode: "quote", sizeValue: 100 }), 100
    );
    database.prepare(`
      INSERT INTO paper_events (id, botId, sequence, type, idempotencyKey, data, ts)
      VALUES ('broken-event', 'broken', 1, 'account_initialized', 'account-initialized', '{"balance":-1,"leverage":1,"isolated":false,"dualSide":false}', 100)
    `).run();

    expect(() => migrateTradingStore(database, () => 5_000)).toThrow(/initial balance/i);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect((database.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>).some((column) => column.name === "revision")).toBe(false);
    expect((database.prepare("PRAGMA table_info(paper_events)").all() as Array<{ name: string }>).some((column) => column.name === "ledgerEpoch")).toBe(false);
    expect(database.prepare("SELECT data FROM paper_events WHERE id = 'broken-event'").get()).toEqual({
      data: '{"balance":-1,"leverage":1,"isolated":false,"dualSide":false}'
    });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_portfolios'").get()).toBeUndefined();
  });

  it("rolls back when deterministic snapshot-ledger evidence conflicts with an existing event id", () => {
    const database = v8Database();
    const botId = "snapshot-conflict";
    const deterministicId = `legacy-ledger-${createHash("sha256").update(`owner-a\0${botId}\0${1}`).digest("hex")}`;
    database.prepare("INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)").run(
      botId, "owner-a", JSON.stringify({ id: botId, exchange: "paper", sizeMode: "quote", sizeValue: 100 }), 100
    );
    database.prepare(`
      INSERT INTO paper_events (id, botId, sequence, type, idempotencyKey, data, ts)
      VALUES (?, 'orphan-ledger', 1, 'account_initialized', 'account-initialized',
        '{"balance":10000,"leverage":1,"isolated":false,"dualSide":false}', 100)
    `).run(deterministicId);
    database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      `paper:${botId}`,
      JSON.stringify({ balance: 1_000, position: null, orders: [], leverage: 1, isolated: false, dualSide: false })
    );

    expect(() => migrateTradingStore(database, () => 5_000)).toThrow(/unique/i);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(database.prepare("SELECT botId FROM paper_events WHERE id = ?").get(deterministicId)).toEqual({ botId: "orphan-ledger" });
    expect((database.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>).some((column) => column.name === "revision")).toBe(false);
  });

  it("denies UPDATE and DELETE for both legacy and portfolio event evidence", () => {
    const database = memoryDatabase();
    const portfolio = createPortfolio(database);
    expect(() => database.prepare("UPDATE paper_portfolio_events SET ts = 9 WHERE portfolioId = ?").run(portfolio.id)).toThrow(/append-only/);
    expect(() => database.prepare("DELETE FROM paper_portfolio_events WHERE portfolioId = ?").run(portfolio.id)).toThrow(/append-only/);
    database.prepare(`
      INSERT INTO paper_events (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
      VALUES ('immutable', 'immutable-bot', 1, 1, 'account_initialized', 'account-initialized', '{}', 1)
    `).run();
    expect(() => database.prepare("UPDATE paper_events SET ts = 2 WHERE id = 'immutable'").run()).toThrow(/append-only/);
    expect(() => database.prepare("DELETE FROM paper_events WHERE id = 'immutable'").run()).toThrow(/append-only/);
  });
});

describe("owner-scoped paper portfolio lifecycle", () => {
  it("never reveals another owner's portfolio, marks, or history", () => {
    const database = memoryDatabase();
    const portfolio = createPortfolio(database, "owner-a");
    database.prepare(`
      INSERT INTO paper_bot_allocations
        (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, reservedCapitalMicros, status, createdAt)
      VALUES ('owner-a', ?, 1, 'bot-a', 1, 1000000, 'active', 2999)
    `).run(portfolio.id);
    const mark = {
      ownerUserId: "owner-a", portfolioId: portfolio.id, ledgerEpoch: 1,
      botId: "bot-a", botRevision: 1, symbol: "BTCUSDT", priceMicros: 65_000_000_000,
      asOf: 3_000, source: "fixture", expiresAt: 4_000, evidence: { quote: "durable" }, persistedAt: 3_001
    } as const;
    upsertPaperValuationMarkIn(database, mark);
    expect(upsertPaperValuationMarkIn(database, { ...mark, persistedAt: 3_500 }))
      .toMatchObject({ asOf: 3_000, persistedAt: 3_001 });
    expect(() => upsertPaperValuationMarkIn(database, {
      ...mark,
      priceMicros: 65_001_000_000,
      persistedAt: 3_500
    })).toThrow(/different valuation mark/i);

    expect(getPaperPortfolioFrom(database, "owner-b", portfolio.id)).toBeUndefined();
    expect(listPaperPortfoliosFrom(database, "owner-b", true)).toEqual([]);
    expect(readPaperValuationMarkFrom(database, "owner-b", portfolio.id, 1, "bot-a", 1, "BTCUSDT")).toBeUndefined();
    expect(listPaperPortfolioEventsFrom(database, "owner-b", portfolio.id)).toEqual([]);
  });

  it("appends executor evidence idempotently and rejects an ordinal conflict", () => {
    const database = memoryDatabase();
    const portfolio = createPortfolio(database);
    const event = [{ type: "projected", data: { equityMicros: 101 }, ts: 3_000 }];
    expect(appendPaperPortfolioEventsIn(database, "owner-a", portfolio.id, 1, "projection-1", event)).toBe(1);
    expect(appendPaperPortfolioEventsIn(database, "owner-a", portfolio.id, 1, "projection-1", event)).toBe(0);
    expect(() => appendPaperPortfolioEventsIn(database, "owner-a", portfolio.id, 1, "projection-1", [
      { ...event[0], data: { equityMicros: 102 } }
    ])).toThrow(/different evidence/i);
  });

  it("compare-and-swaps projector metadata without allowing a rewind", () => {
    const database = memoryDatabase();
    const portfolio = createPortfolio(database);
    expect(upsertPaperProjectionMetadataIn(database, "owner-a", {
      portfolioId: portfolio.id, ledgerEpoch: 1, lastSequence: 1,
      formulaVersion: "paper-metrics-v1", evidenceState: "complete",
      projection: { equityMicros: 100 }, expectedRevision: 0, projectedAt: 3_000
    })).toBe(1);
    expect(() => upsertPaperProjectionMetadataIn(database, "owner-a", {
      portfolioId: portfolio.id, ledgerEpoch: 1, lastSequence: 2,
      formulaVersion: "paper-metrics-v1", evidenceState: "complete",
      projection: { equityMicros: 101 }, expectedRevision: 0, projectedAt: 3_100
    })).toThrow(/revision changed/i);
    expect(upsertPaperProjectionMetadataIn(database, "owner-a", {
      portfolioId: portfolio.id, ledgerEpoch: 1, lastSequence: 2,
      formulaVersion: "paper-metrics-v1", evidenceState: "complete",
      projection: { equityMicros: 101 }, expectedRevision: 1, projectedAt: 3_100
    })).toBe(2);
    expect(() => upsertPaperProjectionMetadataIn(database, "owner-a", {
      portfolioId: portfolio.id, ledgerEpoch: 1, lastSequence: 1,
      formulaVersion: "paper-metrics-v1", evidenceState: "complete",
      projection: { equityMicros: 99 }, expectedRevision: 2, projectedAt: 3_200
    })).toThrow(/move backwards/i);
    expect(getPaperProjectionMetadataFrom(database, "owner-a", portfolio.id, 1)).toMatchObject({
      revision: 2, lastSequence: 2, projection: { equityMicros: 101 }
    });
  });

  it("keeps bot revision evidence and tombstones owner-scoped and immutable", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-history");
    const config = String((database.prepare("SELECT config FROM bots WHERE id = 'bot-history'").get() as { config: string }).config);
    recordPaperBotRevisionEvidenceIn(database, "owner-a", {
      botId: "bot-history", botRevision: 1, config, source: "test", createdAt: 3_000
    });
    recordPaperBotTombstoneIn(database, "owner-a", {
      botId: "bot-history", botRevision: 1, config, reason: "user-delete", deletedAt: 3_100
    });
    expect(listPaperBotHistoryFrom(database, "owner-a", "bot-history")).toMatchObject({
      revisions: [{ botRevision: 1 }], tombstones: [{ botRevision: 1, reason: "user-delete" }]
    });
    expect(listPaperBotHistoryFrom(database, "owner-b", "bot-history")).toEqual({ revisions: [], tombstones: [] });
    expect(() => database.prepare("DELETE FROM paper_bot_revision_evidence WHERE botId = 'bot-history'").run()).toThrow(/immutable/);
    expect(() => database.prepare("UPDATE paper_bot_tombstones SET reason = 'rewrite'").run()).toThrow(/immutable/);
  });

  it("serializes competing reservations so exactly one succeeds", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "paper-portfolio-"));
    directories.push(directory);
    const file = resolve(directory, "trading.db");
    const first = new DatabaseSync(file);
    const second = new DatabaseSync(file);
    databases.push(first, second);
    migrateTradingStore(first, () => 1_000);
    insertPaperBot(first, "owner-a", "bot-a");
    insertPaperBot(first, "owner-a", "bot-b");
    const portfolio = createPortfolio(first, "owner-a", 100_000_000);
    const reserve = (database: DatabaseSync, botId: string, id: string) => reserveAndBindPaperBotIn(database, "owner-a", {
      ...mutation(id, 3_000, `reserve-${botId}`),
      portfolioId: portfolio.id,
      expectedRevision: 1,
      expectedLedgerEpoch: 1,
      botId,
      expectedBotRevision: 1,
      allocationMicros: 60_000_000
    });

    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => reserve(first, "bot-a", "reserve-a")),
      Promise.resolve().then(() => reserve(second, "bot-b", "reserve-b"))
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(listPaperBotAllocationsFrom(first, "owner-a", portfolio.id).filter((allocation) => allocation.status === "active")).toHaveLength(1);
    expect(getPaperPortfolioEpochFrom(first, "owner-a", portfolio.id, 1)?.cashBalanceMicros).toBe(40_000_000);
  });

  it("returns an applied result for the same idempotency identity and rejects reuse", () => {
    const database = memoryDatabase();
    const input = {
      ...mutation("same", 2_000, "same-request"),
      portfolioId: "portfolio-idempotent",
      name: "Idempotent",
      initialCapitalMicros: 1_000_000
    };
    const first = createPaperPortfolioIn(database, "owner-a", input);
    const replay = createPaperPortfolioIn(database, "owner-a", input);
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_events").get()).toEqual({ value: 1 });
    expect(getPaperMutationReceiptFrom(database, "owner-a", input.idempotencyKey)).toMatchObject({ status: "applied", action: "create" });

    expect(() => createPaperPortfolioIn(database, "owner-a", {
      ...input,
      requestHash: createHash("sha256").update("different-request").digest("hex")
    })).toThrow(/different request/i);
  });

  it("persists rejected receipts and enforces compare-and-swap revisions", () => {
    const database = memoryDatabase();
    const portfolio = createPortfolio(database);
    const rename = {
      ...mutation("rename", 3_000),
      portfolioId: portfolio.id,
      expectedRevision: portfolio.revision,
      expectedLedgerEpoch: 1,
      name: "Renamed"
    };
    expect(renamePaperPortfolioIn(database, "owner-a", rename).revision).toBe(2);
    const stale = { ...mutation("stale", 3_100), portfolioId: portfolio.id, expectedRevision: 1, expectedLedgerEpoch: 1, name: "Stale" };
    expect(() => renamePaperPortfolioIn(database, "owner-a", stale)).toThrow(/revision changed/i);
    expect(getPaperMutationReceiptFrom(database, "owner-a", stale.idempotencyKey)).toMatchObject({
      status: "rejected",
      result: { error: { code: "REVISION_CONFLICT" } }
    });
    expect(() => renamePaperPortfolioIn(database, "owner-a", stale)).toThrow(/revision changed/i);
    expect(getPaperPortfolioFrom(database, "owner-a", portfolio.id)?.name).toBe("Renamed");
  });

  it("initializes the bound bot ledger in the same atomic reservation", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-a");
    const portfolio = createPortfolio(database, "owner-a", 20_000_000);

    const result = reserveAndBindPaperBotIn(database, "owner-a", {
      ...mutation("bind", 3_000), portfolioId: portfolio.id, expectedRevision: 1, expectedLedgerEpoch: 1,
      botId: "bot-a", expectedBotRevision: 1, allocationMicros: 10_000_000
    });

    expect(result).toMatchObject({ botRevision: 2, allocation: { status: "active", reservedCapitalMicros: 10_000_000 } });
    const event = database.prepare("SELECT ledgerEpoch, sequence, type, idempotencyKey, data FROM paper_events WHERE botId = 'bot-a'").get() as {
      ledgerEpoch: number; sequence: number; type: string; idempotencyKey: string; data: string;
    };
    expect(event).toMatchObject({ ledgerEpoch: 1, sequence: 1, type: "account_initialized", idempotencyKey: "account-initialized" });
    expect(JSON.parse(event.data)).toMatchObject({ balance: 10 });
    const config = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = 'bot-a'").get() as { config: string }).config));
    expect(config).toMatchObject({ paperPortfolioId: portfolio.id, paperAllocationMicros: 10_000_000, paperLedgerEpoch: 1, revision: 2 });
  });

  it("rolls back the bot binding and capital reservation if ledger initialization cannot be created", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-a");
    const portfolio = createPortfolio(database, "owner-a", 20_000_000);
    database.prepare(`
      INSERT INTO paper_events (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
      VALUES ('prior', 'bot-a', 1, 1, 'account_initialized', 'account-initialized', '{}', 2_500)
    `).run();
    const request = {
      ...mutation("conflicting-bind", 3_000), portfolioId: portfolio.id,
      expectedRevision: 1, expectedLedgerEpoch: 1, botId: "bot-a",
      expectedBotRevision: 1, allocationMicros: 10_000_000
    };

    expect(() => reserveAndBindPaperBotIn(database, "owner-a", request)).toThrow(/durable evidence/i);

    expect(getPaperPortfolioFrom(database, "owner-a", portfolio.id)?.revision).toBe(1);
    expect(getPaperPortfolioEpochFrom(database, "owner-a", portfolio.id, 1)?.cashBalanceMicros).toBe(20_000_000);
    expect(listPaperBotAllocationsFrom(database, "owner-a", portfolio.id)).toEqual([]);
    expect(database.prepare("SELECT revision, config FROM bots WHERE id = 'bot-a'").get()).toMatchObject({ revision: 1 });
    expect(getPaperMutationReceiptFrom(database, "owner-a", request.idempotencyKey)).toMatchObject({ status: "rejected" });
  });

  it("releases only verified-flat capital and conserves portfolio cash", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-a");
    const portfolio = createPortfolio(database, "owner-a", 50_000_000);
    const bound = reserveAndBindPaperBotIn(database, "owner-a", {
      ...mutation("bind-release", 3_000), portfolioId: portfolio.id, expectedRevision: 1, expectedLedgerEpoch: 1,
      botId: "bot-a", expectedBotRevision: 1, allocationMicros: 20_000_000
    });
    expect(getPaperPortfolioEpochFrom(database, "owner-a", portfolio.id, 1)?.cashBalanceMicros).toBe(30_000_000);
    const invalid = { ...flatEvidence("bot-a", bound.botRevision, 18_000_000), verified: false as true };
    expect(() => releaseFlatPaperBotAllocationIn(database, "owner-a", {
      ...mutation("bad-release", 3_500), portfolioId: portfolio.id, expectedRevision: 2, expectedLedgerEpoch: 1, evidence: invalid
    })).toThrow(/verified flat/i);

    const released = releaseFlatPaperBotAllocationIn(database, "owner-a", {
      ...mutation("release", 4_000), portfolioId: portfolio.id, expectedRevision: 2, expectedLedgerEpoch: 1,
      evidence: flatEvidence("bot-a", bound.botRevision, 18_000_000)
    });
    expect(released.allocation).toMatchObject({
      status: "released", reservedCapitalMicros: 20_000_000, releasedCapitalMicros: 18_000_000
    });
    expect(getPaperPortfolioEpochFrom(database, "owner-a", portfolio.id, 1)?.cashBalanceMicros).toBe(48_000_000);
  });

  it("resets into a new epoch without deleting history and explicitly requires rebinding", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-a");
    const portfolio = createPortfolio(database, "owner-a", 30_000_000);
    const bound = reserveAndBindPaperBotIn(database, "owner-a", {
      ...mutation("bind-reset", 3_000), portfolioId: portfolio.id, expectedRevision: 1, expectedLedgerEpoch: 1,
      botId: "bot-a", expectedBotRevision: 1, allocationMicros: 10_000_000
    });

    const reset = resetPaperPortfolioIn(database, "owner-a", {
      ...mutation("reset", 5_000), portfolioId: portfolio.id, expectedRevision: 2, expectedLedgerEpoch: 1,
      initialCapitalMicros: 25_000_000,
      flatBots: [flatEvidence("bot-a", bound.botRevision, 11_000_000, 4_900)]
    });

    expect(reset).toMatchObject({
      portfolio: { revision: 3, currentEpoch: 2 },
      rebindRequired: [{ botId: "bot-a", priorBotRevision: 2 }],
      closedAllocations: [{ status: "closed", releasedCapitalMicros: 11_000_000 }]
    });
    expect(listPaperPortfolioEpochsFrom(database, "owner-a", portfolio.id)).toEqual([
      expect.objectContaining({ ledgerEpoch: 1, status: "closed", cashBalanceMicros: 31_000_000 }),
      expect.objectContaining({ ledgerEpoch: 2, status: "active", initialCapitalMicros: 25_000_000, cashBalanceMicros: 25_000_000 })
    ]);
    expect(database.prepare("SELECT ledgerEpoch, sequence, type FROM paper_events WHERE botId = 'bot-a'").all()).toEqual([
      { ledgerEpoch: 1, sequence: 1, type: "account_initialized" }
    ]);
    expect(listPaperPortfolioEventsFrom(database, "owner-a", portfolio.id).map((event) => event.type)).toEqual([
      "portfolio-created", "bot-reserved", "epoch-closed", "epoch-reset"
    ]);
  });

  it("archives only after every active allocation has been released", () => {
    const database = memoryDatabase();
    insertPaperBot(database, "owner-a", "bot-a");
    const portfolio = createPortfolio(database, "owner-a", 20_000_000);
    const bound = reserveAndBindPaperBotIn(database, "owner-a", {
      ...mutation("bind-archive", 3_000), portfolioId: portfolio.id,
      expectedRevision: 1, expectedLedgerEpoch: 1, botId: "bot-a",
      expectedBotRevision: 1, allocationMicros: 10_000_000
    });
    expect(() => archivePaperPortfolioIn(database, "owner-a", {
      ...mutation("archive-active", 3_500), portfolioId: portfolio.id, expectedRevision: 2, expectedLedgerEpoch: 1
    })).toThrow(/release every active/i);
    releaseFlatPaperBotAllocationIn(database, "owner-a", {
      ...mutation("release-archive", 4_000), portfolioId: portfolio.id,
      expectedRevision: 2, expectedLedgerEpoch: 1,
      evidence: flatEvidence("bot-a", bound.botRevision, 10_000_000)
    });

    const archived = archivePaperPortfolioIn(database, "owner-a", {
      ...mutation("archive-flat", 4_500), portfolioId: portfolio.id, expectedRevision: 3, expectedLedgerEpoch: 1
    });
    expect(archived).toMatchObject({ status: "archived", isDefault: false, revision: 4, archivedAt: 4_500 });
    expect(getPaperPortfolioEpochFrom(database, "owner-a", portfolio.id, 1)).toMatchObject({ status: "closed", closedAt: 4_500 });
  });
});
