import type { DatabaseSync } from "node:sqlite";
import { legacyTradingAccountId, paperTradingAccountId } from "./tradingAccounts.js";
import type { TradingAccountExchange } from "./types.js";

export const TRADING_SCHEMA_VERSION = 5;

interface Migration {
  version: number;
  name: string;
  sql: string;
  apply?: (database: DatabaseSync, appliedAt: number) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_durable_trading_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fills (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_events (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL,
        botId TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        botId TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        statusCode INTEGER NOT NULL,
        ip TEXT,
        data TEXT,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_fills_bot ON fills(botId, ts);
      CREATE INDEX IF NOT EXISTS idx_orders_bot ON orders(botId, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(orderId, ts);
      CREATE INDEX IF NOT EXISTS idx_logs_bot ON logs(botId, ts);
      CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    `
  },
  {
    version: 2,
    name: "durable_positions_and_strategy_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS positions (
        botId TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (botId, symbol)
      );
      CREATE TABLE IF NOT EXISTS strategy_runs (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        strategyName TEXT NOT NULL,
        status TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(botId, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_strategy_runs_bot ON strategy_runs(botId, startedAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_runs_active
        ON strategy_runs(botId) WHERE endedAt IS NULL;
    `
  },
  {
    version: 3,
    name: "arbitrage_opportunity_history",
    sql: `
      CREATE TABLE IF NOT EXISTS arbitrage_history (
        routeId TEXT NOT NULL,
        symbol TEXT NOT NULL,
        spotExchange TEXT NOT NULL,
        futuresExchange TEXT NOT NULL,
        grossSpreadBps REAL NOT NULL,
        topBookCapacityUsd REAL NOT NULL,
        fundingRate REAL NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (routeId, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_arbitrage_history_route_ts
        ON arbitrage_history(routeId, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_arbitrage_history_ts
        ON arbitrage_history(ts);
    `
  },
  {
    version: 4,
    name: "append_only_paper_trading_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS paper_events (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        idempotencyKey TEXT,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL,
        UNIQUE (botId, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_paper_events_bot_sequence
        ON paper_events(botId, sequence ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_events_idempotency
        ON paper_events(botId, idempotencyKey) WHERE idempotencyKey IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS paper_events_no_update
        BEFORE UPDATE ON paper_events
        BEGIN
          SELECT RAISE(ABORT, 'paper_events is append-only');
        END;
    `
  },
  {
    version: 5,
    name: "durable_trading_account_registry",
    sql: `
      CREATE TABLE IF NOT EXISTS trading_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
        ownership TEXT NOT NULL CHECK (ownership IN ('own', 'managed')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trading_accounts_exchange_enabled
        ON trading_accounts(exchange, enabled, updatedAt DESC);
    `,
    apply: seedLegacyTradingAccountsAndBackfillBots
  }
];

function seedLegacyTradingAccountsAndBackfillBots(database: DatabaseSync, appliedAt: number): void {
  const exchanges = new Set<TradingAccountExchange>();
  const keyRows = database.prepare("SELECT key FROM settings WHERE key IN ('keys:binance', 'keys:bybit')").all();
  for (const row of keyRows) {
    const key = String(row.key);
    if (key === "keys:binance") exchanges.add("binance");
    if (key === "keys:bybit") exchanges.add("bybit");
  }

  const botRows = database.prepare("SELECT id, config FROM bots").all() as Array<{ id: string; config: string }>;
  const updateBot = database.prepare("UPDATE bots SET config = ? WHERE id = ?");
  for (const row of botRows) {
    try {
      const config = JSON.parse(row.config) as { id?: unknown; exchange?: unknown; accountId?: unknown };
      const exchange = config.exchange;
      if (exchange === "binance" || exchange === "bybit") exchanges.add(exchange);
      if (typeof config.accountId !== "string" || config.accountId.trim().length === 0) {
        if (exchange === "binance" || exchange === "bybit") config.accountId = legacyTradingAccountId(exchange);
        else if (exchange === "paper") config.accountId = paperTradingAccountId(typeof config.id === "string" ? config.id : row.id);
        else continue;
        updateBot.run(JSON.stringify(config), row.id);
      }
    } catch {
      // A malformed legacy bot remains untouched; normal store parsing will
      // continue to reject it rather than making up an account binding.
    }
  }

  const insert = database.prepare(`
    INSERT OR IGNORE INTO trading_accounts
      (id, label, exchange, ownership, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, 'own', 1, ?, ?)
  `);
  for (const exchange of exchanges) {
    insert.run(
      legacyTradingAccountId(exchange),
      `${exchange === "binance" ? "Binance" : "Bybit"} default (shared legacy credentials)`,
      exchange,
      appliedAt,
      appliedAt
    );
  }
}

function readUserVersion(database: DatabaseSync) {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: ReadonlyArray<{ version: number; name: string }>;
}

export function migrateTradingStore(database: DatabaseSync, now = Date.now): MigrationResult {
  const fromVersion = readUserVersion(database);
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0) {
    throw new Error(`Invalid trading database schema version: ${fromVersion}`);
  }
  if (fromVersion > TRADING_SCHEMA_VERSION) {
    throw new Error(`Trading database schema v${fromVersion} is newer than supported v${TRADING_SCHEMA_VERSION}; refusing to start`);
  }

  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) return { fromVersion, toVersion: fromVersion, applied: [] };

  const applied: Array<{ version: number; name: string }> = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        appliedAt INTEGER NOT NULL
      );
    `);
    const record = database.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)");
    for (const migration of pending) {
      const appliedAt = now();
      database.exec(migration.sql);
      migration.apply?.(database, appliedAt);
      record.run(migration.version, migration.name, appliedAt);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push({ version: migration.version, name: migration.name });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const toVersion = readUserVersion(database);
  if (toVersion !== TRADING_SCHEMA_VERSION) {
    throw new Error(`Trading database migration stopped at v${toVersion}; expected v${TRADING_SCHEMA_VERSION}`);
  }
  return { fromVersion, toVersion, applied };
}
