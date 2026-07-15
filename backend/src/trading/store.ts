import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateTradingStore } from "./storeSchema.js";
import { appendPaperLedgerEventsTo, listPaperLedgerEventsFrom } from "./paperLedgerStore.js";
import type { PaperLedgerEvent } from "./paperLedger.js";
import { recordBotStatusTransition, writePositionSnapshot, type PositionSnapshotRecord, type StrategyRunRecord } from "./storeLifecycle.js";
import type { AuditLogRecord, BotConfig, FillRecord, OrderEventRecord, OrderJournalRecord, TradingAccount, TradingAccountExchange } from "./types.js";
import type { ArbitrageOpportunity } from "../arbitrage/types.js";
import { botTradingAccountId, legacyTradingAccountId, withResolvedBotAccountId } from "./tradingAccounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../data");
const dbPath = path.join(dataDir, "trading.db");
const secretPath = path.join(dataDir, ".secret");

let db: DatabaseSync;
let encKey: Buffer;

export function initStore() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  encKey = loadOrCreateSecret();
  db = new DatabaseSync(dbPath);
  migrateTradingStore(db);
  return db;
}

// ---------- bots ----------

export function listBots(): BotConfig[] {
  return db
    .prepare("SELECT config FROM bots ORDER BY updatedAt DESC")
    .all()
    .map((row) => withResolvedBotAccountId(JSON.parse((row as { config: string }).config) as BotConfig));
}

export function upsertBot(bot: BotConfig) {
  const normalized = withResolvedBotAccountId(bot);
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare("SELECT config FROM bots WHERE id = ?").get(normalized.id) as { config: string } | undefined;
    const previousStatus = previous ? (JSON.parse(previous.config) as BotConfig).status : undefined;
    db.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updatedAt = excluded.updatedAt").run(normalized.id, JSON.stringify(normalized), normalized.updatedAt);
    recordBotStatusTransition(db, normalized, previousStatus);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ---------- trading account metadata (credentials remain in legacy settings) ----------

type TradingAccountRow = Omit<TradingAccount, "enabled"> & { enabled: number };

function accountFromRow(row: TradingAccountRow): TradingAccount {
  return { ...row, enabled: row.enabled === 1 };
}

export function listTradingAccounts(): TradingAccount[] {
  return listTradingAccountsFrom(db);
}

export function listTradingAccountsFrom(database: DatabaseSync): TradingAccount[] {
  return (database.prepare(`
    SELECT id, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts ORDER BY updatedAt DESC, id ASC
  `).all() as unknown as TradingAccountRow[]).map(accountFromRow);
}

export function getTradingAccount(id: string): TradingAccount | undefined {
  return getTradingAccountFrom(db, id);
}

export function getTradingAccountFrom(database: DatabaseSync, id: string): TradingAccount | undefined {
  const row = database.prepare(`
    SELECT id, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts WHERE id = ?
  `).get(id) as TradingAccountRow | undefined;
  return row ? accountFromRow(row) : undefined;
}

export function insertTradingAccount(account: TradingAccount): void {
  insertTradingAccountInto(db, account);
}

export function insertTradingAccountInto(database: DatabaseSync, account: TradingAccount): void {
  database.prepare(`
    INSERT INTO trading_accounts (id, label, exchange, ownership, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(account.id, account.label, account.exchange, account.ownership, account.enabled ? 1 : 0, account.createdAt, account.updatedAt);
}

export function updateTradingAccount(account: TradingAccount): boolean {
  return updateTradingAccountIn(db, account);
}

export function updateTradingAccountIn(database: DatabaseSync, account: TradingAccount): boolean {
  return database.prepare(`
    UPDATE trading_accounts
    SET label = ?, ownership = ?, enabled = ?, updatedAt = ?
    WHERE id = ? AND exchange = ?
  `).run(account.label, account.ownership, account.enabled ? 1 : 0, account.updatedAt, account.id, account.exchange).changes > 0;
}

export function ensureLegacyTradingAccount(exchange: TradingAccountExchange, now = Date.now()): TradingAccount {
  const id = legacyTradingAccountId(exchange);
  const existing = getTradingAccount(id);
  if (existing) return existing;
  const account: TradingAccount = {
    id,
    label: `${exchange === "binance" ? "Binance" : "Bybit"} default (shared legacy credentials)`,
    exchange,
    ownership: "own",
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  db.prepare(`
    INSERT OR IGNORE INTO trading_accounts (id, label, exchange, ownership, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(account.id, account.label, account.exchange, account.ownership, account.createdAt, account.updatedAt);
  return getTradingAccount(id) ?? account;
}

export class TradingAccountInUseError extends Error {
  constructor(readonly accountId: string, readonly botIds: readonly string[]) {
    super(`Trading account ${accountId} is used by ${botIds.length} bot(s).`);
  }
}

export function deleteTradingAccount(id: string): boolean {
  return deleteTradingAccountFrom(db, id);
}

export function deleteTradingAccountFrom(database: DatabaseSync, id: string): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const botIds = (database.prepare("SELECT config FROM bots").all() as Array<{ config: string }>)
      .map((row) => withResolvedBotAccountId(JSON.parse(row.config) as BotConfig))
      .filter((bot) => botTradingAccountId(bot) === id)
      .map((bot) => bot.id);
    if (botIds.length > 0) throw new TradingAccountInUseError(id, botIds);
    const deleted = database.prepare("DELETE FROM trading_accounts WHERE id = ?").run(id).changes > 0;
    database.exec("COMMIT");
    return deleted;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function deleteBot(id: string) {
  db.prepare("DELETE FROM bots WHERE id = ?").run(id);
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

/** Remove a single setting (e.g. resetting a bot's durable strategy state). */
export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ---------- fills (trade journal) ----------

export function insertFill(fill: FillRecord) {
  return db.prepare("INSERT OR IGNORE INTO fills (id, botId, data, ts) VALUES (?, ?, ?, ?)").run(fill.id, fill.botId, JSON.stringify(fill), fill.ts).changes > 0;
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
  db.prepare(`
    INSERT INTO orders (id, botId, status, data, ts, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(order.id, order.botId, order.status, JSON.stringify(order), order.ts, order.updatedAt);
}

export function insertOrderEvent(event: OrderEventRecord) {
  db.prepare("INSERT INTO order_events (id, orderId, botId, type, data, ts) VALUES (?, ?, ?, ?, ?, ?)").run(event.id, event.orderId, event.botId, event.type, JSON.stringify(event.data), event.ts);
}

export function listOrderJournal(botId: string, limit = 200): OrderJournalRecord[] {
  return db
    .prepare("SELECT data FROM orders WHERE botId = ? ORDER BY updatedAt DESC LIMIT ?")
    .all(botId, limit)
    .map((row) => JSON.parse((row as { data: string }).data) as OrderJournalRecord);
}

export function getOrderJournal(id: string): OrderJournalRecord | undefined {
  const row = db.prepare("SELECT data FROM orders WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as OrderJournalRecord : undefined;
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

export function listOrderEvents(orderId: string, limit = 200): OrderEventRecord[] {
  return db
    .prepare("SELECT id, orderId, botId, type, data, ts FROM order_events WHERE orderId = ? ORDER BY ts ASC LIMIT ?")
    .all(orderId, limit)
    .map((row) => {
      const typed = row as { id: string; orderId: string; botId: string; type: OrderEventRecord["type"]; data: string; ts: number };
      return { ...typed, data: JSON.parse(typed.data) } satisfies OrderEventRecord;
    });
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

// ---------- audit log ----------

export function insertAuditLog(record: AuditLogRecord) {
  db.prepare("INSERT INTO audit_log (id, actor, role, action, target, statusCode, ip, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    record.id,
    record.actor,
    record.role,
    record.action,
    record.target ?? null,
    record.statusCode,
    record.ip ?? null,
    record.data === undefined ? null : JSON.stringify(record.data),
    record.ts
  );
}

export function listAuditLog(limit = 200): AuditLogRecord[] {
  return db
    .prepare("SELECT id, actor, role, action, target, statusCode, ip, data, ts FROM audit_log ORDER BY ts DESC LIMIT ?")
    .all(limit)
    .map((row) => {
      const typed = row as Omit<AuditLogRecord, "data"> & { data: string | null };
      return { ...typed, data: typed.data ? JSON.parse(typed.data) : undefined } satisfies AuditLogRecord;
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
    return scryptSync(readFileSync(secretPath, "utf8"), "marketforge", 32);
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return scryptSync(secret, "marketforge", 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", encKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
