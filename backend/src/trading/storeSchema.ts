import type { DatabaseSync } from "node:sqlite";
import { legacyTradingAccountId, paperTradingAccountId } from "./tradingAccounts.js";
import type { TradingAccountExchange } from "./types.js";

export const TRADING_SCHEMA_VERSION = 8;
export const TRADING_TENANT_OWNERSHIP_SCHEMA_VERSION = 6;

/** Stable standalone/legacy tenant. Database-auth deployments should pass the
 * real administrator id through `legacyOwnerUserId` during first migration. */
export const LEGACY_TRADING_OWNER_ID = "legacy-operator";

export interface TradingStoreMigrationOptions {
  legacyOwnerUserId?: string;
  /** Re-encrypts a legacy settings ciphertext with per-account AEAD context.
   * Required only when a `keys:*` row exists during the v6 migration. */
  reencryptLegacyCredential?: (
    encryptedPayload: string,
    context: { ownerUserId: string; accountId: string; exchange: TradingAccountExchange }
  ) => string;
}

interface MigrationContext {
  legacyOwnerUserId: string;
  reencryptLegacyCredential?: TradingStoreMigrationOptions["reencryptLegacyCredential"];
}

interface Migration {
  version: number;
  name: string;
  sql: string;
  apply?: (database: DatabaseSync, appliedAt: number, context: MigrationContext) => void;
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
  },
  {
    version: 6,
    name: "tenant_owned_trading_resources_and_credentials",
    sql: "",
    apply: migrateTenantOwnership
  },
  {
    version: 7,
    name: "tenant_safe_execution_journal_identity",
    sql: `
      CREATE TABLE fills_v7 (
        id TEXT NOT NULL,
        botId TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (botId, id)
      );
      INSERT INTO fills_v7 (id, botId, data, ts)
        SELECT id, botId, data, ts FROM fills;
      DROP TABLE fills;
      ALTER TABLE fills_v7 RENAME TO fills;
      CREATE INDEX idx_fills_bot ON fills(botId, ts);

      CREATE TABLE orders_v7 (
        id TEXT NOT NULL,
        botId TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (botId, id)
      );
      INSERT INTO orders_v7 (id, botId, status, data, ts, updatedAt)
        SELECT id, botId, status, data, ts, updatedAt FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_v7 RENAME TO orders;
      CREATE INDEX idx_orders_bot ON orders(botId, updatedAt);

      CREATE TABLE order_events_v7 (
        id TEXT NOT NULL,
        orderId TEXT NOT NULL,
        botId TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (botId, id)
      );
      INSERT INTO order_events_v7 (id, orderId, botId, type, data, ts)
        SELECT id, orderId, botId, type, data, ts FROM order_events;
      DROP TABLE order_events;
      ALTER TABLE order_events_v7 RENAME TO order_events;
      CREATE INDEX idx_order_events_bot_order
        ON order_events(botId, orderId, ts);
    `
  },
  {
    version: 8,
    name: "execution_authority_revisions",
    sql: `
      ALTER TABLE trading_accounts
        ADD COLUMN authorizationRevision INTEGER NOT NULL DEFAULT 1
        CHECK (authorizationRevision > 0);
      ALTER TABLE trading_accounts
        ADD COLUMN credentialRevision INTEGER NOT NULL DEFAULT 0
        CHECK (credentialRevision >= 0);

      CREATE TABLE trading_owner_authority (
        ownerUserId TEXT PRIMARY KEY
          CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
        armed INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0, 1)),
        epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
        updatedAt INTEGER NOT NULL
      );
    `,
    apply: initializeExecutionAuthorityRevisions
  }
];

function initializeExecutionAuthorityRevisions(
  database: DatabaseSync,
  appliedAt: number,
  context: MigrationContext
): void {
  const owners = new Set<string>([normalizeOwnerUserId(context.legacyOwnerUserId)]);
  for (const row of database.prepare("SELECT DISTINCT ownerUserId FROM trading_accounts").all()) {
    owners.add(normalizeOwnerUserId(String(row.ownerUserId)));
  }
  for (const row of database.prepare("SELECT DISTINCT ownerUserId FROM bots").all()) {
    owners.add(normalizeOwnerUserId(String(row.ownerUserId)));
  }
  const insert = database.prepare(`
    INSERT INTO trading_owner_authority (ownerUserId, armed, epoch, updatedAt)
    VALUES (?, 0, 1, ?)
  `);
  for (const ownerUserId of owners) insert.run(ownerUserId, appliedAt);

  // A schema upgrade is a process boundary. Never carry a historical boolean
  // arm across it; every owner must explicitly re-arm under the new epoch.
  database.prepare(`
    DELETE FROM settings
    WHERE key = 'liveTradingEnabled' OR key LIKE 'owner:%:liveTradingEnabled'
  `).run();
}

function migrateTenantOwnership(database: DatabaseSync, appliedAt: number, context: MigrationContext): void {
  const ownerUserId = normalizeOwnerUserId(context.legacyOwnerUserId);

  // Make sure every legacy key/config has an account row before rebuilding the
  // registry with composite tenant identity.
  seedLegacyTradingAccountsAndBackfillBots(database, appliedAt);

  database.exec(`
    CREATE TABLE bots_v6 (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
      config TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (ownerUserId, id)
    );
    CREATE TABLE trading_accounts_v6 (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
      label TEXT NOT NULL,
      exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
      ownership TEXT NOT NULL CHECK (ownership IN ('own', 'managed')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (ownerUserId, id)
    );
    CREATE TABLE audit_log_v6 (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
      actorUserId TEXT,
      actor TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      statusCode INTEGER NOT NULL,
      ip TEXT,
      data TEXT,
      ts INTEGER NOT NULL
    );

    INSERT INTO bots_v6 (id, ownerUserId, config, updatedAt)
      SELECT id, ${sqlLiteral(ownerUserId)}, config, updatedAt FROM bots;
    INSERT INTO trading_accounts_v6
      (id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt)
      SELECT id, ${sqlLiteral(ownerUserId)}, label, exchange, ownership, enabled, createdAt, updatedAt
      FROM trading_accounts;
    INSERT INTO audit_log_v6
      (id, ownerUserId, actorUserId, actor, role, action, target, statusCode, ip, data, ts)
      SELECT id, ${sqlLiteral(ownerUserId)}, NULL, actor, role, action, target, statusCode, ip, data, ts
      FROM audit_log;

    DROP TABLE bots;
    ALTER TABLE bots_v6 RENAME TO bots;
    DROP TABLE trading_accounts;
    ALTER TABLE trading_accounts_v6 RENAME TO trading_accounts;
    DROP TABLE audit_log;
    ALTER TABLE audit_log_v6 RENAME TO audit_log;

    CREATE INDEX idx_bots_owner_updated
      ON bots(ownerUserId, updatedAt DESC);
    CREATE INDEX idx_trading_accounts_owner_exchange_enabled
      ON trading_accounts(ownerUserId, exchange, enabled, updatedAt DESC);
    CREATE INDEX idx_audit_log_owner_ts
      ON audit_log(ownerUserId, ts DESC);
    CREATE INDEX idx_audit_log_ts
      ON audit_log(ts DESC);

    UPDATE trading_accounts
      SET label = CASE exchange
        WHEN 'binance' THEN 'Binance default (migrated)'
        ELSE 'Bybit default (migrated)'
      END
      WHERE id IN ('binance:default', 'bybit:default');

    CREATE TABLE trading_account_credentials (
      ownerUserId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      encryptedValue TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (ownerUserId, accountId),
      FOREIGN KEY (ownerUserId, accountId)
        REFERENCES trading_accounts(ownerUserId, id) ON DELETE CASCADE
    );
  `);

  const legacyKeys = database.prepare(`
    SELECT key, value, encrypted FROM settings
    WHERE key IN ('keys:binance', 'keys:bybit')
    ORDER BY key
  `).all() as Array<{ key: string; value: string; encrypted: number }>;
  const insertCredential = database.prepare(`
    INSERT INTO trading_account_credentials (ownerUserId, accountId, encryptedValue, updatedAt)
    VALUES (?, ?, ?, ?)
  `);
  for (const row of legacyKeys) {
    if (row.encrypted !== 1) {
      throw new Error(`Legacy credential ${row.key} is not encrypted; refusing tenant migration`);
    }
    const exchange: TradingAccountExchange = row.key === "keys:binance" ? "binance" : "bybit";
    const accountId = legacyTradingAccountId(exchange);
    const transform = context.reencryptLegacyCredential;
    if (!transform) {
      throw new Error(`Legacy credential ${row.key} requires an AEAD re-encryption callback`);
    }
    const encryptedValue = transform(row.value, { ownerUserId, accountId, exchange });
    if (!encryptedValue.trim()) throw new Error(`Legacy credential ${row.key} re-encryption returned an empty payload`);
    insertCredential.run(ownerUserId, accountId, encryptedValue, appliedAt);
  }
  if (legacyKeys.length > 0) {
    database.prepare("DELETE FROM settings WHERE key IN ('keys:binance', 'keys:bybit')").run();
  }

  // A process restart must never inherit a server-wide live arm into the new
  // tenant model. Every owner explicitly re-arms after migration.
  database.prepare("DELETE FROM settings WHERE key = 'liveTradingEnabled'").run();

  // Preserve the legacy global row for Telegram/research compatibility while
  // seeding the new owner's isolated notification configuration.
  database.prepare(`
    INSERT OR IGNORE INTO settings (key, value, encrypted)
    SELECT ?, value, encrypted FROM settings WHERE key = 'notify'
  `).run(`owner:${ownerUserId}:notify`);

  // The emergency-stop gate is a safety lock, not a preference. Move it to
  // the migrated owner's namespace in the same transaction so a restart can
  // never silently re-enable live starts for the inherited accounts.
  database.prepare(`
    INSERT INTO settings (key, value, encrypted)
    SELECT ?, value, encrypted FROM settings WHERE key = 'tradingEmergencyStop'
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      encrypted = excluded.encrypted
  `).run(`owner:${ownerUserId}:tradingEmergencyStop`);
  database.prepare("DELETE FROM settings WHERE key = 'tradingEmergencyStop'").run();
}

function normalizeOwnerUserId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 160) {
    throw new Error("legacyOwnerUserId must contain from 1 through 160 characters");
  }
  return normalized;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

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

export function migrateTradingStore(
  database: DatabaseSync,
  now = Date.now,
  options: TradingStoreMigrationOptions = {}
): MigrationResult {
  database.exec("PRAGMA foreign_keys = ON");
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
  const context: MigrationContext = {
    legacyOwnerUserId: options.legacyOwnerUserId ?? LEGACY_TRADING_OWNER_ID,
    reencryptLegacyCredential: options.reencryptLegacyCredential
  };
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
      migration.apply?.(database, appliedAt, context);
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
