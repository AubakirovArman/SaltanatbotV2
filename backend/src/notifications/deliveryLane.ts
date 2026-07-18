import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseNotificationEnvelopeV1 } from "@saltanatbotv2/contracts";
import { TelegramApi, TelegramApiError, TelegramRateLimitError } from "./telegramApi.js";
import { consumeSendAllowance, peekSendAllowance, type TelegramSendRateLimits } from "./rateLimits.js";

/**
 * Telegram delivery lane: drains queued/retrying telegram rows from
 * notification_deliveries through the existing lease fence.
 *
 * A claim is one fenced UPDATE over a FOR UPDATE SKIP LOCKED candidate: it
 * moves the row to 'sending' and advances attempt together with
 * lease_generation (the schema pins lease_generation = attempt). Before the
 * external send the owner's binding is re-proven — active, same revision,
 * recipient chat present — otherwise the row cancels as binding_revoked.
 * Outcomes release the lease: delivered (provider message id receipt),
 * retrying with exponential backoff 30s*2^attempt capped at 15 minutes, or
 * dead_letter. External sends are at-least-once: a crash between sendMessage
 * and the delivered update replays the same deduplication_key after the lease
 * expires.
 */

const DELIVERY_LEASE_MS = 60_000;
const MAX_SENDS_PER_SWEEP = 5;
const CANDIDATE_BATCH = 8;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const UNIQUE_VIOLATION = "23505";
const FOOTER = "SaltanatbotV2 research/paper notification";

export interface DeliverySweepResult {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  cancelled: number;
  deferred: number;
  recoveredLeases: number;
}

interface ClaimedDelivery {
  id: string;
  owner_user_id: string;
  outbox_id: string;
  binding_id: string;
  binding_revision: string | number;
  attempt: number;
  max_attempts: number;
}

interface CandidateRow {
  id: string;
  owner_user_id: string;
  recipient_chat_id: string | null;
}

export interface TelegramDeliveryLaneOptions {
  readonly workerId: string;
  readonly api: TelegramApi;
  readonly limits: TelegramSendRateLimits;
  readonly now?: () => number;
  readonly onError?: (error: unknown, phase: string) => void;
}

export class TelegramDeliveryLane {
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly options: TelegramDeliveryLaneOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  /** One bounded pass; never throws (failures are reported and counted). */
  async sweep(): Promise<DeliverySweepResult> {
    const result: DeliverySweepResult = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, cancelled: 0, deferred: 0, recoveredLeases: 0 };
    try {
      result.recoveredLeases = await this.recoverExpiredLeases();
      while (result.claimed < MAX_SENDS_PER_SWEEP) {
        const candidate = await this.nextAllowedCandidate(result);
        if (!candidate) break;
        const sent = await this.claimAndSend(candidate, result);
        if (!sent) break;
      }
    } catch (error) {
      this.options.onError?.(error, "sweep");
    }
    return result;
  }

  /** Return expired 'sending' claims to retrying (or dead_letter at the cap). */
  private async recoverExpiredLeases(): Promise<number> {
    const recovered = await this.pool.query(
      `UPDATE notification_deliveries
       SET status = CASE WHEN attempt >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
           lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           error_code = 'telegram_lease_expired',
           error_message = 'The delivery lease expired before the send completed.',
           run_after = CASE WHEN attempt >= max_attempts THEN run_after
             ELSE statement_timestamp() + make_interval(secs => LEAST(30 * power(2, attempt), 900)) END,
           terminal_at = CASE WHEN attempt >= max_attempts THEN statement_timestamp() ELSE NULL END,
           updated_at = statement_timestamp()
       WHERE channel = 'telegram' AND status = 'sending' AND lease_expires_at <= statement_timestamp()`
    );
    return recovered.rowCount ?? 0;
  }

  /**
   * Peek due rows oldest-first and pick the first the rate limits allow now.
   * Rows without a usable binding pass through: they claim and cancel without
   * an external send, so no token is needed for them.
   */
  private async nextAllowedCandidate(result: DeliverySweepResult): Promise<CandidateRow | undefined> {
    const candidates = await this.pool.query<CandidateRow>(
      `SELECT d.id, d.owner_user_id, b.recipient_chat_id
       FROM notification_deliveries d
       LEFT JOIN notification_bindings b
         ON b.owner_user_id = d.owner_user_id AND b.id = d.binding_id AND b.revision = d.binding_revision
           AND b.status = 'active'
       WHERE d.channel = 'telegram' AND d.status IN ('queued', 'retrying')
         AND d.run_after <= statement_timestamp() AND d.attempt < d.max_attempts
       ORDER BY d.run_after ASC, d.created_at ASC, d.id ASC
       LIMIT ${CANDIDATE_BATCH}`
    );
    for (const candidate of candidates.rows) {
      if (candidate.recipient_chat_id === null) return candidate;
      if (peekSendAllowance(this.options.limits, candidate.owner_user_id, candidate.recipient_chat_id, this.now())) {
        return candidate;
      }
      result.deferred += 1;
    }
    return undefined;
  }

  /** Claim one row, prove the binding, send, and settle the outcome. */
  private async claimAndSend(candidate: CandidateRow, result: DeliverySweepResult): Promise<boolean> {
    const client = await this.pool.connect();
    let claimed: ClaimedDelivery | undefined;
    let leaseToken: string | undefined;
    let sendTarget: { chatId: string; text: string } | undefined;
    try {
      await client.query("BEGIN");
      leaseToken = randomUUID();
      claimed = await this.claim(client, candidate.id, leaseToken);
      if (!claimed) {
        // Raced by another worker or blocked by an in-flight send for the same
        // owner; end this sweep and let the next one re-read candidates.
        await client.query("ROLLBACK");
        return false;
      }
      result.claimed += 1;
      const context = await this.loadSendContext(client, claimed);
      if (!context) {
        await this.settle(client, claimed, leaseToken, {
          status: "cancelled",
          errorCode: "binding_revoked",
          errorMessage: "The Telegram binding is no longer active for this delivery."
        });
        await client.query("COMMIT");
        result.cancelled += 1;
        return true;
      }
      await client.query("COMMIT");
      sendTarget = context;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error)) return true;
      this.options.onError?.(error, "claim");
      return false;
    } finally {
      client.release();
    }

    if (!consumeSendAllowance(this.options.limits, claimed.owner_user_id, sendTarget.chatId, this.now())) {
      // The token drained between peek and claim: back the row off gently
      // without an external attempt.
      await this.finish(claimed, leaseToken, this.retryOutcome(claimed, "telegram_send_deferred", "Telegram send rate limits deferred this delivery.", 1_000), result);
      return false;
    }
    try {
      const sent = await this.options.api.sendMessage(sendTarget.chatId, sendTarget.text);
      await this.finish(claimed, leaseToken, { status: "delivered", providerReceipt: sent.messageId }, result);
      return true;
    } catch (error) {
      const outcome =
        error instanceof TelegramRateLimitError
          ? this.retryOutcome(claimed, "telegram_rate_limited", "Telegram asked this bot to slow down.", error.retryAfterMs)
          : this.retryOutcome(claimed, "telegram_send_failed", errorMessage(error));
      await this.finish(claimed, leaseToken, outcome, result);
      return !(error instanceof TelegramRateLimitError);
    }
  }

  private async claim(client: PoolClient, deliveryId: string, leaseToken: string): Promise<ClaimedDelivery | undefined> {
    const claimed = await client.query<ClaimedDelivery>(
      `UPDATE notification_deliveries d
       SET status = 'sending', attempt = d.attempt + 1, lease_generation = d.lease_generation + 1,
           lease_owner = $2, lease_token = $3::uuid, lease_acquired_at = statement_timestamp(),
           lease_expires_at = statement_timestamp() + ($4::int * interval '1 millisecond'),
           updated_at = statement_timestamp()
       FROM (
         SELECT id, owner_user_id FROM notification_deliveries
         WHERE id = $1 AND channel = 'telegram' AND status IN ('queued', 'retrying')
           AND run_after <= statement_timestamp() AND attempt < max_attempts
         FOR UPDATE SKIP LOCKED
       ) candidate
       WHERE d.id = candidate.id
         AND NOT EXISTS (
           SELECT 1 FROM notification_deliveries other
           WHERE other.owner_user_id = candidate.owner_user_id AND other.status = 'sending'
         )
       RETURNING d.id, d.owner_user_id, d.outbox_id, d.binding_id, d.binding_revision,
         d.attempt, d.max_attempts`,
      [deliveryId, this.options.workerId, leaseToken, DELIVERY_LEASE_MS]
    );
    return claimed.rows[0];
  }

  /** Re-prove the binding and build the plain-text message inside the claim transaction. */
  private async loadSendContext(client: PoolClient, claimed: ClaimedDelivery): Promise<{ chatId: string; text: string } | undefined> {
    const context = await client.query<{
      binding_status: string | null;
      binding_current_revision: string | number | null;
      recipient_chat_id: string | null;
      payload: unknown;
    }>(
      `SELECT b.status AS binding_status, b.revision AS binding_current_revision,
         b.recipient_chat_id, o.payload
       FROM notification_outbox o
       LEFT JOIN notification_bindings b
         ON b.owner_user_id = o.owner_user_id AND b.id = $3
       WHERE o.owner_user_id = $1 AND o.id = $2`,
      [claimed.owner_user_id, claimed.outbox_id, claimed.binding_id]
    );
    const row = context.rows[0];
    if (!row || row.binding_status !== "active" || row.recipient_chat_id === null) return undefined;
    if (Number(row.binding_current_revision) !== Number(claimed.binding_revision)) return undefined;
    const envelope = parseNotificationEnvelopeV1(row.payload);
    // Plain text only (no parse_mode), so envelope content can never inject markup.
    return { chatId: row.recipient_chat_id, text: `${envelope.title}\n\n${envelope.body}\n\n${FOOTER}` };
  }

  private retryOutcome(claimed: ClaimedDelivery, errorCode: string, message: string, minimumDelayMs?: number): SettleOutcome {
    if (claimed.attempt >= claimed.max_attempts) {
      return { status: "dead_letter", errorCode, errorMessage: message };
    }
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** claimed.attempt, BACKOFF_CAP_MS);
    return {
      status: "retrying",
      errorCode,
      errorMessage: message,
      runAfterMs: Math.max(backoffMs, minimumDelayMs ?? 0)
    };
  }

  private async finish(claimed: ClaimedDelivery, leaseToken: string, outcome: SettleOutcome, result: DeliverySweepResult): Promise<void> {
    try {
      await this.settle(this.pool, claimed, leaseToken, outcome);
      if (outcome.status === "delivered") result.delivered += 1;
      else if (outcome.status === "retrying") result.retried += 1;
      else if (outcome.status === "dead_letter") result.deadLettered += 1;
      else result.cancelled += 1;
    } catch (error) {
      // The lease fence recovers the row after expiry; never throw out.
      this.options.onError?.(error, "settle");
    }
  }

  private async settle(database: Pool | PoolClient, claimed: ClaimedDelivery, leaseToken: string, outcome: SettleOutcome): Promise<void> {
    const terminal = outcome.status !== "retrying";
    await database.query(
      `UPDATE notification_deliveries
       SET status = $5::varchar,
           lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           provider_receipt = $6,
           error_code = $7, error_message = $8,
           run_after = CASE WHEN $9::int IS NULL THEN run_after
             ELSE statement_timestamp() + ($9::int * interval '1 millisecond') END,
           terminal_at = CASE WHEN $10 THEN statement_timestamp() ELSE NULL END,
           delivered_at = CASE WHEN $5::varchar = 'delivered' THEN statement_timestamp() ELSE NULL END,
           updated_at = statement_timestamp()
       WHERE id = $1 AND status = 'sending' AND lease_owner = $2 AND lease_token = $3::uuid
         AND lease_generation = $4`,
      [
        claimed.id,
        this.options.workerId,
        leaseToken,
        claimed.attempt,
        outcome.status,
        outcome.status === "delivered" ? outcome.providerReceipt : null,
        outcome.status === "delivered" ? null : outcome.errorCode,
        outcome.status === "delivered" ? null : outcome.errorMessage.slice(0, 2_000),
        outcome.status === "retrying" ? Math.round(outcome.runAfterMs) : null,
        terminal
      ]
    );
  }
}

type SettleOutcome =
  | { status: "delivered"; providerReceipt: string }
  | { status: "retrying"; errorCode: string; errorMessage: string; runAfterMs: number }
  | { status: "dead_letter" | "cancelled"; errorCode: string; errorMessage: string };

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

function errorMessage(error: unknown): string {
  if (error instanceof TelegramApiError) return error.message;
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "Telegram send failed.";
}
