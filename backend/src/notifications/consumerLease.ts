import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * Fenced single-consumer lease over one bot's getUpdates stream.
 *
 * Telegram delivers each update to exactly one getUpdates caller, so exactly
 * one process per bot fingerprint may poll. The lease row carries a monotonic
 * `lease_generation` that increments only on takeover, a per-acquisition
 * random token, and the durable update cursor. Every mutation — renew,
 * release and cursor advance — is fenced by owner + token + generation so a
 * paused former holder can never move the cursor after a takeover.
 */

export const CONSUMER_LEASE_MS = 60_000;

export interface TelegramConsumerLease {
  readonly botFingerprint: string;
  readonly consumerId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly cursorUpdateId: number;
}

interface LeaseRow {
  lease_generation: string | number;
  cursor_update_id: string | number;
}

/** Acquire the lease when it is free, expired, or already ours; undefined when held elsewhere. */
export async function acquireConsumerLease(pool: Pool, botFingerprint: string, consumerId: string, leaseMs = CONSUMER_LEASE_MS): Promise<TelegramConsumerLease | undefined> {
  await pool.query(
    `INSERT INTO telegram_ingress_consumers (bot_fingerprint)
     VALUES ($1)
     ON CONFLICT (bot_fingerprint) DO NOTHING`,
    [botFingerprint]
  );
  const leaseToken = randomBytes(32).toString("hex");
  const acquired = await pool.query<LeaseRow>(
    `UPDATE telegram_ingress_consumers
     SET lease_generation = lease_generation + 1,
         lease_owner = $2,
         lease_token = $3,
         lease_expires_at = statement_timestamp() + ($4::int * interval '1 millisecond'),
         updated_at = statement_timestamp()
     WHERE bot_fingerprint = $1
       AND (
         lease_owner IS NULL
         OR lease_expires_at <= statement_timestamp()
         OR lease_owner = $2
       )
     RETURNING lease_generation, cursor_update_id`,
    [botFingerprint, consumerId, leaseToken, leaseMs]
  );
  const row = acquired.rows[0];
  if (!row) return undefined;
  return {
    botFingerprint,
    consumerId,
    leaseToken,
    leaseGeneration: safeNonnegative(row.lease_generation, "lease generation"),
    cursorUpdateId: safeNonnegative(row.cursor_update_id, "cursor update id")
  };
}

/** Extend our unexpired lease without changing its generation. */
export async function renewConsumerLease(pool: Pool, lease: TelegramConsumerLease, leaseMs = CONSUMER_LEASE_MS): Promise<boolean> {
  const renewed = await pool.query(
    `UPDATE telegram_ingress_consumers
     SET lease_expires_at = statement_timestamp() + ($5::int * interval '1 millisecond'),
         updated_at = statement_timestamp()
     WHERE bot_fingerprint = $1 AND lease_owner = $2 AND lease_token = $3
       AND lease_generation = $4 AND lease_expires_at > statement_timestamp()`,
    [lease.botFingerprint, lease.consumerId, lease.leaseToken, lease.leaseGeneration, leaseMs]
  );
  return (renewed.rowCount ?? 0) === 1;
}

/** Voluntarily release our lease (shutdown path); fenced like every mutation. */
export async function releaseConsumerLease(pool: Pool, lease: TelegramConsumerLease): Promise<boolean> {
  const released = await pool.query(
    `UPDATE telegram_ingress_consumers
     SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = statement_timestamp()
     WHERE bot_fingerprint = $1 AND lease_owner = $2 AND lease_token = $3 AND lease_generation = $4`,
    [lease.botFingerprint, lease.consumerId, lease.leaseToken, lease.leaseGeneration]
  );
  return (released.rowCount ?? 0) === 1;
}

/**
 * Advance the durable cursor inside the caller's batch transaction. The fence
 * requires our exact lease and forward motion only; false aborts the batch.
 */
export async function advanceConsumerCursor(client: PoolClient, lease: TelegramConsumerLease, cursorUpdateId: number): Promise<boolean> {
  if (!Number.isSafeInteger(cursorUpdateId) || cursorUpdateId < 0) {
    throw new Error("Telegram consumer cursor must be a nonnegative safe integer");
  }
  const advanced = await client.query(
    `UPDATE telegram_ingress_consumers
     SET cursor_update_id = $5, cursor_advanced_at = statement_timestamp(),
         updated_at = statement_timestamp()
     WHERE bot_fingerprint = $1 AND lease_owner = $2 AND lease_token = $3
       AND lease_generation = $4 AND lease_expires_at > statement_timestamp()
       AND cursor_update_id < $5`,
    [lease.botFingerprint, lease.consumerId, lease.leaseToken, lease.leaseGeneration, cursorUpdateId]
  );
  return (advanced.rowCount ?? 0) === 1;
}

function safeNonnegative(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Stored telegram consumer ${label} is invalid`);
  return parsed;
}
