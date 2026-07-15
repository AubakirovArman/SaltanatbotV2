import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTradingStore, TRADING_SCHEMA_VERSION } from "../src/trading/storeSchema.js";
import { EXECUTION_RECONCILIATION_JOURNAL_SQL, RISK_ORDER_JOURNAL_SQL, withDatabaseTransaction } from "../src/trading/store.js";
import { EmergencyStopCoordinator, type EmergencyStopResult } from "../src/trading/emergencyStop.js";

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

function createV4OwnershipTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE bots (id TEXT PRIMARY KEY, config TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT, statusCode INTEGER NOT NULL, ip TEXT, data TEXT, ts INTEGER NOT NULL
    );
    PRAGMA user_version = 4;
  `);
}

function createV5OwnershipTables(database: DatabaseSync) {
  createV4OwnershipTables(database);
  database.exec(`
    CREATE TABLE trading_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
      ownership TEXT NOT NULL CHECK (ownership IN ('own', 'managed')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    PRAGMA user_version = 5;
  `);
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
        { version: 5, name: "durable_trading_account_registry" },
        { version: 6, name: "tenant_owned_trading_resources_and_credentials" }
      ]
    });
    expect(tableNames(database)).toEqual(["arbitrage_history", "audit_log", "bots", "fills", "logs", "order_events", "orders", "paper_events", "positions", "schema_migrations", "settings", "strategy_runs", "trading_account_credentials", "trading_accounts"]);
    expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 6 });
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

  it("upgrades v5 transactionally with tenant ownership", () => {
    const database = memoryDatabase();
    createV5OwnershipTables(database);
    database.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?)")
      .run("legacy-bot", JSON.stringify({ id: "legacy-bot", exchange: "paper", status: "stopped" }), 11);
    database.prepare("INSERT INTO audit_log (id, actor, role, action, statusCode, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run("audit-1", "session", "admin", "POST /bots", 200, 12);

    const result = migrateTradingStore(database, () => 20, { legacyOwnerUserId: "admin-user" });

    expect(result).toEqual({
      fromVersion: 5,
      toVersion: 6,
      applied: [{ version: 6, name: "tenant_owned_trading_resources_and_credentials" }]
    });
    expect(database.prepare("SELECT ownerUserId FROM bots WHERE id = 'legacy-bot'").get()).toEqual({ ownerUserId: "admin-user" });
    expect(database.prepare("SELECT ownerUserId FROM audit_log WHERE id = 'audit-1'").get()).toEqual({ ownerUserId: "admin-user" });
  });

  it("is idempotent after the current schema has been applied", () => {
    const database = memoryDatabase();
    migrateTradingStore(database, () => 1);
    const result = migrateTradingStore(database, () => 2);

    expect(result).toEqual({ fromVersion: 6, toVersion: 6, applied: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 6 });
  });

  it("seeds legacy exchange accounts from stored keys and backfills bot account ids", () => {
    const database = memoryDatabase();
    createV4OwnershipTables(database);
    const emergency: EmergencyStopResult = {
      operationId: "legacy-emergency",
      phase: "terminal",
      ok: true,
      flattenRequested: false,
      startedAt: 1,
      completedAt: 2,
      botsStopped: 1,
      accounts: [],
      errors: []
    };
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("keys:binance", "opaque-encrypted-value");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 0)").run("liveTradingEnabled", "true");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("notify", "encrypted-notify");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 0)").run("tradingEmergencyStop", JSON.stringify(emergency));
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)")
      .run("owner:admin-user:tradingEmergencyStop", "stale-namespaced-state");
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

    const contexts: unknown[] = [];
    const result = migrateTradingStore(database, () => 20, {
      legacyOwnerUserId: "admin-user",
      reencryptLegacyCredential(payload, context) {
        contexts.push(context);
        return `aad-bound:${payload}`;
      }
    });

    expect(result).toEqual({
      fromVersion: 4,
      toVersion: 6,
      applied: [
        { version: 5, name: "durable_trading_account_registry" },
        { version: 6, name: "tenant_owned_trading_resources_and_credentials" }
      ]
    });
    expect(database.prepare("SELECT id, ownerUserId, exchange, ownership, enabled, createdAt FROM trading_accounts").all()).toEqual([
      expect.objectContaining({ id: "binance:default", ownerUserId: "admin-user", exchange: "binance", ownership: "own", enabled: 1, createdAt: 20 })
    ]);
    expect(contexts).toEqual([{ ownerUserId: "admin-user", accountId: "binance:default", exchange: "binance" }]);
    expect(database.prepare("SELECT ownerUserId, accountId, encryptedValue FROM trading_account_credentials").get()).toEqual({
      ownerUserId: "admin-user",
      accountId: "binance:default",
      encryptedValue: "aad-bound:opaque-encrypted-value"
    });
    expect(database.prepare("SELECT key FROM settings WHERE key = 'keys:binance'").get()).toBeUndefined();
    expect(database.prepare("SELECT key FROM settings WHERE key = 'liveTradingEnabled'").get()).toBeUndefined();
    expect(database.prepare("SELECT value, encrypted FROM settings WHERE key = 'notify'").get()).toEqual({ value: "encrypted-notify", encrypted: 1 });
    expect(database.prepare("SELECT value, encrypted FROM settings WHERE key = 'owner:admin-user:notify'").get()).toEqual({ value: "encrypted-notify", encrypted: 1 });
    expect(database.prepare("SELECT key FROM settings WHERE key = 'tradingEmergencyStop'").get()).toBeUndefined();
    const emergencyKey = "owner:admin-user:tradingEmergencyStop";
    const migratedEmergency = database.prepare("SELECT value, encrypted FROM settings WHERE key = ?").get(emergencyKey) as {
      value: string;
      encrypted: number;
    };
    expect(migratedEmergency.encrypted).toBe(0);
    expect(migratedEmergency.value).toBe(JSON.stringify(emergency));
    let storedEmergency = JSON.parse(migratedEmergency.value) as EmergencyStopResult | undefined;
    const coordinator = new EmergencyStopCoordinator({
      running: () => [],
      stop: () => undefined,
      load: () => storedEmergency,
      save: (value) => { storedEmergency = structuredClone(value); },
      clear: () => {
        storedEmergency = undefined;
        database.prepare("DELETE FROM settings WHERE key = ?").run(emergencyKey);
      }
    });
    expect(() => coordinator.assertLiveStartAllowed()).toThrow(/blocked/i);
    coordinator.resetAfterTerminal();
    expect(coordinator.status()).toMatchObject({ phase: "idle", ok: true });
    expect(database.prepare("SELECT key FROM settings WHERE key = ?").get(emergencyKey)).toBeUndefined();
    const live = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = ?").get("legacy-live") as { config: string }).config));
    const paper = JSON.parse(String((database.prepare("SELECT config FROM bots WHERE id = ?").get("legacy-paper") as { config: string }).config));
    expect(live.accountId).toBe("binance:default");
    expect(paper.accountId).toBe("paper:legacy-paper");
  });

  it("rolls back ownership and preserves legacy credentials when AEAD migration fails", () => {
    const database = memoryDatabase();
    createV5OwnershipTables(database);
    database.prepare(`
      INSERT INTO trading_accounts (id, label, exchange, ownership, enabled, createdAt, updatedAt)
      VALUES ('bybit:default', 'Bybit', 'bybit', 'own', 1, 1, 1)
    `).run();
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES ('keys:bybit', 'ciphertext', 1)").run();

    expect(() => migrateTradingStore(database, () => 20, {
      legacyOwnerUserId: "admin-user",
      reencryptLegacyCredential() { throw new Error("authentication failed"); }
    })).toThrow("authentication failed");

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(database.prepare("SELECT value FROM settings WHERE key = 'keys:bybit'").get()).toEqual({ value: "ciphertext" });
    expect((database.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>).some((column) => column.name === "ownerUserId")).toBe(false);
    expect(tableNames(database)).not.toContain("trading_account_credentials");
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
