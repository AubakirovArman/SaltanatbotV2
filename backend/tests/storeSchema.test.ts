import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTradingStore, TRADING_SCHEMA_VERSION } from "../src/trading/storeSchema.js";
import { EXECUTION_RECONCILIATION_JOURNAL_SQL, RISK_ORDER_JOURNAL_SQL, withDatabaseTransaction } from "../src/trading/store.js";

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
        { version: 3, name: "arbitrage_opportunity_history" },
        { version: 4, name: "append_only_paper_trading_ledger" },
        { version: 5, name: "durable_trading_account_registry" }
      ]
    });
    expect(tableNames(database)).toEqual(["arbitrage_history", "audit_log", "bots", "fills", "logs", "order_events", "orders", "paper_events", "positions", "schema_migrations", "settings", "strategy_runs", "trading_accounts"]);
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 5 });
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
      toVersion: 5,
      applied: [
        { version: 2, name: "durable_positions_and_strategy_runs" },
        { version: 3, name: "arbitrage_opportunity_history" },
        { version: 4, name: "append_only_paper_trading_ledger" },
        { version: 5, name: "durable_trading_account_registry" }
      ]
    });
    expect(tableNames(database)).toEqual(expect.arrayContaining(["positions", "strategy_runs"]));
    expect(database.prepare("SELECT id FROM fills").get()).toMatchObject({ id: "fill-1" });
  });

  it("is idempotent after the current schema has been applied", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 1);
    const result = migrateTradingStore(database, () => 2);

    expect(result).toEqual({ fromVersion: 5, toVersion: 5, applied: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 5 });
  });

  it("seeds legacy exchange accounts from stored keys and backfills bot account ids", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 10);
    database.exec("PRAGMA user_version = 4");
    database.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
    database.exec("DROP TABLE trading_accounts");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("keys:binance", "opaque-encrypted-value");
    database.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?)").run(
      "legacy-live",
      JSON.stringify({ id: "legacy-live", exchange: "binance", status: "stopped" }),
      11
    );
    database.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?)").run(
      "legacy-paper",
      JSON.stringify({ id: "legacy-paper", exchange: "paper", status: "stopped" }),
      12
    );

    const result = migrateTradingStore(database, () => 20);

    expect(result).toEqual({ fromVersion: 4, toVersion: 5, applied: [{ version: 5, name: "durable_trading_account_registry" }] });
    expect(database.prepare("SELECT id, exchange, ownership, enabled, createdAt FROM trading_accounts").all()).toEqual([
      expect.objectContaining({ id: "binance:default", exchange: "binance", ownership: "own", enabled: 1, createdAt: 20 })
    ]);
    const live = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = ?").get("legacy-live") as { config: string }).config));
    const paper = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = ?").get("legacy-paper") as { config: string }).config));
    expect(live.accountId).toBe("binance:default");
    expect(paper.accountId).toBe("paper:legacy-paper");
  });

  it("enforces append-only paper events while allowing explicit bot deletion", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 10);
    database.prepare("INSERT INTO paper_events (id, botId, sequence, type, data, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run("event-1", "bot", 1, "account_initialized", "{}", 10);

    expect(() => database.prepare("UPDATE paper_events SET ts = ? WHERE id = ?").run(20, "event-1"))
      .toThrow(/append-only/);
    expect(database.prepare("DELETE FROM paper_events WHERE botId = ?").run("bot").changes).toBe(1);
  });

  it("rolls back every write when atomic execution accounting throws", () => {
    const database = memoryDatabase();
    database.exec("CREATE TABLE accounting_probe (id TEXT PRIMARY KEY)");

    expect(() => withDatabaseTransaction(database, () => {
      database.prepare("INSERT INTO accounting_probe (id) VALUES (?)").run("fill-1");
      throw new Error("journal write failed");
    })).toThrow("journal write failed");

    expect(database.prepare("SELECT COUNT(*) AS count FROM accounting_probe").get()).toMatchObject({ count: 0 });
  });

  it("selects every live-risk row except executions proven fully accounted", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 10);
    const insert = (id: string, status: string, overrides: Record<string, unknown> = {}) => {
      const data = {
        id, botId: "bot", exchange: "bybit", market: "futures", symbol: "BTCUSDT", action: "open",
        side: "buy", type: "market", qty: 2, reason: "test", status, ts: 1, updatedAt: Number(id.replace(/\D/g, "")) || 1,
        ...overrides
      };
      database.prepare("INSERT INTO orders (id, botId, status, data, ts, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, "bot", status, JSON.stringify(data), 1, data.updatedAt as number);
    };
    insert("active-1", "accepted");
    insert("filled-pending-2", "filled", { filledQty: 2 });
    insert("filled-done-3", "filled", { filledQty: 2, accountedFilledQty: 2 });
    insert("cancel-pending-4", "cancelled", { filledQty: 0.5, accountedFilledQty: 0.2 });
    insert("cancel-done-5", "cancelled", { filledQty: 0.5, accountedFilledQty: 0.5 });
    insert("reject-empty-6", "rejected");
    insert("corrupt-7", "filled", { filledQty: 2, accountedFilledQty: 3 });
    insert("replace-8", "replaced");
    insert("reject-corrupt-9", "rejected", { accountedFilledQty: 0.5 });

    const selected = database.prepare(RISK_ORDER_JOURNAL_SQL).all("bot", 100)
      .map((row) => JSON.parse(String(row.data)) as { id: string })
      .map((row) => row.id);

    expect(selected).toEqual(expect.arrayContaining(["active-1", "filled-pending-2", "cancel-pending-4", "corrupt-7", "replace-8", "reject-corrupt-9"]));
    expect(selected).not.toContain("filled-done-3");
    expect(selected).not.toContain("cancel-done-5");
    expect(selected).not.toContain("reject-empty-6");
  });

  it("selects unresolved reduce-only exits and protection children for recovery", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 10);
    const insert = (id: string, status: string, overrides: Record<string, unknown> = {}) => {
      const data = {
        id, botId: "bot", exchange: "bybit", market: "futures", symbol: "BTCUSDT", action: "close",
        side: "sell", type: "market", qty: 1, reduceOnly: true, reason: "protection", status, ts: 1, updatedAt: 1,
        ...overrides
      };
      database.prepare("INSERT INTO orders (id, botId, status, data, ts, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, "bot", status, JSON.stringify(data), 1, 1);
    };
    insert("child-active", "accepted");
    insert("close-filled-pending", "filled", { filledQty: 1 });
    insert("close-filled-done", "filled", { filledQty: 1, accountedFilledQty: 1 });
    insert("close-cancelled-partial", "cancelled", { filledQty: 0.25 });
    insert("close-cancelled-empty", "cancelled", { filledQty: 0 });

    const selected = database.prepare(EXECUTION_RECONCILIATION_JOURNAL_SQL).all("bot", 100)
      .map((row) => JSON.parse(String(row.data)) as { id: string })
      .map((row) => row.id);

    expect(selected).toEqual(expect.arrayContaining(["child-active", "close-filled-pending", "close-cancelled-partial"]));
    expect(selected).not.toContain("close-filled-done");
    expect(selected).not.toContain("close-cancelled-empty");
  });

  it("refuses to open a database created by a newer application version", () => {
    const database = memoryDatabase();
    database.exec(`PRAGMA user_version = ${TRADING_SCHEMA_VERSION + 1}`);

    expect(() => migrateTradingStore(database)).toThrow(/newer than supported/);
    expect(tableNames(database)).toEqual([]);
  });
});
