import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { consumeBindingCode } from "./bindingService.js";
import { handleTelegramPaperCommand } from "./commandBridge.js";
import { parseTelegramCommand, TELEGRAM_HELP_TEXT, type TelegramCommandParse } from "./commandParser.js";
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
 * chat ids), binding activations, Phase A paper-command effects (durable
 * executor commands + pending reply rows + confirmation consumption), and
 * the fenced cursor advance. A crash before commit replays the batch and the
 * (bot, update_id) primary key makes every replayed update a no-op; a crash
 * after commit skips it via the cursor — either way one update_id yields at
 * most one durable executor command. Replies go out only after the commit;
 * the cursor never waits on the executor (results arrive via the replies
 * lane).
 *
 * Command surface (R5.3b-2): `/start <code>`/`/bind <code>` consume a one-use
 * binding code; `/help`, the read commands (/balance /daily /profit
 * /performance /trades /alerts) and the fenced control flow
 * (/pause /resume /stop → /confirm) require an ACTIVE binding. Everything
 * else in a private chat gets the static notice; group and non-message
 * updates are recorded as ignored.
 */

const STATIC_REPLY = "Unknown command. Send /help for the list of supported commands.";
const ACTIVATED_REPLY = "Telegram notifications are now bound to your SaltanatbotV2 account. This bot sends research/paper notifications only.";
const INVALID_CODE_REPLY = "That binding code is invalid, expired or already used. Create a fresh code in the SaltanatbotV2 alerts panel.";
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
  queuedCommands: number;
  ignored: number;
}

interface ClassifiedUpdate {
  readonly updateId: number;
  readonly kind:
    | "bind_command"
    | "help_command"
    | "paper_command"
    | "confirm_command"
    | "other_message"
    | "group_message"
    | "non_message";
  readonly chatId?: string;
  readonly chatFingerprint?: string;
  readonly parse?: TelegramCommandParse;
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
    const result: IngressSweepResult = { held: false, polled: 0, recorded: 0, replayed: 0, activated: 0, invalidCodes: 0, rateLimited: 0, replied: 0, queuedCommands: 0, ignored: 0 };
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
    if (update.kind === "bind_command") return this.handleBindCommand(client, update, result);
    if (update.kind === "help_command") {
      result.replied += 1;
      return { outcome: "replied", reply: TELEGRAM_HELP_TEXT };
    }
    if (update.kind === "paper_command" || update.kind === "confirm_command") {
      return this.handlePaperCommand(client, update, result);
    }
    result.replied += 1;
    return { outcome: "replied", reply: STATIC_REPLY };
  }

  private async handleBindCommand(client: PoolClient, update: ClassifiedUpdate, result: IngressSweepResult): Promise<{ outcome: string; reply?: string }> {
    const chatKey = update.chatFingerprint!;
    if (this.options.limits.bindingAttempts.attempt(chatKey, this.now()) !== undefined) {
      result.rateLimited += 1;
      return { outcome: "rate_limited" };
    }
    const code = update.parse?.type === "bind" ? update.parse.code : undefined;
    if (!code || !update.chatId) {
      result.invalidCodes += 1;
      return { outcome: "invalid_code", reply: INVALID_CODE_REPLY };
    }
    const consumed = await consumeBindingCode(client, code, update.chatId);
    if (consumed.outcome !== "activated") {
      result.invalidCodes += 1;
      return { outcome: "invalid_code", reply: INVALID_CODE_REPLY };
    }
    this.options.limits.bindingAttempts.success(chatKey);
    result.activated += 1;
    return { outcome: "activated", reply: ACTIVATED_REPLY };
  }

  /** Phase A of the paper-command flow, inside the batch transaction. */
  private async handlePaperCommand(client: PoolClient, update: ClassifiedUpdate, result: IngressSweepResult): Promise<{ outcome: string; reply?: string }> {
    const parse = update.parse;
    if (parse?.type === "usage") {
      result.replied += 1;
      return { outcome: "invalid_arguments", reply: parse.reply };
    }
    if (
      parse === undefined
      || (parse.type !== "snapshot" && parse.type !== "trades" && parse.type !== "alerts"
        && parse.type !== "control" && parse.type !== "confirm")
    ) {
      result.replied += 1;
      return { outcome: "replied", reply: STATIC_REPLY };
    }
    const handled = await handleTelegramPaperCommand(client, {
      parse,
      chatFingerprint: update.chatFingerprint!,
      updateId: update.updateId,
      botFingerprint: this.options.botFingerprint,
      bindingAttempts: this.options.limits.bindingAttempts,
      now: this.now()
    });
    if (handled.outcome === "queued" || handled.outcome === "confirmed") result.queuedCommands += 1;
    else if (handled.outcome === "rate_limited") result.rateLimited += 1;
    else result.replied += 1;
    return handled;
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
  const text = typeof message.text === "string" ? message.text : "";
  const parse = parseTelegramCommand(text);
  return { updateId, kind: classifiedKind(parse), chatId, chatFingerprint, parse };
}

function classifiedKind(parse: TelegramCommandParse): ClassifiedUpdate["kind"] {
  switch (parse.type) {
    case "bind":
      return "bind_command";
    case "help":
      return "help_command";
    case "confirm":
      return "confirm_command";
    case "snapshot":
    case "trades":
    case "alerts":
    case "control":
    case "usage":
      return "paper_command";
    default:
      return "other_message";
  }
}
