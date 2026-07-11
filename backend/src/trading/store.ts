import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateTradingStore } from "./storeSchema.js";
import type { AuditLogRecord, BotConfig, FillRecord, OrderEventRecord, OrderJournalRecord } from "./types.js";

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
    .map((row) => JSON.parse((row as { config: string }).config) as BotConfig);
}

export function upsertBot(bot: BotConfig) {
  db.prepare("INSERT INTO bots (id, config, updatedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updatedAt = excluded.updatedAt")
    .run(bot.id, JSON.stringify(bot), bot.updatedAt);
}

export function deleteBot(id: string) {
  db.prepare("DELETE FROM bots WHERE id = ?").run(id);
  db.prepare("DELETE FROM fills WHERE botId = ?").run(id);
  db.prepare("DELETE FROM order_events WHERE botId = ?").run(id);
  db.prepare("DELETE FROM orders WHERE botId = ?").run(id);
  db.prepare("DELETE FROM logs WHERE botId = ?").run(id);
  // Drop this bot's persisted paper-sim and durable strategy state.
  db.prepare("DELETE FROM settings WHERE key = ? OR key = ?").run(`paper:${id}`, `state:${id}`);
}

/** Remove a single setting (e.g. resetting a bot's durable strategy state). */
export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ---------- fills (trade journal) ----------

export function insertFill(fill: FillRecord) {
  return db.prepare("INSERT OR IGNORE INTO fills (id, botId, data, ts) VALUES (?, ?, ?, ?)")
    .run(fill.id, fill.botId, JSON.stringify(fill), fill.ts).changes > 0;
}

/** Keep a fill and its durable order event all-or-nothing across process crashes. */
export function withStoreTransaction<T>(operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listFills(botId: string, limit = 200): FillRecord[] {
  return db
    .prepare("SELECT data FROM fills WHERE botId = ? ORDER BY ts DESC LIMIT ?")
    .all(botId, limit)
    .map((row) => JSON.parse((row as { data: string }).data) as FillRecord);
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
  db.prepare("INSERT INTO order_events (id, orderId, botId, type, data, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(event.id, event.orderId, event.botId, event.type, JSON.stringify(event.data), event.ts);
}

export function listOrderJournal(botId: string, limit = 200): OrderJournalRecord[] {
  return db
    .prepare("SELECT data FROM orders WHERE botId = ? ORDER BY updatedAt DESC LIMIT ?")
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
  db.prepare("INSERT INTO logs (botId, level, message, ts) VALUES (?, ?, ?, ?)")
    .run(log.botId, log.level, log.message, log.ts);
}

export function listLogs(botId: string, limit = 200): LogRecord[] {
  return db
    .prepare("SELECT botId, level, message, ts FROM logs WHERE botId = ? ORDER BY ts DESC LIMIT ?")
    .all(botId, limit) as unknown as LogRecord[];
}

// ---------- audit log ----------

export function insertAuditLog(record: AuditLogRecord) {
  db.prepare("INSERT INTO audit_log (id, actor, role, action, target, statusCode, ip, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(record.id, record.actor, record.role, record.action, record.target ?? null, record.statusCode, record.ip ?? null, record.data === undefined ? null : JSON.stringify(record.data), record.ts);
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
  const row = db.prepare("SELECT value, encrypted FROM settings WHERE key = ?").get(key) as
    | { value: string; encrypted: number }
    | undefined;
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
  db.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted")
    .run(key, stored, encrypted ? 1 : 0);
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
