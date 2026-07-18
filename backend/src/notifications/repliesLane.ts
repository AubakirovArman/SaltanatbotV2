import type { Pool, PoolClient } from "pg";
import { TelegramApi } from "./telegramApi.js";
import { consumeSendAllowance, type TelegramSendRateLimits } from "./rateLimits.js";
import {
  TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME,
  TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
  TELEGRAM_REPLY_PURPOSE_READ
} from "./commandBridge.js";
import { issueTelegramConfirmation, type TelegramConfirmationAction } from "./confirmations.js";
import {
  formatActionApplied,
  formatAmbiguousHandle,
  formatCommandTimeout,
  formatConfirmationPrompt,
  formatHandleNotFound,
  formatRejectedCommand,
  formatSnapshotView,
  formatTradesResult,
  resolveSnapshotRobot,
  type SnapshotView
} from "./snapshotFormat.js";

/**
 * Replies lane: the second durable phase of the Telegram command flow. It
 * drains telegram_command_replies rows whose executor command reached a
 * terminal status (or aged past the reply timeout), formats the answer and
 * sends it through the shared Telegram send rate limits.
 *
 * Fencing: `replied_at` is settled in a transaction BEFORE the external send,
 * inside which the binding is re-proven (active, SAME revision, recipient
 * present) and the owner re-checked active — a revoked binding suppresses the
 * reply entirely. This makes each reply at-most-once: a crash between the
 * commit and the send drops that one message instead of ever duplicating it,
 * which for confirm-target simply lets the un-messaged token expire (the
 * sender retries the control command). The ingress cursor never waits on any
 * of this.
 */

export const TELEGRAM_REPLY_TIMEOUT_MS = 10 * 60_000;
const MAX_REPLIES_PER_SWEEP = 5;
const CANDIDATE_BATCH = 8;
const ROBOT_STATE_UNAVAILABLE_REPLY =
  "The robot state needed for this command is unavailable right now. Try again.";
const CONFIRMATION_QUOTA_REPLY =
  "You already have 3 pending confirmations. Confirm one or let them expire first.";

export interface RepliesSweepResult {
  pending: number;
  replied: number;
  timedOut: number;
  suppressed: number;
  deferred: number;
  confirmationsIssued: number;
}

interface PendingReplyRow {
  command_id: string;
  owner_user_id: string;
  binding_id: string;
  binding_revision: string | number;
  purpose: string;
  request_context: Record<string, unknown> | null;
  created_at: Date;
  status: string;
  result: Record<string, unknown> | null;
  error_code: string | null;
}

interface SendContextRow {
  binding_status: string | null;
  binding_current_revision: string | number | null;
  recipient_chat_id: string | null;
  owner_status: string | null;
  authorization_revision: string | number | null;
}

export interface TelegramRepliesLaneOptions {
  readonly api: TelegramApi;
  readonly limits: TelegramSendRateLimits;
  readonly now?: () => number;
  readonly onError?: (error: unknown, phase: string) => void;
}

export class TelegramRepliesLane {
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly options: TelegramRepliesLaneOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  /** One bounded pass; never throws (failures are reported and counted). */
  async sweep(): Promise<RepliesSweepResult> {
    const result: RepliesSweepResult = { pending: 0, replied: 0, timedOut: 0, suppressed: 0, deferred: 0, confirmationsIssued: 0 };
    try {
      const candidates = await this.pool.query<PendingReplyRow>(
        `SELECT r.command_id, r.owner_user_id, r.binding_id, r.binding_revision, r.purpose,
           r.request_context, r.created_at, c.status, c.result, c.error_code
         FROM telegram_command_replies r
         INNER JOIN executor_commands c ON c.id = r.command_id
         WHERE r.replied_at IS NULL
         ORDER BY r.created_at ASC, r.command_id ASC
         LIMIT ${CANDIDATE_BATCH}`
      );
      let settled = 0;
      for (const row of candidates.rows) {
        if (settled >= MAX_REPLIES_PER_SWEEP) break;
        const terminal = row.status === "applied" || row.status === "rejected";
        const timedOut =
          !terminal && this.now() - row.created_at.getTime() >= TELEGRAM_REPLY_TIMEOUT_MS;
        if (!terminal && !timedOut) {
          result.pending += 1;
          continue;
        }
        const proceed = await this.settleAndSend(row, timedOut, result);
        settled += 1;
        if (!proceed) break;
      }
    } catch (error) {
      this.options.onError?.(error, "replies-sweep");
    }
    return result;
  }

  /**
   * Settle one reply row durably, then send. Returns false when the sweep
   * should stop early (rate limits drained).
   */
  private async settleAndSend(row: PendingReplyRow, timedOut: boolean, result: RepliesSweepResult): Promise<boolean> {
    const client = await this.pool.connect();
    let sendTarget: { chatId: string; text: string } | undefined;
    try {
      await client.query("BEGIN");
      const context = await this.loadSendContext(client, row);
      if (!context) {
        // Binding revoked/re-bound or owner no longer active: fence the row
        // without ever sending to a stale recipient.
        const fenced = await this.markReplied(client, row.command_id);
        await client.query("COMMIT");
        if (fenced) result.suppressed += 1;
        return true;
      }
      if (!consumeSendAllowance(this.options.limits, row.owner_user_id, context.chatId, this.now())) {
        await client.query("ROLLBACK");
        result.deferred += 1;
        return false;
      }
      const text = timedOut
        ? formatCommandTimeout()
        : await this.formatReply(client, row, context, result);
      if (!(await this.markReplied(client, row.command_id))) {
        await client.query("ROLLBACK");
        return true;
      }
      await client.query("COMMIT");
      if (timedOut) result.timedOut += 1;
      else result.replied += 1;
      sendTarget = { chatId: context.chatId, text };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      this.options.onError?.(error, "replies-settle");
      return true;
    } finally {
      client.release();
    }
    try {
      await this.options.api.sendMessage(sendTarget.chatId, sendTarget.text);
    } catch (error) {
      // The durable fence already advanced; the loss of this one message is
      // the documented at-most-once trade-off.
      this.options.onError?.(error, "replies-send");
    }
    return true;
  }

  /** Re-prove binding + owner inside the settle transaction, before any send. */
  private async loadSendContext(
    client: PoolClient,
    row: PendingReplyRow
  ): Promise<{ chatId: string; authorizationRevision: number } | undefined> {
    const context = await client.query<SendContextRow>(
      `SELECT b.status AS binding_status, b.revision AS binding_current_revision,
         b.recipient_chat_id, u.status AS owner_status, u.authorization_revision
       FROM notification_bindings b
       INNER JOIN users u ON u.id = b.owner_user_id
       WHERE b.owner_user_id = $1 AND b.id = $2`,
      [row.owner_user_id, row.binding_id]
    );
    const found = context.rows[0];
    if (
      !found
      || found.binding_status !== "active"
      || found.recipient_chat_id === null
      || Number(found.binding_current_revision) !== Number(row.binding_revision)
      || found.owner_status !== "active"
    ) {
      return undefined;
    }
    const authorizationRevision = Number(found.authorization_revision);
    if (!Number.isSafeInteger(authorizationRevision) || authorizationRevision < 1) return undefined;
    return { chatId: found.recipient_chat_id, authorizationRevision };
  }

  private async formatReply(
    client: PoolClient,
    row: PendingReplyRow,
    context: { authorizationRevision: number },
    result: RepliesSweepResult
  ): Promise<string> {
    if (row.status === "rejected") return formatRejectedCommand(row.error_code);
    const requestContext = row.request_context ?? {};
    if (row.purpose === TELEGRAM_REPLY_PURPOSE_READ) {
      return typeof requestContext.command === "string" && requestContext.command === "trades"
        ? formatTradesResult(row.result)
        : formatSnapshotView(snapshotView(requestContext.command), row.result);
    }
    if (row.purpose === TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME) {
      return formatActionApplied(contextText(requestContext.action), contextText(requestContext.handle));
    }
    if (row.purpose === TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET) {
      return this.issueConfirmation(client, row, context, result);
    }
    return formatRejectedCommand(null);
  }

  /** Step 2 of the control flow: resolve the handle, pin fences, mint a token. */
  private async issueConfirmation(
    client: PoolClient,
    row: PendingReplyRow,
    context: { authorizationRevision: number },
    result: RepliesSweepResult
  ): Promise<string> {
    const requestContext = row.request_context ?? {};
    const handle = contextText(requestContext.handle);
    const action = contextText(requestContext.action);
    if (!isConfirmationAction(action)) return formatRejectedCommand(null);
    const resolution = resolveSnapshotRobot(row.result, handle);
    if (resolution.outcome === "not_found") return formatHandleNotFound(handle, resolution.robots);
    if (resolution.outcome === "ambiguous") return formatAmbiguousHandle(handle);
    const robot = resolution.robot;
    const portfolio = row.result?.["portfolio"];
    const portfolioRecord =
      portfolio && typeof portfolio === "object" && !Array.isArray(portfolio)
        ? (portfolio as Record<string, unknown>)
        : undefined;
    const portfolioId = typeof portfolioRecord?.id === "string" ? portfolioRecord.id : undefined;
    const portfolioRevision = positiveInteger(portfolioRecord?.portfolioRevision);
    const ledgerEpoch = positiveInteger(portfolioRecord?.ledgerEpoch);
    if (!portfolioId || !portfolioRevision || !ledgerEpoch || !robot.botRevision) {
      return ROBOT_STATE_UNAVAILABLE_REPLY;
    }
    const issued = await issueTelegramConfirmation(client, {
      ownerUserId: row.owner_user_id,
      bindingId: row.binding_id,
      bindingRevision: Number(row.binding_revision),
      chatFingerprint: await this.bindingChatFingerprint(client, row),
      action,
      portfolioId,
      botId: robot.fullId,
      botStatusAtIssue: robot.status,
      portfolioRevision,
      ledgerEpoch,
      botRevision: robot.botRevision,
      authorizationRevision: context.authorizationRevision
    });
    if (issued.outcome !== "issued") return CONFIRMATION_QUOTA_REPLY;
    result.confirmationsIssued += 1;
    return formatConfirmationPrompt(robot, action, issued.token, issued.expiresInSeconds);
  }

  /** The confirmation must pin the chat that will later send /confirm. */
  private async bindingChatFingerprint(client: PoolClient, row: PendingReplyRow): Promise<string> {
    const found = await client.query<{ recipient_fingerprint: string }>(
      `SELECT recipient_fingerprint FROM notification_bindings
       WHERE owner_user_id = $1 AND id = $2`,
      [row.owner_user_id, row.binding_id]
    );
    const fingerprint = found.rows[0]?.recipient_fingerprint;
    if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("Stored telegram binding recipient fingerprint is invalid");
    }
    return fingerprint;
  }

  /** True when this call won the replied_at fence. */
  private async markReplied(client: PoolClient, commandId: string): Promise<boolean> {
    const marked = await client.query(
      `UPDATE telegram_command_replies
       SET replied_at = clock_timestamp()
       WHERE command_id = $1 AND replied_at IS NULL`,
      [commandId]
    );
    return (marked.rowCount ?? 0) === 1;
  }
}

function snapshotView(value: unknown): SnapshotView {
  return value === "daily" || value === "profit" || value === "performance" ? value : "balance";
}

function contextText(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function isConfirmationAction(value: string): value is TelegramConfirmationAction {
  return value === "pause" || value === "resume" || value === "stop";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
