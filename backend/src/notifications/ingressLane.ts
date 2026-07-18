import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { consumeBindingCode } from "./bindingService.js";
import {
  acquireConsumerLease,
  advanceConsumerCursor,
  releaseConsumerLease,
  renewConsumerLease,
  type TelegramConsumerLease
} from "./consumerLease.js";
import { TelegramApi, type TelegramUpdateEnvelope } from "./telegramApi.js";
import type { TelegramIngressRateLimits } from "./rateLimits.js";

/**
 * Ingress lane: the single fenced consumer of one bot's getUpdates stream.
 *
 * Each sweep renews (or re-acquires) the consumer lease, long-polls from the
 * durable cursor and settles the whole batch in ONE transaction: normalized
 * telegram_updates rows (hashed chat fingerprints only — never text or raw
 * chat ids), binding activations, and the fenced cursor advance. A crash
 * before commit replays the batch and the (bot, update_id) primary key makes
 * every replayed update a no-op; a crash after commit skips it via the
 * cursor. Replies go out only after the commit.
 *
 * Command surface is deliberately R5.3b-1-small: `/start <code>` and
 * `/bind <code>` consume a one-use binding code; everything else in a private
 * chat gets the static R5.3b-2 notice. Group and non-message updates are
 * recorded as ignored.
 */

const STATIC_REPLY = "Commands arrive in R5.3b-2; this bot currently delivers research/paper notifications only.";
const ACTIVATED_REPLY = "Telegram notifications are now bound to your SaltanatbotV2 account. This bot sends research/paper notifications only.";
const INVALID_CODE_REPLY = "That binding code is invalid, expired or already used. Create a fresh code in the SaltanatbotV2 alerts panel.";
const BIND_COMMAND_PATTERN = /^\/(?:start|bind)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;
const CODE_ARGUMENT_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const CHAT_ID_PATTERN = /^-?[0-9]{1,63}$/;

export interface IngressSweepResult {
  held: boolean;
  polled: number;
  recorded: number;
  replayed: number;
  activated: number;
  invalidCodes: number;
  rateLimited: number;
  replied: number;
  ignored: number;
}

interface ClassifiedUpdate {
  readonly updateId: number;
  readonly kind: "bind_command" | "help_command" | "other_message" | "group_message" | "non_message";
  readonly chatId?: string;
  readonly chatFingerprint?: string;
  readonly codeArgument?: string;
}

export interface TelegramIngressLaneOptions {
  readonly workerId: string;
  readonly api: TelegramApi;
  readonly botFingerprint: string;
  readonly limits: TelegramIngressRateLimits;
  readonly now?: () => number;
  readonly onError?: (error: unknown, phase: string) => void;
}

export class TelegramIngressLane {
  private lease: TelegramConsumerLease | undefined;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly options: TelegramIngressLaneOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * One lease-fenced long-poll cycle. Throws Telegram/database errors so the
   * worker loop applies its capped backoff; `held: false` means another
   * consumer owns the stream and the caller should just wait.
   */
  async sweep(): Promise<IngressSweepResult> {
    const result: IngressSweepResult = { held: false, polled: 0, recorded: 0, replayed: 0, activated: 0, invalidCodes: 0, rateLimited: 0, replied: 0, ignored: 0 };
    if (!(await this.ensureLease())) return result;
    result.held = true;
    const lease = this.lease!;
    const updates = await this.options.api.getUpdates(lease.cursorUpdateId + 1);
    result.polled = updates.length;
    if (updates.length === 0) return result;

    const replies = await this.processBatch(lease, updates, result);
    for (const reply of replies) {
      try {
        await this.options.api.sendMessage(reply.chatId, reply.text);
      } catch (error) {
        // Replies are best-effort: the batch is already durable.
        this.options.onError?.(error, "reply");
      }
    }
    return result;
  }

  /** Voluntary shutdown release so a successor can take over immediately. */
  async release(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    if (!lease) return;
    try {
      await releaseConsumerLease(this.pool, lease);
    } catch (error) {
      this.options.onError?.(error, "release");
    }
  }

  private async ensureLease(): Promise<boolean> {
    if (this.lease && (await renewConsumerLease(this.pool, this.lease))) return true;
    this.lease = await acquireConsumerLease(this.pool, this.options.botFingerprint, this.options.workerId);
    return this.lease !== undefined;
  }

  /** Settle updates rows + binding effects + cursor advance in one transaction. */
  private async processBatch(lease: TelegramConsumerLease, updates: TelegramUpdateEnvelope[], result: IngressSweepResult): Promise<Array<{ chatId: string; text: string }>> {
    const replies: Array<{ chatId: string; text: string }> = [];
    const cursorTarget = Math.max(lease.cursorUpdateId, ...updates.map((update) => update.update_id));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const update of updates) {
        const classified = classifyUpdate(update);
        const reply = await this.processUpdate(client, classified, result);
        if (reply && classified.chatId) replies.push({ chatId: classified.chatId, text: reply });
      }
      if (!(await advanceConsumerCursor(client, lease, cursorTarget))) {
        // Fence lost mid-batch: another consumer took over. Abort everything.
        await client.query("ROLLBACK");
        this.lease = undefined;
        result.held = false;
        return [];
      }
      await client.query("COMMIT");
      this.lease = { ...lease, cursorUpdateId: cursorTarget };
      return replies;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Record one normalized update; returns the reply text when one is due. */
  private async processUpdate(client: PoolClient, update: ClassifiedUpdate, result: IngressSweepResult): Promise<string | undefined> {
    if (update.kind === "non_message" || update.kind === "group_message") {
      const recorded = await this.recordUpdate(client, update, "ignored");
      if (recorded) result.ignored += 1;
      else result.replayed += 1;
      return undefined;
    }

    // Insert first with a provisional outcome so a replayed update is a
    // no-op before any limiter or binding side effect runs.
    const recorded = await this.recordUpdate(client, update, "received");
    if (!recorded) {
      result.replayed += 1;
      return undefined;
    }
    const outcome = await this.handlePrivateMessage(client, update, result);
    await client.query(
      `UPDATE telegram_updates SET outcome = $3 WHERE bot_fingerprint = $1 AND update_id = $2`,
      [this.options.botFingerprint, update.updateId, outcome.outcome]
    );
    return outcome.reply;
  }

  private async handlePrivateMessage(client: PoolClient, update: ClassifiedUpdate, result: IngressSweepResult): Promise<{ outcome: string; reply?: string }> {
    const chatKey = update.chatFingerprint!;
    if (this.options.limits.perChatCommands.attempt(chatKey, this.now()) !== undefined) {
      result.rateLimited += 1;
      return { outcome: "rate_limited" };
    }
    if (update.kind !== "bind_command") {
      result.replied += 1;
      return { outcome: "replied", reply: STATIC_REPLY };
    }
    if (this.options.limits.bindingAttempts.attempt(chatKey, this.now()) !== undefined) {
      result.rateLimited += 1;
      return { outcome: "rate_limited" };
    }
    if (!update.codeArgument || !update.chatId) {
      result.invalidCodes += 1;
      return { outcome: "invalid_code", reply: INVALID_CODE_REPLY };
    }
    const consumed = await consumeBindingCode(client, update.codeArgument, update.chatId);
    if (consumed.outcome !== "activated") {
      result.invalidCodes += 1;
      return { outcome: "invalid_code", reply: INVALID_CODE_REPLY };
    }
    this.options.limits.bindingAttempts.success(chatKey);
    result.activated += 1;
    return { outcome: "activated", reply: ACTIVATED_REPLY };
  }

  /** True when the row was inserted; false when (bot, update_id) already exists. */
  private async recordUpdate(client: PoolClient, update: ClassifiedUpdate, outcome: string): Promise<boolean> {
    const inserted = await client.query(
      `INSERT INTO telegram_updates (bot_fingerprint, update_id, chat_fingerprint, kind, outcome)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bot_fingerprint, update_id) DO NOTHING`,
      [this.options.botFingerprint, update.updateId, update.chatFingerprint ?? null, update.kind, outcome]
    );
    return (inserted.rowCount ?? 0) === 1;
  }
}

function classifyUpdate(update: TelegramUpdateEnvelope): ClassifiedUpdate {
  const updateId = update.update_id;
  const message = update.message;
  const chatIdRaw = message?.chat?.id;
  const chatId = chatIdRaw === undefined || chatIdRaw === null ? undefined : String(chatIdRaw);
  if (!message || !chatId || !CHAT_ID_PATTERN.test(chatId)) {
    return { updateId, kind: "non_message" };
  }
  const chatFingerprint = createHash("sha256").update(chatId, "utf8").digest("hex");
  if (message.chat?.type !== "private") {
    return { updateId, kind: "group_message", chatFingerprint };
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const bindMatch = BIND_COMMAND_PATTERN.exec(text);
  if (bindMatch) {
    const argument = bindMatch[1];
    if (argument && CODE_ARGUMENT_PATTERN.test(argument)) {
      return { updateId, kind: "bind_command", chatId, chatFingerprint, codeArgument: argument };
    }
    // `/start` without a payload behaves like /help.
    return { updateId, kind: "help_command", chatId, chatFingerprint };
  }
  if (/^\/help(?:@[A-Za-z0-9_]+)?\s*$/.test(text)) {
    return { updateId, kind: "help_command", chatId, chatFingerprint };
  }
  return { updateId, kind: "other_message", chatId, chatFingerprint };
}
