import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * One-use confirmation tokens for the two-step Telegram control flow
 * (/pause | /resume | /stop → /confirm <token>).
 *
 * A confirmation is issued by the replies lane from a terminal snapshot
 * command and pins EVERYTHING the later action must re-prove: the exact
 * binding tuple, the issuing chat fingerprint, the owner's authorization
 * revision and the optimistic paper fences (portfolio revision, ledger epoch,
 * bot revision) observed at issue time. Only the sha256 of the token is ever
 * stored; the raw token exists once, inside the reply message.
 *
 * Consumption runs inside the ingress Phase A transaction under FOR UPDATE,
 * so a replayed /confirm update or a concurrent duplicate can never turn one
 * token into two durable action commands. Mismatched attempts (wrong chat,
 * wrong owner, changed binding or authorization revision) are rejected
 * WITHOUT consuming: an outsider must not be able to burn a token they never
 * saw, and the row still dies at its 120s expiry.
 */

export const TELEGRAM_CONFIRMATION_TTL_MS = 120_000;
export const TELEGRAM_CONFIRMATION_MAX_OUTSTANDING = 3;
export const TELEGRAM_CONFIRMATION_TOKEN_BYTES = 10;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BOT_STATUS_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

export type TelegramConfirmationAction = "pause" | "resume" | "stop";

export interface IssueTelegramConfirmationInput {
  readonly ownerUserId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly chatFingerprint: string;
  readonly action: TelegramConfirmationAction;
  readonly portfolioId: string;
  readonly botId: string;
  readonly botStatusAtIssue: string | undefined;
  readonly portfolioRevision: number;
  readonly ledgerEpoch: number;
  readonly botRevision: number;
  readonly authorizationRevision: number;
}

export type IssueTelegramConfirmationResult =
  | { readonly outcome: "issued"; readonly token: string; readonly expiresInSeconds: number }
  | { readonly outcome: "quota_exceeded" };

export interface ConsumeTelegramConfirmationInput {
  readonly token: string;
  readonly updateId: number;
  readonly chatFingerprint: string;
  readonly ownerUserId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly authorizationRevision: number;
}

export interface ConsumedTelegramConfirmation {
  readonly action: TelegramConfirmationAction;
  readonly portfolioId: string;
  readonly botId: string;
  readonly portfolioRevision: number;
  readonly ledgerEpoch: number;
  readonly botRevision: number;
}

export type ConsumeTelegramConfirmationResult =
  | { readonly outcome: "consumed"; readonly confirmation: ConsumedTelegramConfirmation }
  | { readonly outcome: "rejected" };

interface ConfirmationRow {
  id: string;
  owner_user_id: string;
  binding_id: string;
  binding_revision: string | number;
  chat_fingerprint: string;
  action: string;
  portfolio_id: string;
  bot_id: string;
  portfolio_revision: string | number;
  ledger_epoch: string | number;
  bot_revision: string | number;
  authorization_revision: string | number;
}

/** sha256 hex of a raw confirmation token — the only stored representation. */
export function hashTelegramConfirmationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issue one confirmation inside the caller's transaction. The owner row lock
 * serializes concurrent issues so the ≤3-outstanding quota cannot be raced.
 */
export async function issueTelegramConfirmation(
  client: PoolClient,
  input: IssueTelegramConfirmationInput
): Promise<IssueTelegramConfirmationResult> {
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.ownerUserId]);
  const outstanding = await client.query<{ live: number }>(
    `SELECT count(*)::int AS live FROM telegram_confirmations
     WHERE owner_user_id = $1 AND consumed_at IS NULL AND expires_at > statement_timestamp()`,
    [input.ownerUserId]
  );
  if ((outstanding.rows[0]?.live ?? 0) >= TELEGRAM_CONFIRMATION_MAX_OUTSTANDING) {
    return { outcome: "quota_exceeded" };
  }
  const token = encodeBase32(randomBytes(TELEGRAM_CONFIRMATION_TOKEN_BYTES));
  const botStatus =
    input.botStatusAtIssue && BOT_STATUS_PATTERN.test(input.botStatusAtIssue)
      ? input.botStatusAtIssue
      : null;
  await client.query(
    `INSERT INTO telegram_confirmations (
       owner_user_id, binding_id, binding_revision, chat_fingerprint, action,
       portfolio_id, bot_id, bot_status_at_issue,
       portfolio_revision, ledger_epoch, bot_revision, authorization_revision,
       token_hash, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       statement_timestamp() + ($14::int * interval '1 millisecond')
     )`,
    [
      input.ownerUserId,
      input.bindingId,
      input.bindingRevision,
      input.chatFingerprint,
      input.action,
      input.portfolioId,
      input.botId,
      botStatus,
      input.portfolioRevision,
      input.ledgerEpoch,
      input.botRevision,
      input.authorizationRevision,
      hashTelegramConfirmationToken(token),
      TELEGRAM_CONFIRMATION_TTL_MS
    ]
  );
  return { outcome: "issued", token, expiresInSeconds: Math.round(TELEGRAM_CONFIRMATION_TTL_MS / 1_000) };
}

/**
 * Consume one unexpired token inside the ingress Phase A transaction. Every
 * fence is re-proven against the CURRENT resolved binding context; any
 * mismatch is one uniform rejection that leaks nothing about why.
 */
export async function consumeTelegramConfirmation(
  client: PoolClient,
  input: ConsumeTelegramConfirmationInput
): Promise<ConsumeTelegramConfirmationResult> {
  const found = await client.query<ConfirmationRow>(
    `SELECT id, owner_user_id, binding_id, binding_revision, chat_fingerprint, action,
       portfolio_id, bot_id, portfolio_revision, ledger_epoch, bot_revision,
       authorization_revision
     FROM telegram_confirmations
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > statement_timestamp()
     FOR UPDATE`,
    [hashTelegramConfirmationToken(input.token)]
  );
  const row = found.rows[0];
  if (
    !row
    || row.owner_user_id !== input.ownerUserId
    || row.binding_id !== input.bindingId
    || safePositive(row.binding_revision, "binding revision") !== input.bindingRevision
    || row.chat_fingerprint !== input.chatFingerprint
    || safePositive(row.authorization_revision, "authorization revision") !== input.authorizationRevision
    || !isConfirmationAction(row.action)
  ) {
    return { outcome: "rejected" };
  }
  await client.query(
    `UPDATE telegram_confirmations
     SET consumed_at = clock_timestamp(), consumed_update_id = $2
     WHERE id = $1`,
    [row.id, input.updateId]
  );
  return {
    outcome: "consumed",
    confirmation: {
      action: row.action,
      portfolioId: row.portfolio_id,
      botId: row.bot_id,
      portfolioRevision: safePositive(row.portfolio_revision, "portfolio revision"),
      ledgerEpoch: safePositive(row.ledger_epoch, "ledger epoch"),
      botRevision: safePositive(row.bot_revision, "bot revision")
    }
  };
}

function isConfirmationAction(value: string): value is TelegramConfirmationAction {
  return value === "pause" || value === "resume" || value === "stop";
}

function safePositive(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Stored telegram confirmation ${label} is invalid`);
  }
  return parsed;
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
