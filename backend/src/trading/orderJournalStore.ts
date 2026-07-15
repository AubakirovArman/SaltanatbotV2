import type { DatabaseSync } from "node:sqlite";
import type { OrderEventRecord, OrderJournalRecord } from "./types.js";

function mapOrderRows(rows: unknown[]): OrderJournalRecord[] {
  return rows.map((row) => JSON.parse((row as { data: string }).data) as OrderJournalRecord);
}

function mapEventRows(rows: unknown[]): OrderEventRecord[] {
  return rows.map((row) => {
    const typed = row as {
      id: string;
      orderId: string;
      botId: string;
      type: OrderEventRecord["type"];
      data: string;
      ts: number;
    };
    return { ...typed, data: JSON.parse(typed.data) } satisfies OrderEventRecord;
  });
}

/** The durable order identity is tenant-local: the same client id may be used by different bots. */
export function upsertOrderJournalInto(database: DatabaseSync, order: OrderJournalRecord): void {
  database.prepare(`
    INSERT INTO orders (id, botId, status, data, ts, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(botId, id) DO UPDATE SET
      status = excluded.status,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(order.id, order.botId, order.status, JSON.stringify(order), order.ts, order.updatedAt);
}

export function insertOrderEventInto(database: DatabaseSync, event: OrderEventRecord): void {
  database.prepare(`
    INSERT INTO order_events (id, orderId, botId, type, data, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(event.id, event.orderId, event.botId, event.type, JSON.stringify(event.data), event.ts);
}

export function listOrderJournalFrom(database: DatabaseSync, botId: string, limit = 200): OrderJournalRecord[] {
  return mapOrderRows(database
    .prepare("SELECT data FROM orders WHERE botId = ? ORDER BY updatedAt DESC LIMIT ?")
    .all(botId, limit));
}

export function listOrderJournalForOwnerFrom(
  database: DatabaseSync,
  ownerUserId: string,
  botId: string,
  limit = 200
): OrderJournalRecord[] {
  return mapOrderRows(database.prepare(`
    SELECT orders.data
    FROM orders
    INNER JOIN bots ON bots.id = orders.botId
    WHERE bots.ownerUserId = ? AND orders.botId = ?
    ORDER BY orders.updatedAt DESC
    LIMIT ?
  `).all(ownerUserId, botId, limit));
}

export function getOrderJournalFrom(database: DatabaseSync, botId: string, id: string): OrderJournalRecord | undefined {
  const row = database.prepare("SELECT data FROM orders WHERE botId = ? AND id = ?").get(botId, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as OrderJournalRecord) : undefined;
}

export function listOrderEventsFrom(
  database: DatabaseSync,
  botId: string,
  orderId: string,
  limit = 200
): OrderEventRecord[] {
  return mapEventRows(database.prepare(`
    SELECT id, orderId, botId, type, data, ts
    FROM order_events
    WHERE botId = ? AND orderId = ?
    ORDER BY ts ASC
    LIMIT ?
  `).all(botId, orderId, limit));
}

export function listOrderEventsForOwnerFrom(
  database: DatabaseSync,
  ownerUserId: string,
  botId: string,
  orderId: string,
  limit = 200
): OrderEventRecord[] {
  return mapEventRows(database.prepare(`
    SELECT order_events.id, order_events.orderId, order_events.botId,
      order_events.type, order_events.data, order_events.ts
    FROM order_events
    INNER JOIN bots ON bots.id = order_events.botId
    WHERE bots.ownerUserId = ? AND order_events.botId = ? AND order_events.orderId = ?
    ORDER BY order_events.ts ASC
    LIMIT ?
  `).all(ownerUserId, botId, orderId, limit));
}
