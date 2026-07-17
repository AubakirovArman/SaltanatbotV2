import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildPaperPortfolioSnapshotFrom, formatMicros } from "../src/trading/paperPortfolioProjectionStore.js";
import { PaperPortfolioReadService } from "../src/trading/paperPortfolioReadService.js";
import {
  createPaperPortfolioIn,
  releaseFlatPaperBotAllocationIn,
  reserveAndBindPaperBotIn
} from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import type { BotConfig } from "../src/trading/types.js";

const NOW = 1_800_000_000_000;
const OWNER = "portfolio-owner";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const databases: DatabaseSync[] = [];

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
    name: "Projection bot",
    strategyName: "Projection strategy",
    ir: { name: "projection", inputs: [], body: [] },
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

function createBoundFixture(value: DatabaseSync) {
  const portfolio = createPaperPortfolioIn(value, OWNER, {
    mutationId: "portfolio-create",
    idempotencyKey: "portfolio-create-key",
    requestHash: HASH_A,
    now: NOW,
    portfolioId: "portfolio-main",
    name: "Main paper portfolio",
    initialCapitalMicros: 100_000_000_000,
    makeDefault: true
  });
  const bot = upsertBotIntoForOwner(value, OWNER, paperBot("paper-bot"));
  const binding = reserveAndBindPaperBotIn(value, OWNER, {
    mutationId: "portfolio-bind",
    idempotencyKey: "portfolio-bind-key",
    requestHash: HASH_B,
    now: NOW + 1,
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId: bot.id,
    expectedBotRevision: bot.revision!,
    allocationMicros: 10_000_000_000
  });
  return { portfolio: binding.portfolio, binding };
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("paper portfolio durable projection store", () => {
  it("projects one reserved bot from immutable revision evidence and its initialized ledger", () => {
    const value = database();
    const fixture = createBoundFixture(value);
    const result = buildPaperPortfolioSnapshotFrom(value, OWNER, fixture.portfolio.id, NOW + 10);

    expect(result.portfolio).toMatchObject({
      id: "portfolio-main",
      revision: 2,
      currentEpoch: 1,
      isDefault: true
    });
    expect(result.botConfigs.get("paper-bot")).toMatchObject({
      revision: 2,
      paperPortfolioId: "portfolio-main",
      paperAllocationMicros: 10_000_000_000,
      paperLedgerEpoch: 1
    });
    expect(result.snapshot).toMatchObject({
      schemaVersion: "paper-portfolio-v1",
      formulaVersion: "paper-metrics-v1",
      ownerUserId: OWNER,
      portfolioId: "portfolio-main",
      ledgerEpoch: 1,
      aggregates: {
        initialCapital: "100000.000000",
        allocatedCapital: "10000.000000",
        unallocatedCash: "90000.000000",
        cashBalance: "100000.000000",
        reservedCapital: "10000.000000",
        availableCapital: "90000.000000"
      },
      cashConservation: {
        expectedCashBalance: "100000.000000",
        actualCashBalance: "100000.000000",
        difference: "0.000000",
        balanced: true
      }
    });
    expect(result.snapshot.robots[0]).toMatchObject({
      botId: "paper-bot",
      botRevision: 2,
      allocationStatus: "active",
      runtimeState: "idle",
      allocation: "10000.000000"
    });
  });

  it("returns released flat capital without erasing the robot ledger or reservation history", () => {
    const value = database();
    const fixture = createBoundFixture(value);
    const released = releaseFlatPaperBotAllocationIn(value, OWNER, {
      mutationId: "portfolio-release",
      idempotencyKey: "portfolio-release-key",
      requestHash: HASH_C,
      now: NOW + 2,
      portfolioId: fixture.portfolio.id,
      expectedRevision: fixture.portfolio.revision,
      expectedLedgerEpoch: fixture.portfolio.currentEpoch,
      evidence: {
        botId: fixture.binding.allocation.botId,
        botRevision: fixture.binding.allocation.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: 10_000_000_000,
        checkedAt: NOW + 2,
        source: "projection-test",
        verified: true
      }
    });
    const result = buildPaperPortfolioSnapshotFrom(value, OWNER, released.portfolio.id, NOW + 10);

    expect(result.snapshot.robots[0]).toMatchObject({
      allocationStatus: "released",
      metrics: { reservedCapital: "0.000000" }
    });
    expect(result.snapshot.aggregates).toMatchObject({
      initialCapital: "100000.000000",
      allocatedCapital: "0.000000",
      unallocatedCash: "100000.000000",
      cashBalance: "100000.000000",
      reservedCapital: "0.000000",
      availableCapital: "100000.000000"
    });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_events WHERE botId = ?").get("paper-bot"))
      .toEqual({ value: 1 });
  });

  it("never resolves another owner's portfolio and formats fixed micros without float drift", () => {
    const value = database();
    createBoundFixture(value);
    expect(() => buildPaperPortfolioSnapshotFrom(value, "another-owner", "portfolio-main", NOW + 10))
      .toThrow(/not found/i);
    expect(formatMicros(1_000_000_000_000_000)).toBe("1000000000.000000");
    expect(() => formatMicros(1_000_000_000_000_001)).toThrow(/bounds/i);
  });

  it("adds owner-scoped runtime status and the latest durable error without changing metrics", () => {
    const value = database();
    createBoundFixture(value);
    value.prepare("INSERT INTO logs (botId, level, message, ts) VALUES (?, 'error', ?, ?)")
      .run("paper-bot", "Feed unavailable", NOW + 5);
    const service = new PaperPortfolioReadService(value, {
      isRunning: (owner, botId) => owner === OWNER && botId === "paper-bot",
      isPaused: (owner, botId) => owner === OWNER && botId === "paper-bot"
    });

    expect(service.list(OWNER, NOW + 10)).toMatchObject({
      schemaVersion: "paper-portfolio-list-v1",
      asOf: NOW + 10,
      portfolios: [{ id: "portfolio-main", ownerUserId: OWNER }]
    });
    expect(service.detail(OWNER, "portfolio-main", NOW + 10)).toMatchObject({
      portfolio: { id: "portfolio-main" },
      robots: [{
        botId: "paper-bot",
        botRevision: 2,
        name: "Projection bot",
        strategyName: "Projection strategy",
        symbol: "BTCUSDT",
        status: "paused",
        lastError: "Feed unavailable"
      }],
      lastError: "Feed unavailable",
      snapshot: {
        aggregates: {
          cashBalance: "100000.000000",
          reservedCapital: "10000.000000"
        }
      }
    });
  });
});
