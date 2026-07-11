import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { recordBotStatusTransition, writePositionSnapshot } from "../src/trading/storeLifecycle.js";
import type { BotConfig } from "../src/trading/types.js";

const databases: DatabaseSync[] = [];

function setup() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => 1);
  return database;
}

function config(status: BotConfig["status"], updatedAt: number): BotConfig {
  return {
    id: "bot-1", name: "Bot", strategyName: "Strategy", ir: { version: 1, nodes: [] },
    symbol: "BTCUSDT", timeframe: "1m", exchange: "binance", market: "spot",
    sizeMode: "base", sizeValue: 0.25, leverage: 1, notifyMarkers: false,
    status, createdAt: 1, updatedAt,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("durable bot lifecycle records", () => {
  it("keeps one active strategy run and closes it on stop", () => {
    const database = setup();
    recordBotStatusTransition(database, config("running", 10), "stopped");
    recordBotStatusTransition(database, config("running", 11), "running");

    expect(database.prepare("SELECT COUNT(*) AS count FROM strategy_runs WHERE endedAt IS NULL").get()).toMatchObject({ count: 1 });

    recordBotStatusTransition(database, config("stopped", 20), "running");
    expect(database.prepare("SELECT status, startedAt, endedAt FROM strategy_runs").get()).toMatchObject({
      status: "stopped", startedAt: 10, endedAt: 20,
    });
  });

  it("replaces a position snapshot with the latest reconciled state", () => {
    const database = setup();
    writePositionSnapshot(database, {
      botId: "bot-1", symbol: "BTCUSDT", market: "spot", status: "open",
      data: { qty: 0.25 }, updatedAt: 10,
    });
    writePositionSnapshot(database, {
      botId: "bot-1", symbol: "BTCUSDT", market: "spot", status: "requires_manual_action",
      data: { qty: 0.25, reason: "reconcile" }, updatedAt: 20,
    });

    const row = database.prepare("SELECT status, data, updatedAt FROM positions").get() as { status: string; data: string; updatedAt: number };
    expect(row).toMatchObject({ status: "requires_manual_action", updatedAt: 20 });
    expect(JSON.parse(row.data)).toMatchObject({ qty: 0.25, reason: "reconcile" });
  });
});
