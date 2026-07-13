import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTradingStore, TRADING_SCHEMA_VERSION } from "../src/trading/storeSchema.js";

const databases: DatabaseSync[] = [];

function memoryDatabase() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return database;
}

function tableNames(database: DatabaseSync) {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("trading store schema migrations", () => {
  it("creates the complete versioned schema on a fresh database", () => {
    const database = memoryDatabase();
    const result = migrateTradingStore(database, () => 1_720_000_000_000);

    expect(result).toEqual({
      fromVersion: 0,
      toVersion: TRADING_SCHEMA_VERSION,
      applied: [
        { version: 1, name: "initial_durable_trading_schema" },
        { version: 2, name: "durable_positions_and_strategy_runs" },
        { version: 3, name: "arbitrage_opportunity_history" }
      ]
    });
    expect(tableNames(database)).toEqual(["arbitrage_history", "audit_log", "bots", "fills", "logs", "order_events", "orders", "positions", "schema_migrations", "settings", "strategy_runs"]);
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  });

  it("upgrades an unversioned legacy database without deleting existing records", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, config TEXT NOT NULL, updatedAt INTEGER NOT NULL)");
    database.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?)").run("legacy", "{}", 10);

    migrateTradingStore(database, () => 20);

    expect(database.prepare("SELECT id, updatedAt FROM bots").get()).toMatchObject({ id: "legacy", updatedAt: 10 });
    expect(tableNames(database)).toContain("order_events");
    expect(database.prepare("SELECT version, name, appliedAt FROM schema_migrations ORDER BY version LIMIT 1").get()).toMatchObject({
      version: 1,
      name: "initial_durable_trading_schema",
      appliedAt: 20
    });
  });

  it("upgrades v1 transactionally with durable positions and strategy runs", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 10);
    database.exec("PRAGMA user_version = 1");
    database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    database.exec("DROP TABLE strategy_runs; DROP TABLE positions");
    database.prepare("INSERT INTO fills (id, botId, data, ts) VALUES (?, ?, ?, ?)").run("fill-1", "bot", "{}", 11);

    const result = migrateTradingStore(database, () => 20);

    expect(result).toEqual({
      fromVersion: 1,
      toVersion: 3,
      applied: [
        { version: 2, name: "durable_positions_and_strategy_runs" },
        { version: 3, name: "arbitrage_opportunity_history" }
      ]
    });
    expect(tableNames(database)).toEqual(expect.arrayContaining(["positions", "strategy_runs"]));
    expect(database.prepare("SELECT id FROM fills").get()).toMatchObject({ id: "fill-1" });
  });

  it("is idempotent after the current schema has been applied", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 1);
    const result = migrateTradingStore(database, () => 2);

    expect(result).toEqual({ fromVersion: 3, toVersion: 3, applied: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 3 });
  });

  it("refuses to open a database created by a newer application version", () => {
    const database = memoryDatabase();
    database.exec(`PRAGMA user_version = ${TRADING_SCHEMA_VERSION + 1}`);

    expect(() => migrateTradingStore(database)).toThrow(/newer than supported/);
    expect(tableNames(database)).toEqual([]);
  });
});
