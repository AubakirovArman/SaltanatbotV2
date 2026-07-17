import type { DatabaseSync } from "node:sqlite";
import { appendPaperEvents, type PaperLedgerEvent } from "./paperLedger.js";

interface PaperEventRow {
  id: string;
  botId: string;
  ledgerEpoch: number;
  sequence: number;
  type: PaperLedgerEvent["type"];
  idempotencyKey: string | null;
  data: string;
  ts: number;
}

/** Atomically append events. Re-appending identical events is a no-op; conflicts fail closed. */
export function appendPaperLedgerEventsTo(database: DatabaseSync, events: readonly PaperLedgerEvent[]): number {
  if (events.length === 0) return 0;
  const ordered = [...events].sort((left, right) => (
    left.botId.localeCompare(right.botId)
    || left.ledgerEpoch - right.ledgerEpoch
    || left.sequence - right.sequence
  ));
  const existingById = database.prepare("SELECT id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE id = ?");
  const existingBySequence = database.prepare("SELECT id FROM paper_events WHERE botId = ? AND ledgerEpoch = ? AND sequence = ?");
  const existingByKey = database.prepare("SELECT id FROM paper_events WHERE botId = ? AND ledgerEpoch = ? AND idempotencyKey = ?");
  const maxSequence = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM paper_events WHERE botId = ? AND ledgerEpoch = ?");
  const insert = database.prepare(`
    INSERT INTO paper_events (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nextByLedger = new Map<string, number>();
  let inserted = 0;
  const ownsTransaction = !database.isTransaction;
  if (ownsTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    const ledgers = new Map<string, { botId: string; ledgerEpoch: number }>();
    for (const event of ordered) {
      ledgers.set(ledgerKey(event.botId, event.ledgerEpoch), {
        botId: event.botId,
        ledgerEpoch: event.ledgerEpoch
      });
    }
    for (const { botId, ledgerEpoch } of ledgers.values()) {
      appendPaperEvents(
        listPaperLedgerEventsFrom(database, botId, ledgerEpoch),
        ordered.filter((event) => event.botId === botId && event.ledgerEpoch === ledgerEpoch),
        botId,
        ledgerEpoch
      );
    }
    for (const event of ordered) {
      const prior = existingById.get(event.id) as unknown as PaperEventRow | undefined;
      if (prior) {
        if (!sameStoredEvent(prior, event)) throw new Error(`Conflicting paper event id ${event.id}`);
        continue;
      }
      const atSequence = existingBySequence.get(event.botId, event.ledgerEpoch, event.sequence) as { id: string } | undefined;
      if (atSequence) throw new Error(`Paper sequence ${event.sequence} already belongs to ${atSequence.id}`);
      if (event.idempotencyKey) {
        const atKey = existingByKey.get(event.botId, event.ledgerEpoch, event.idempotencyKey) as { id: string } | undefined;
        if (atKey) throw new Error(`Paper idempotency key ${event.idempotencyKey} already belongs to ${atKey.id}`);
      }
      const key = ledgerKey(event.botId, event.ledgerEpoch);
      let expected = nextByLedger.get(key);
      if (expected === undefined) {
        const row = maxSequence.get(event.botId, event.ledgerEpoch) as { value: number } | undefined;
        expected = Number(row?.value ?? 0) + 1;
      }
      if (event.sequence !== expected) throw new Error(`Paper ledger gap for ${event.botId}: expected ${expected}, received ${event.sequence}`);
      insert.run(event.id, event.botId, event.ledgerEpoch, event.sequence, event.type, event.idempotencyKey ?? null, JSON.stringify(event.data), event.ts);
      nextByLedger.set(key, expected + 1);
      inserted += 1;
    }
    if (ownsTransaction) database.exec("COMMIT");
    return inserted;
  } catch (error) {
    if (ownsTransaction && database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function listPaperLedgerEventsFrom(
  database: DatabaseSync,
  botId: string,
  ledgerEpoch = 1
): PaperLedgerEvent[] {
  return database
    .prepare("SELECT id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts FROM paper_events WHERE botId = ? AND ledgerEpoch = ? ORDER BY sequence ASC")
    .all(botId, ledgerEpoch)
    .map((raw) => {
      const row = raw as unknown as PaperEventRow;
      return {
        id: row.id,
        botId: row.botId,
        ledgerEpoch: row.ledgerEpoch,
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
    && row.ledgerEpoch === event.ledgerEpoch
    && row.sequence === event.sequence
    && row.type === event.type
    && (row.idempotencyKey ?? undefined) === event.idempotencyKey
    && row.ts === event.ts
    && stableStringify(JSON.parse(row.data)) === stableStringify(event.data);
}

function ledgerKey(botId: string, ledgerEpoch: number): string {
  return `${botId}\u0000${ledgerEpoch}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
