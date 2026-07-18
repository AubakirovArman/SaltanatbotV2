import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * Owner-scoped Telegram binding lifecycle shared by the web API (create code,
 * list, revoke) and the worker ingress lane (consume code, activate binding).
 *
 * Codes are 128-bit one-consume secrets returned to the owner exactly once;
 * only their sha256 is stored. Bindings hold the hashed recipient fingerprint
 * for display plus the raw chat id needed to send — the repository (not a DB
 * CHECK) enforces that an active binding always has a recipient chat id.
 *
 * Revocation fence: notification_deliveries rows reference the exact binding
 * tuple (owner, id, revision) through a NO ACTION foreign key, so the revision
 * of a binding row can never change once a delivery points at it. Revoke and
 * replace therefore fence on `expectedRevision` plus the one-way status
 * transition to 'revoked' instead of bumping the revision counter.
 */

export const BINDING_CODE_TTL_MS = 10 * 60_000;
export const BINDING_CODE_MAX_OUTSTANDING = 3;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CHAT_ID_PATTERN = /^-?[0-9]{1,63}$/;
const RECIPIENT_HANDLE_CHARS = 8;

export class BindingCodeQuotaError extends Error {}

export class BindingNotFoundError extends Error {}

export class BindingRevisionConflictError extends Error {}

export interface NotificationBindingPublic {
  readonly id: string;
  readonly status: "pending" | "active" | "revoked";
  readonly revision: number;
  readonly recipientHandle: string;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly revokedAt?: string;
}

interface BindingRow {
  id: string;
  status: "pending" | "active" | "revoked";
  revision: string | number;
  recipient_fingerprint: string;
  created_at: Date;
  activated_at: Date | null;
  revoked_at: Date | null;
}

/** Deliveries skipped because the owner had no active binding (spec counter). */
export const telegramDeliveryCounters = {
  queued: 0,
  skippedWithoutBinding: 0
};

/** sha256 hex of a raw binding code — the only stored representation. */
export function hashBindingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** sha256 hex of the chat id string — the stored recipient fingerprint. */
export function recipientFingerprint(chatId: string): string {
  return createHash("sha256").update(chatId, "utf8").digest("hex");
}

export interface CreatedBindingCode {
  readonly id: string;
  /** The raw code. Returned exactly once and never logged. */
  readonly code: string;
  readonly expiresAt: string;
}

/** Create a one-consume code; at most BINDING_CODE_MAX_OUTSTANDING live per owner. */
export async function createBindingCode(pool: Pool, ownerUserId: string): Promise<CreatedBindingCode> {
  const code = encodeBase32(randomBytes(16));
  return withTransaction(pool, async (client) => {
    // Serialize per-owner creation on the owner row so two concurrent
    // requests cannot both observe two outstanding codes and insert a fourth.
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ownerUserId]);
    const outstanding = await client.query(
      `SELECT count(*)::int AS live FROM notification_binding_codes
       WHERE owner_user_id = $1 AND consumed_at IS NULL AND expires_at > statement_timestamp()`,
      [ownerUserId]
    );
    if ((outstanding.rows[0]?.live ?? 0) >= BINDING_CODE_MAX_OUTSTANDING) {
      throw new BindingCodeQuotaError(`At most ${BINDING_CODE_MAX_OUTSTANDING} unconsumed binding codes may be outstanding.`);
    }
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO notification_binding_codes (owner_user_id, code_hash, expires_at)
       VALUES ($1, $2, statement_timestamp() + ($3::int * interval '1 millisecond'))
       RETURNING id, expires_at`,
      [ownerUserId, hashBindingCode(code), BINDING_CODE_TTL_MS]
    );
    const row = inserted.rows[0]!;
    return { id: row.id, code, expiresAt: row.expires_at.toISOString() };
  });
}

/** Owner's bindings, newest first — hashed handle only, never the chat id. */
export async function listBindings(pool: Pool, ownerUserId: string): Promise<NotificationBindingPublic[]> {
  const result = await pool.query<BindingRow>(
    `SELECT id, status, revision, recipient_fingerprint, created_at, activated_at, revoked_at
     FROM notification_bindings
     WHERE owner_user_id = $1 AND channel = 'telegram'
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [ownerUserId]
  );
  return result.rows.map(publicBinding);
}

export interface RevokeBindingInput {
  readonly ownerUserId: string;
  readonly bindingId: string;
  readonly expectedRevision: number;
}

export interface RevokeBindingResult {
  readonly binding: NotificationBindingPublic;
  readonly cancelledDeliveries: number;
}

/** Revoke one binding and cancel its queued/retrying deliveries in one transaction. */
export async function revokeBinding(pool: Pool, input: RevokeBindingInput): Promise<RevokeBindingResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<BindingRow>(
      `SELECT id, status, revision, recipient_fingerprint, created_at, activated_at, revoked_at
       FROM notification_bindings
       WHERE owner_user_id = $1 AND id = $2 AND channel = 'telegram'
       FOR UPDATE`,
      [input.ownerUserId, input.bindingId]
    );
    const current = locked.rows[0];
    if (!current) throw new BindingNotFoundError("Notification binding was not found for this owner.");
    if (safeRevision(current.revision) !== input.expectedRevision || current.status === "revoked") {
      throw new BindingRevisionConflictError("The notification binding changed. Reload bindings before revoking.");
    }
    const revoked = await client.query<BindingRow>(
      `UPDATE notification_bindings
       SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND status <> 'revoked'
       RETURNING id, status, revision, recipient_fingerprint, created_at, activated_at, revoked_at`,
      [input.ownerUserId, input.bindingId, input.expectedRevision]
    );
    if (!revoked.rows[0]) throw new BindingRevisionConflictError("The notification binding changed. Reload bindings before revoking.");
    const cancelledDeliveries = await cancelPendingDeliveries(client, input.ownerUserId, input.bindingId);
    return { binding: publicBinding(revoked.rows[0]), cancelledDeliveries };
  });
}

export type ConsumeBindingCodeResult =
  | { readonly outcome: "invalid_code" }
  | {
      readonly outcome: "activated";
      readonly ownerUserId: string;
      readonly bindingId: string;
      readonly replacedBindingId?: string;
    };

/**
 * Telegram-side one-consume activation. Runs inside the caller's ingress
 * transaction: consume the unexpired code under FOR UPDATE, replace any
 * existing active binding (single active binding per owner) and activate a
 * fresh binding for the sender's chat.
 */
export async function consumeBindingCode(client: PoolClient, rawCode: string, chatId: string): Promise<ConsumeBindingCodeResult> {
  if (!CHAT_ID_PATTERN.test(chatId)) return { outcome: "invalid_code" };
  const code = await client.query<{ id: string; owner_user_id: string }>(
    `SELECT id, owner_user_id FROM notification_binding_codes
     WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > statement_timestamp()
     FOR UPDATE`,
    [hashBindingCode(rawCode.trim())]
  );
  const codeRow = code.rows[0];
  if (!codeRow) return { outcome: "invalid_code" };
  const ownerUserId = codeRow.owner_user_id;

  const active = await client.query<{ id: string }>(
    `SELECT id FROM notification_bindings
     WHERE owner_user_id = $1 AND channel = 'telegram' AND status = 'active'
     ORDER BY id ASC
     FOR UPDATE`,
    [ownerUserId]
  );
  let replacedBindingId: string | undefined;
  for (const previous of active.rows) {
    replacedBindingId = previous.id;
    await client.query(
      `UPDATE notification_bindings
       SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE owner_user_id = $1 AND id = $2`,
      [ownerUserId, previous.id]
    );
    await cancelPendingDeliveries(client, ownerUserId, previous.id);
  }

  const bindingId = randomUUID();
  await client.query(
    `INSERT INTO notification_bindings (
       id, owner_user_id, channel, status, revision, recipient_fingerprint, recipient_chat_id,
       created_at, updated_at, activated_at
     )
     VALUES ($1, $2, 'telegram', 'active', 1, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
    [bindingId, ownerUserId, recipientFingerprint(chatId), chatId]
  );
  await client.query(
    `UPDATE notification_binding_codes
     SET consumed_at = clock_timestamp(), consumed_binding_id = $2
     WHERE id = $1`,
    [codeRow.id, bindingId]
  );
  return { outcome: "activated", ownerUserId, bindingId, ...(replacedBindingId ? { replacedBindingId } : {}) };
}

export interface QueueTelegramDeliveryInput {
  readonly ownerUserId: string;
  readonly outboxId: string;
  readonly deduplicationKey: string;
}

/**
 * Completion-path hook: queue a telegram delivery when (and only when) the
 * owner currently holds an active binding with a recipient chat id. Without
 * one the in-app delivery stands alone and the skip is counted.
 */
export async function queueTelegramDeliveryForActiveBinding(client: PoolClient, input: QueueTelegramDeliveryInput): Promise<{ queued: boolean }> {
  const binding = await client.query<{ id: string; revision: string | number }>(
    `SELECT id, revision FROM notification_bindings
     WHERE owner_user_id = $1 AND channel = 'telegram' AND status = 'active'
       AND recipient_chat_id IS NOT NULL
     ORDER BY activated_at DESC, id DESC
     LIMIT 1`,
    [input.ownerUserId]
  );
  const row = binding.rows[0];
  if (!row) {
    telegramDeliveryCounters.skippedWithoutBinding += 1;
    return { queued: false };
  }
  // Defaults supply status 'queued', attempt 0, lease_generation 0 and
  // run_after = statement_timestamp(), which together satisfy the delivery
  // CHECK fences (lease_generation = attempt, no lease while not sending).
  await client.query(
    `INSERT INTO notification_deliveries (
       id, owner_user_id, outbox_id, channel, binding_id, binding_revision, deduplication_key
     )
     VALUES ($1, $2, $3, 'telegram', $4, $5, $6)`,
    [randomUUID(), input.ownerUserId, input.outboxId, row.id, safeRevision(row.revision), input.deduplicationKey]
  );
  telegramDeliveryCounters.queued += 1;
  return { queued: true };
}

async function cancelPendingDeliveries(client: PoolClient, ownerUserId: string, bindingId: string): Promise<number> {
  const cancelled = await client.query(
    `UPDATE notification_deliveries
     SET status = 'cancelled', error_code = 'binding_revoked',
         error_message = 'The Telegram binding was revoked before this notification was sent.',
         terminal_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE owner_user_id = $1 AND binding_id = $2 AND status IN ('queued', 'retrying')`,
    [ownerUserId, bindingId]
  );
  return cancelled.rowCount ?? 0;
}

function publicBinding(row: BindingRow): NotificationBindingPublic {
  return {
    id: row.id,
    status: row.status,
    revision: safeRevision(row.revision),
    recipientHandle: row.recipient_fingerprint.slice(0, RECIPIENT_HANDLE_CHARS),
    createdAt: row.created_at.toISOString(),
    ...(row.activated_at ? { activatedAt: row.activated_at.toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {})
  };
}

function safeRevision(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Stored notification binding revision is invalid.");
  return parsed;
}

async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
