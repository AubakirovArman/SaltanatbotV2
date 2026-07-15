import type { DatabaseSync } from "node:sqlite";
import { appendPaperEvents, type PaperLedgerEvent } from "./paperLedger.js";

interface PaperEventRow {
  id: string;
  botId: string;
  sequence: number;
  type: PaperLedgerEvent["type"];
  idempotencyKey: string | null;
  data: string;
  ts: number;
}

/** Atomically append events. Re-appending identical events is a no-op; conflicts fail closed. */
export function appendPaperLedgerEventsTo(database: DatabaseSync, events: readonly PaperLedgerEvent[]): number {
  if (events.length === 0) return 0;
  const ordered = [...events].sort((left, right) => left.botId.localeCompare(right.botId) || left.sequence - right.sequence);
  const existingById = database.prepare("SELECT id, botId, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE id = ?");
  const existingBySequence = database.prepare("SELECT id FROM paper_events WHERE botId = ? AND sequence = ?");
  const existingByKey = database.prepare("SELECT id FROM paper_events WHERE botId = ? AND idempotencyKey = ?");
  const maxSequence = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM paper_events WHERE botId = ?");
  const insert = database.prepare(`
    INSERT INTO paper_events (id, botId, sequence, type, idempotencyKey, data, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const nextByBot = new Map<string, number>();
  let inserted = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const botId of new Set(ordered.map((event) => event.botId))) {
      appendPaperEvents(
        listPaperLedgerEventsFrom(database, botId),
        ordered.filter((event) => event.botId === botId),
        botId
      );
    }
    for (const event of ordered) {
      const prior = existingById.get(event.id) as unknown as PaperEventRow | undefined;
      if (prior) {
        if (!sameStoredEvent(prior, event)) throw new Error(`Conflicting paper event id ${event.id}`);
        continue;
      }
      const atSequence = existingBySequence.get(event.botId, event.sequence) as { id: string } | undefined;
      if (atSequence) throw new Error(`Paper sequence ${event.sequence} already belongs to ${atSequence.id}`);
      if (event.idempotencyKey) {
        const atKey = existingByKey.get(event.botId, event.idempotencyKey) as { id: string } | undefined;
        if (atKey) throw new Error(`Paper idempotency key ${event.idempotencyKey} already belongs to ${atKey.id}`);
      }
      let expected = nextByBot.get(event.botId);
      if (expected === undefined) {
        const row = maxSequence.get(event.botId) as { value: number } | undefined;
        expected = Number(row?.value ?? 0) + 1;
      }
      if (event.sequence !== expected) throw new Error(`Paper ledger gap for ${event.botId}: expected ${expected}, received ${event.sequence}`);
      insert.run(event.id, event.botId, event.sequence, event.type, event.idempotencyKey ?? null, JSON.stringify(event.data), event.ts);
      nextByBot.set(event.botId, expected + 1);
      inserted += 1;
    }
    database.exec("COMMIT");
    return inserted;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listPaperLedgerEventsFrom(database: DatabaseSync, botId: string): PaperLedgerEvent[] {
  return database
    .prepare("SELECT id, botId, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE botId = ? ORDER BY sequence ASC")
    .all(botId)
    .map((raw) => {
      const row = raw as unknown as PaperEventRow;
      return {
        id: row.id,
        botId: row.botId,
        sequence: row.sequence,
        type: row.type,
        data: JSON.parse(row.data),
        ts: row.ts,
        ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {})
      } as PaperLedgerEvent;
    });
}

function sameStoredEvent(row: PaperEventRow, event: PaperLedgerEvent): boolean {
  return row.botId === event.botId
    && row.sequence === event.sequence
    && row.type === event.type
    && (row.idempotencyKey ?? undefined) === event.idempotencyKey
    && row.ts === event.ts
    && stableStringify(JSON.parse(row.data)) === stableStringify(event.data);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
