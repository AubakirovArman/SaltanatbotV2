import type { DatabaseSync } from "node:sqlite";

export const TRADING_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  sql: string;
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
    `,
  },
];

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
    throw new Error(
      `Trading database schema v${fromVersion} is newer than supported v${TRADING_SCHEMA_VERSION}; refusing to start`,
    );
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
    const record = database.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)",
    );
    for (const migration of pending) {
      database.exec(migration.sql);
      record.run(migration.version, migration.name, now());
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
