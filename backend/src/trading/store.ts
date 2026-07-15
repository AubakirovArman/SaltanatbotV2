import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_TRADING_OWNER_ID, migrateTradingStore } from "./storeSchema.js";
import { appendPaperLedgerEventsTo, listPaperLedgerEventsFrom } from "./paperLedgerStore.js";
import type { PaperLedgerEvent } from "./paperLedger.js";
import { recordBotStatusTransition, writePositionSnapshot, type PositionSnapshotRecord, type StrategyRunRecord } from "./storeLifecycle.js";
import type { AuditLogRecord, BotConfig, FillRecord, OrderEventRecord, OrderJournalRecord } from "./types.js";
import type { ArbitrageOpportunity } from "../arbitrage/types.js";
import { withResolvedBotAccountId } from "./tradingAccounts.js";
import { configureTradingAccountStore, credentialAad, normalizeOwnerUserId } from "./tradingAccountStore.js";
import { openCredentialPayload, sealCredentialPayload } from "./credentialCrypto.js";
import { assertBotCapacity } from "./resourceQuotas.js";
import { getOrderJournalFrom, insertOrderEventInto, listOrderEventsForOwnerFrom, listOrderEventsFrom, listOrderJournalForOwnerFrom, listOrderJournalFrom, upsertOrderJournalInto } from "./orderJournalStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../data");
const dbPath = path.join(dataDir, "trading.db");
const secretPath = path.join(dataDir, ".secret");

let db: DatabaseSync;
let encKey: Buffer;

export { LEGACY_TRADING_OWNER_ID } from "./storeSchema.js";
export * from "./tradingAccountStore.js";

export interface InitStoreOptions {
  /** Owner assigned to every pre-v6 trading row. Database-auth deployments
   * should pass the bootstrap/legacy administrator UUID. */
  legacyOwnerUserId?: string;
}

export function initStore(options: InitStoreOptions = {}) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  encKey = loadOrCreateSecret();
  db = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  db.exec("PRAGMA foreign_keys = ON");
  migrateTradingStore(db, Date.now, {
    legacyOwnerUserId: options.legacyOwnerUserId ?? LEGACY_TRADING_OWNER_ID,
    reencryptLegacyCredential: (payload, context) => encrypt(decrypt(payload), credentialAad(context.ownerUserId, context.accountId, context.exchange))
  });
  configureTradingAccountStore(db, {
    seal: (plain, aad) => encrypt(plain, aad),
    open: (payload, aad) => decrypt(payload, aad)
  });
  return db;
}

// ---------- bots ----------

interface BotRow {
  ownerUserId: string;
  config: string;
}

function botFromRow(row: BotRow): BotConfig {
  return {
    ...withResolvedBotAccountId(JSON.parse(row.config) as BotConfig),
    ownerUserId: row.ownerUserId
  };
}

/** Internal engine view across every owner. HTTP handlers must use
 * `listBotsForOwner` instead. */
export function listBots(): BotConfig[] {
  return db
    .prepare("SELECT ownerUserId, config FROM bots ORDER BY updatedAt DESC")
    .all()
    .map((row) => botFromRow(row as unknown as BotRow));
}

export function listBotsForOwner(ownerUserId: string): BotConfig[] {
  const owner = normalizeOwnerUserId(ownerUserId);
  return (
    db
      .prepare(`
    SELECT ownerUserId, config FROM bots
    WHERE ownerUserId = ? ORDER BY updatedAt DESC
  `)
      .all(owner) as unknown as BotRow[]
  ).map(botFromRow);
}

export function getBotForOwner(ownerUserId: string, id: string): BotConfig | undefined {
  const owner = normalizeOwnerUserId(ownerUserId);
  const row = db.prepare("SELECT ownerUserId, config FROM bots WHERE ownerUserId = ? AND id = ?").get(owner, id) as unknown as BotRow | undefined;
  return row ? botFromRow(row) : undefined;
}

export function getBotOwnerUserId(id: string): string | undefined {
  const row = db.prepare("SELECT ownerUserId FROM bots WHERE id = ?").get(id) as { ownerUserId: string } | undefined;
  return row?.ownerUserId;
}

/** Internal compatibility write. New request paths must call
 * `upsertBotForOwner` with the authenticated owner. */
export function upsertBot(bot: BotConfig) {
  const owner = bot.ownerUserId ?? getBotOwnerUserId(bot.id) ?? LEGACY_TRADING_OWNER_ID;
  return upsertBotForOwner(owner, bot);
}

export interface BotWriteOptions {
  /** Applied only when the bot id is new. Existing bots remain editable and
   * stoppable even if an operator later lowers the quota. */
  maxBots?: number;
}

export function upsertBotForOwner(ownerUserId: string, bot: BotConfig, options: BotWriteOptions = {}) {
  return upsertBotIntoForOwner(db, ownerUserId, bot, options);
}

export function upsertBotIntoForOwner(database: DatabaseSync, ownerUserId: string, bot: BotConfig, options: BotWriteOptions = {}) {
  const owner = normalizeOwnerUserId(ownerUserId);
  const ownerRow = database.prepare("SELECT ownerUserId FROM bots WHERE id = ?").get(bot.id) as { ownerUserId: string } | undefined;
  const existingOwner = ownerRow?.ownerUserId;
  if (existingOwner !== undefined && existingOwner !== owner) {
    throw new Error(`Bot ${bot.id} belongs to another owner`);
  }
  const normalized = withResolvedBotAccountId({ ...bot, ownerUserId: owner });
  database.exec("BEGIN IMMEDIATE");
  try {
    const previous = database.prepare("SELECT config FROM bots WHERE ownerUserId = ? AND id = ?").get(owner, normalized.id) as { config: string } | undefined;
    if (!previous && options.maxBots !== undefined) {
      const row = database.prepare("SELECT count(*) AS count FROM bots WHERE ownerUserId = ?").get(owner) as { count: number };
      assertBotCapacity(Number(row.count), options.maxBots);
    }
    const previousStatus = previous ? (JSON.parse(previous.config) as BotConfig).status : undefined;
    database
      .prepare(`
      INSERT INTO bots (id, ownerUserId, config, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config = excluded.config,
        updatedAt = excluded.updatedAt
      WHERE bots.ownerUserId = excluded.ownerUserId
    `)
      .run(normalized.id, owner, JSON.stringify(normalized), normalized.updatedAt);
    recordBotStatusTransition(database, normalized, previousStatus);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function deleteBot(id: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    deleteBotRecords(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function deleteBotRecords(id: string): void {
  db.prepare("DELETE FROM fills WHERE botId = ?").run(id);
  db.prepare("DELETE FROM order_events WHERE botId = ?").run(id);
  db.prepare("DELETE FROM orders WHERE botId = ?").run(id);
  db.prepare("DELETE FROM logs WHERE botId = ?").run(id);
  db.prepare("DELETE FROM positions WHERE botId = ?").run(id);
  db.prepare("DELETE FROM strategy_runs WHERE botId = ?").run(id);
  db.prepare("DELETE FROM paper_events WHERE botId = ?").run(id);
  // Drop this bot's persisted paper-sim and durable strategy state.
  db.prepare("DELETE FROM settings WHERE key = ? OR key = ?").run(`paper:${id}`, `state:${id}`);
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`inventory:${id}:%`);
  db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`futures-exposure:${id}:%`);
}

export function deleteBotForOwner(ownerUserId: string, id: string): boolean {
  const owner = normalizeOwnerUserId(ownerUserId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted = db.prepare("DELETE FROM bots WHERE ownerUserId = ? AND id = ?").run(owner, id).changes > 0;
    if (deleted) deleteBotRecords(id);
    db.exec("COMMIT");
    return deleted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Remove a single setting (e.g. resetting a bot's durable strategy state). */
export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ---------- fills (trade journal) ----------

export function insertFill(fill: FillRecord) {
  return insertFillInto(db, fill);
}

/** Fill identifiers are only unique inside one bot/tenant journal. */
export function insertFillInto(database: DatabaseSync, fill: FillRecord): boolean {
  return database
    .prepare(`
      INSERT INTO fills (id, botId, data, ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(botId, id) DO NOTHING
    `)
    .run(fill.id, fill.botId, JSON.stringify(fill), fill.ts).changes > 0;
}

/** Keep a fill and its durable order event all-or-nothing across process crashes. */
export function withStoreTransaction<T>(operation: () => T): T {
  return withDatabaseTransaction(db, operation);
}

/** Exported for an in-memory rollback proof without opening the runtime DB. */
export function withDatabaseTransaction<T>(database: Pick<DatabaseSync, "exec">, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listFills(botId: string, limit = 200): FillRecord[] {
  return db
    .prepare("SELECT data FROM fills WHERE botId = ? ORDER BY ts DESC LIMIT ?")
    .all(botId, limit)
    .map((row) => JSON.parse((row as { data: string }).data) as FillRecord);
}

export function listFillsForOwner(ownerUserId: string, botId: string, limit = 200): FillRecord[] {
  return getBotForOwner(ownerUserId, botId) ? listFills(botId, limit) : [];
}

// ---------- append-only paper-trading ledger ----------

export function appendPaperLedgerEvents(events: readonly PaperLedgerEvent[]): number {
  return appendPaperLedgerEventsTo(db, events);
}

export function listPaperLedgerEvents(botId: string): PaperLedgerEvent[] {
  return listPaperLedgerEventsFrom(db, botId);
}

// ---------- durable position snapshots ----------

export function upsertPositionSnapshot(position: PositionSnapshotRecord) {
  writePositionSnapshot(db, position);
}

export function listPositionSnapshots(botId: string): PositionSnapshotRecord[] {
  return db
    .prepare("SELECT botId, symbol, market, status, data, updatedAt FROM positions WHERE botId = ? ORDER BY updatedAt DESC")
    .all(botId)
    .map((row) => {
      const typed = row as Omit<PositionSnapshotRecord, "data" | "market" | "status"> & { market: PositionSnapshotRecord["market"]; status: PositionSnapshotRecord["status"]; data: string };
      return { ...typed, data: JSON.parse(typed.data) } satisfies PositionSnapshotRecord;
    });
}

// ---------- strategy run lifecycle ----------

export function listStrategyRuns(botId: string, limit = 200): StrategyRunRecord[] {
  return db
    .prepare("SELECT id, botId, strategyName, status, startedAt, endedAt, data FROM strategy_runs WHERE botId = ? ORDER BY startedAt DESC LIMIT ?")
    .all(botId, limit)
    .map((row) => {
      const typed = row as Omit<StrategyRunRecord, "data" | "endedAt" | "status"> & { status: StrategyRunRecord["status"]; endedAt: number | null; data: string };
      return { ...typed, endedAt: typed.endedAt ?? undefined, data: JSON.parse(typed.data) } satisfies StrategyRunRecord;
    });
}

// ---------- orders (durable lifecycle journal) ----------

export function upsertOrderJournal(order: OrderJournalRecord) {
  upsertOrderJournalInto(db, order);
}

export function insertOrderEvent(event: OrderEventRecord) {
  insertOrderEventInto(db, event);
}

export function listOrderJournal(botId: string, limit = 200): OrderJournalRecord[] {
  return listOrderJournalFrom(db, botId, limit);
}

export function listOrderJournalForOwner(ownerUserId: string, botId: string, limit = 200): OrderJournalRecord[] {
  return listOrderJournalForOwnerFrom(db, normalizeOwnerUserId(ownerUserId), botId, limit);
}

export function getOrderJournal(botId: string, id: string): OrderJournalRecord | undefined {
  return getOrderJournalFrom(db, botId, id);
}

/**
 * Orders that can still reserve live exposure. A terminal `filled` order stays
 * visible until its execution quantity has crossed the local accounting
 * boundary; an order-status acknowledgement alone is not enough to release it.
 */
export const RISK_ORDER_JOURNAL_SQL = `
      SELECT data
      FROM orders
      WHERE botId = ?
        AND json_extract(data, '$.action') IN ('neworder', 'open', 'openorders', 'spreadentry', 'turnover', 'replace')
        AND (
          status IN ('intent', 'accepted', 'partially_filled', 'unknown')
          OR (
            status IN ('filled', 'replaced')
            AND (
              json_type(data, '$.qty') IS NULL
              OR json_type(data, '$.qty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.qty') AS REAL) <= 0
              OR json_type(data, '$.accountedFilledQty') IS NULL
              OR json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) < 0
              OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != CAST(json_extract(data, '$.qty') AS REAL)
            )
          )
          OR (
            status IN ('cancelled', 'expired')
            AND (
              json_type(data, '$.qty') IS NULL
              OR json_type(data, '$.qty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.qty') AS REAL) <= 0
              OR json_type(data, '$.filledQty') IS NULL
              OR json_type(data, '$.filledQty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.filledQty') AS REAL) < 0
              OR CAST(json_extract(data, '$.filledQty') AS REAL) > CAST(json_extract(data, '$.qty') AS REAL)
              OR (
                CAST(json_extract(data, '$.filledQty') AS REAL) > 0
                AND (
                  json_type(data, '$.accountedFilledQty') IS NULL
                  OR json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
                  OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != CAST(json_extract(data, '$.filledQty') AS REAL)
                )
              )
              OR (
                CAST(json_extract(data, '$.filledQty') AS REAL) = 0
                AND json_type(data, '$.accountedFilledQty') IN ('integer', 'real')
                AND CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != 0
              )
            )
          )
          OR (
            status = 'rejected'
            AND (
              json_type(data, '$.qty') IS NULL
              OR json_type(data, '$.qty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.qty') AS REAL) <= 0
              OR (
                json_type(data, '$.filledQty') IS NOT NULL
                AND (
                  json_type(data, '$.filledQty') NOT IN ('integer', 'real')
                  OR CAST(json_extract(data, '$.filledQty') AS REAL) < 0
                  OR CAST(json_extract(data, '$.filledQty') AS REAL) > CAST(json_extract(data, '$.qty') AS REAL)
                  OR (
                    CAST(json_extract(data, '$.filledQty') AS REAL) > 0
                    AND (
                      json_type(data, '$.accountedFilledQty') IS NULL
                      OR json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
                      OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != CAST(json_extract(data, '$.filledQty') AS REAL)
                    )
                  )
                )
              )
              OR (
                json_type(data, '$.filledQty') IS NULL
                AND json_type(data, '$.accountedFilledQty') IS NOT NULL
                AND (
                  json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
                  OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != 0
                )
              )
            )
          )
        )
      ORDER BY updatedAt DESC
      LIMIT ?
    `;

export function listRiskOrderJournal(botId: string, limit = 1_001): OrderJournalRecord[] {
  return db
    .prepare(RISK_ORDER_JOURNAL_SQL)
    .all(botId, limit)
    .map((row) => JSON.parse((row as { data: string }).data) as OrderJournalRecord);
}

/**
 * Bounded recovery set for every command whose acknowledgement or execution is
 * still unresolved. Unlike the exposure-only risk query, this includes
 * reduce-only closes and protection children.
 */
export const EXECUTION_RECONCILIATION_JOURNAL_SQL = `
      SELECT data
      FROM orders
      WHERE botId = ?
        AND (
          status IN ('intent', 'accepted', 'partially_filled', 'unknown')
          OR (
            status IN ('filled', 'replaced')
            AND (
              json_type(data, '$.filledQty') IS NULL
              OR json_type(data, '$.filledQty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.filledQty') AS REAL) <= 0
              OR json_type(data, '$.accountedFilledQty') IS NULL
              OR json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != CAST(json_extract(data, '$.filledQty') AS REAL)
            )
          )
          OR (
            status IN ('cancelled', 'expired', 'rejected')
            AND json_type(data, '$.filledQty') IN ('integer', 'real')
            AND CAST(json_extract(data, '$.filledQty') AS REAL) > 0
            AND (
              json_type(data, '$.accountedFilledQty') IS NULL
              OR json_type(data, '$.accountedFilledQty') NOT IN ('integer', 'real')
              OR CAST(json_extract(data, '$.accountedFilledQty') AS REAL) != CAST(json_extract(data, '$.filledQty') AS REAL)
            )
          )
        )
      ORDER BY updatedAt DESC
      LIMIT ?
    `;

export function listExecutionReconciliationJournal(botId: string, limit = 1_001): OrderJournalRecord[] {
  return db
    .prepare(EXECUTION_RECONCILIATION_JOURNAL_SQL)
    .all(botId, limit)
    .map((row) => JSON.parse((row as { data: string }).data) as OrderJournalRecord);
}

export function listOrderEvents(botId: string, orderId: string, limit = 200): OrderEventRecord[] {
  return listOrderEventsFrom(db, botId, orderId, limit);
}

export function listOrderEventsForOwner(ownerUserId: string, botId: string, orderId: string, limit = 200): OrderEventRecord[] {
  return listOrderEventsForOwnerFrom(db, normalizeOwnerUserId(ownerUserId), botId, orderId, limit);
}

// ---------- logs ----------

export interface LogRecord {
  id?: number;
  botId: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

export function insertLog(log: LogRecord) {
  db.prepare("INSERT INTO logs (botId, level, message, ts) VALUES (?, ?, ?, ?)").run(log.botId, log.level, log.message, log.ts);
}

export function listLogs(botId: string, limit = 200): LogRecord[] {
  return db.prepare("SELECT botId, level, message, ts FROM logs WHERE botId = ? ORDER BY ts DESC LIMIT ?").all(botId, limit) as unknown as LogRecord[];
}

export function listLogsForOwner(ownerUserId: string, botId: string, limit = 200): LogRecord[] {
  return getBotForOwner(ownerUserId, botId) ? listLogs(botId, limit) : [];
}

// ---------- audit log ----------

export function insertAuditLog(record: AuditLogRecord) {
  return insertAuditLogForOwner(record.ownerUserId ?? record.actorUserId ?? LEGACY_TRADING_OWNER_ID, record);
}

export function insertAuditLogForOwner(ownerUserId: string, record: AuditLogRecord) {
  const owner = normalizeOwnerUserId(ownerUserId);
  db.prepare(`
    INSERT INTO audit_log
      (id, ownerUserId, actorUserId, actor, role, action, target, statusCode, ip, data, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.id, owner, record.actorUserId ?? null, record.actor, record.role, record.action, record.target ?? null, record.statusCode, record.ip ?? null, record.data === undefined ? null : JSON.stringify(record.data), record.ts);
}

export function listAuditLog(limit = 200): AuditLogRecord[] {
  return mapAuditRows(
    db
      .prepare(`
    SELECT id, ownerUserId, actorUserId, actor, role, action, target, statusCode, ip, data, ts
    FROM audit_log ORDER BY ts DESC LIMIT ?
  `)
      .all(limit)
  );
}

export function listAuditLogForOwner(ownerUserId: string, limit = 200): AuditLogRecord[] {
  const owner = normalizeOwnerUserId(ownerUserId);
  return mapAuditRows(
    db
      .prepare(`
    SELECT id, ownerUserId, actorUserId, actor, role, action, target, statusCode, ip, data, ts
    FROM audit_log WHERE ownerUserId = ? ORDER BY ts DESC LIMIT ?
  `)
      .all(owner, limit)
  );
}

function mapAuditRows(rows: unknown[]): AuditLogRecord[] {
  return rows.map((row) => {
    const typed = row as Omit<AuditLogRecord, "data" | "actorUserId"> & { actorUserId: string | null; data: string | null };
    return {
      ...typed,
      actorUserId: typed.actorUserId ?? undefined,
      data: typed.data ? JSON.parse(typed.data) : undefined
    } satisfies AuditLogRecord;
  });
}

// ---------- settings (exchange keys, notifications) ----------

export function getSetting<T>(key: string): T | undefined {
  const row = db.prepare("SELECT value, encrypted FROM settings WHERE key = ?").get(key) as { value: string; encrypted: number } | undefined;
  if (!row) return undefined;
  const raw = row.encrypted ? decrypt(row.value) : row.value;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: unknown, encrypted = false) {
  const serialized = JSON.stringify(value);
  const stored = encrypted ? encrypt(serialized) : serialized;
  db.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted").run(key, stored, encrypted ? 1 : 0);
}

// ---------- public arbitrage research history ----------

export interface ArbitrageHistoryRecord {
  routeId: string;
  symbol: string;
  spotExchange: "binance" | "bybit";
  futuresExchange: "binance" | "bybit";
  grossSpreadBps: number;
  topBookCapacityUsd: number;
  fundingRate: number;
  ts: number;
}

export function insertArbitrageHistory(rows: ArbitrageOpportunity[], ts: number) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO arbitrage_history
      (routeId, symbol, spotExchange, futuresExchange, grossSpreadBps, topBookCapacityUsd, fundingRate, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  withStoreTransaction(() => {
    for (const row of rows) insert.run(row.id, row.symbol, row.spotExchange, row.futuresExchange, row.grossSpreadBps, row.topBookCapacityUsd, row.fundingRate, ts);
  });
}

export function listArbitrageHistory(routeId: string, since: number, limit = 1_000): ArbitrageHistoryRecord[] {
  return db
    .prepare(`
    SELECT routeId, symbol, spotExchange, futuresExchange, grossSpreadBps, topBookCapacityUsd, fundingRate, ts
    FROM arbitrage_history WHERE routeId = ? AND ts >= ? ORDER BY ts ASC LIMIT ?
  `)
    .all(routeId, since, limit) as unknown as ArbitrageHistoryRecord[];
}

export function pruneArbitrageHistory(before: number) {
  return db.prepare("DELETE FROM arbitrage_history WHERE ts < ?").run(before).changes;
}

// ---------- encryption for API keys at rest ----------

function loadOrCreateSecret(): Buffer {
  if (existsSync(secretPath)) {
    chmodSync(secretPath, 0o600);
    return scryptSync(readFileSync(secretPath, "utf8"), "marketforge", 32);
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return scryptSync(secret, "marketforge", 32);
}

function encrypt(plain: string, aad?: string): string {
  return sealCredentialPayload(encKey, plain, aad);
}

function decrypt(payload: string, aad?: string): string {
  return openCredentialPayload(encKey, payload, aad);
}
