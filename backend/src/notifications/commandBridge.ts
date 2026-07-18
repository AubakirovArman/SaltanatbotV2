import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ExecutorCommandCapacityError,
  ExecutorCommandIdempotencyConflictError
} from "../database/executorCommandTypes.js";
import { enqueueExecutorCommandInTransaction } from "../database/executorCommands.js";
import {
  validateEnqueueExecutorCommandInput,
  validateExecutorCommandRepositoryOptions
} from "../database/executorCommandValidation.js";
import type { AuthRateLimiter } from "../identity/rateLimit.js";
import {
  PAPER_PORTFOLIO_COMMAND_VERSION,
  PAPER_TELEGRAM_COMMAND_ORIGIN,
  PAPER_TELEGRAM_IDEMPOTENCY_KEY_PREFIX,
  paperPortfolioCommandTarget,
  paperPortfolioRequestHash,
  type PaperPortfolioExecutorPayload
} from "../trading/paperPortfolioCommandContract.js";
import { paperRobotHandle } from "../trading/paperPortfolioExecutorReads.js";
import { consumeTelegramConfirmation } from "./confirmations.js";
import type { TelegramCommandParse } from "./commandParser.js";

/**
 * Phase A durable command bridge: turns a parsed private-chat paper command
 * into ONE fenced executor command inside the SAME transaction that journals
 * the Telegram update. The frozen v12 executor_commands table stays DDL-free:
 * Telegram provenance is the payload `origin` marker plus the
 * `telegram:<botFingerprint>:<updateId>` idempotency key, whose (owner, key)
 * uniqueness makes a replayed or crash-redelivered update settle on the same
 * durable command before AND after a worker takeover.
 *
 * Fail-closed discipline: every command first resolves the ACTIVE binding by
 * hashed chat fingerprint, re-checks users.status = 'active' and reads the
 * owner's CURRENT authorization_revision; any mismatch answers with a static
 * reply that leaks no tenant data. The notification worker cannot know the
 * API-process authorization epoch, so telegram-origin commands carry epoch 0
 * and the executor's authorize step re-proves the durable revision instead.
 */

export const TELEGRAM_COMMAND_AUTHORIZATION_EPOCH = 0;
export const TELEGRAM_REPLY_PURPOSE_READ = "read";
export const TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET = "confirm-target";
export const TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME = "action-outcome";

const NOT_BOUND_REPLY =
  "This chat is not bound to a SaltanatbotV2 account. Create a binding code in the alerts panel and send /bind <code>.";
const UNAVAILABLE_REPLY = "This command is unavailable right now.";
const CAPACITY_REPLY = "Too many commands are pending for your account. Try again in a minute.";
const INVALID_CONFIRMATION_REPLY = "That confirmation token is invalid, expired or already used.";
const CONFIRM_RATE_LIMITED_REPLY = "Too many confirmation attempts. Wait a few minutes and try again.";

const ENQUEUE_OPTIONS = validateExecutorCommandRepositoryOptions({});

export interface TelegramCommandContext {
  readonly ownerUserId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly authorizationRevision: number;
  readonly chatFingerprint: string;
}

export type PaperCommandParse = Extract<
  TelegramCommandParse,
  { type: "snapshot" | "trades" | "alerts" | "control" | "confirm" }
>;

export interface TelegramPaperCommandInput {
  readonly parse: PaperCommandParse;
  readonly chatFingerprint: string;
  readonly updateId: number;
  readonly botFingerprint: string;
  readonly bindingAttempts: AuthRateLimiter;
  readonly now: number;
}

export interface TelegramPaperCommandOutcome {
  /** Stored into telegram_updates.outcome; must match its lowercase CHECK. */
  readonly outcome: string;
  readonly reply?: string;
}

/** Deterministic synthetic session digest for telegram-origin commands. */
export function telegramCommandSessionIdHash(bindingId: string, bindingRevision: number): string {
  return createHash("sha256")
    .update(`telegram:${bindingId}:${bindingRevision}`, "utf8")
    .digest("hex");
}

export function telegramCommandIdempotencyKey(botFingerprint: string, updateId: number): string {
  return `${PAPER_TELEGRAM_IDEMPOTENCY_KEY_PREFIX}${botFingerprint}:${updateId}`;
}

/**
 * Resolve the single active binding for a hashed chat. Two different owners
 * both actively bound to one chat is unresolvable ambiguity: refuse instead
 * of guessing a tenant.
 */
export async function resolveTelegramCommandContext(
  client: PoolClient,
  chatFingerprint: string
): Promise<
  | { readonly outcome: "resolved"; readonly context: TelegramCommandContext }
  | { readonly outcome: "unbound" | "ambiguous" | "owner_inactive" }
> {
  const bindings = await client.query<{
    id: string;
    owner_user_id: string;
    revision: string | number;
    owner_status: string;
    authorization_revision: string | number;
  }>(
    `SELECT b.id, b.owner_user_id, b.revision, u.status AS owner_status, u.authorization_revision
     FROM notification_bindings b
     INNER JOIN users u ON u.id = b.owner_user_id
     WHERE b.channel = 'telegram' AND b.status = 'active'
       AND b.recipient_fingerprint = $1 AND b.recipient_chat_id IS NOT NULL
     ORDER BY b.activated_at DESC, b.id DESC
     LIMIT 2`,
    [chatFingerprint]
  );
  if (bindings.rows.length === 0) return { outcome: "unbound" };
  if (bindings.rows.length > 1) return { outcome: "ambiguous" };
  const row = bindings.rows[0]!;
  if (row.owner_status !== "active") return { outcome: "owner_inactive" };
  return {
    outcome: "resolved",
    context: {
      ownerUserId: row.owner_user_id,
      bindingId: row.id,
      bindingRevision: safePositive(row.revision, "binding revision"),
      authorizationRevision: safePositive(row.authorization_revision, "authorization revision"),
      chatFingerprint
    }
  };
}

/** Phase A dispatch for one paper command, inside the ingress batch transaction. */
export async function handleTelegramPaperCommand(
  client: PoolClient,
  input: TelegramPaperCommandInput
): Promise<TelegramPaperCommandOutcome> {
  const resolution = await resolveTelegramCommandContext(client, input.chatFingerprint);
  if (resolution.outcome === "unbound") return { outcome: "not_bound", reply: NOT_BOUND_REPLY };
  if (resolution.outcome !== "resolved") {
    return { outcome: `binding_${resolution.outcome}`, reply: UNAVAILABLE_REPLY };
  }
  const context = resolution.context;
  const parse = input.parse;
  switch (parse.type) {
    case "alerts":
      return { outcome: "replied", reply: await alertsSummary(client, context.ownerUserId) };
    case "snapshot":
      return enqueueDurableCommand(client, context, input, snapshotPayload(), {
        purpose: TELEGRAM_REPLY_PURPOSE_READ,
        requestContext: { command: parse.view }
      });
    case "trades":
      return enqueueDurableCommand(
        client,
        context,
        input,
        {
          version: PAPER_PORTFOLIO_COMMAND_VERSION,
          kind: "paper-robot.trades",
          botId: parse.handle,
          origin: PAPER_TELEGRAM_COMMAND_ORIGIN
        },
        {
          purpose: TELEGRAM_REPLY_PURPOSE_READ,
          requestContext: { command: "trades", handle: parse.handle }
        }
      );
    case "control":
      // Step 1 of the fenced control flow: a snapshot command whose terminal
      // result lets the replies lane resolve the handle and issue the token.
      return enqueueDurableCommand(client, context, input, snapshotPayload(), {
        purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
        requestContext: { command: parse.action, action: parse.action, handle: parse.handle }
      });
    case "confirm":
      return confirmAction(client, context, input, parse.token);
  }
}

async function confirmAction(
  client: PoolClient,
  context: TelegramCommandContext,
  input: TelegramPaperCommandInput,
  token: string
): Promise<TelegramPaperCommandOutcome> {
  // Guessed tokens burn the same strict budget as guessed binding codes.
  if (input.bindingAttempts.attempt(input.chatFingerprint, input.now) !== undefined) {
    return { outcome: "rate_limited", reply: CONFIRM_RATE_LIMITED_REPLY };
  }
  const consumed = await consumeTelegramConfirmation(client, {
    token,
    updateId: input.updateId,
    chatFingerprint: context.chatFingerprint,
    ownerUserId: context.ownerUserId,
    bindingId: context.bindingId,
    bindingRevision: context.bindingRevision,
    authorizationRevision: context.authorizationRevision
  });
  if (consumed.outcome !== "consumed") {
    return { outcome: "invalid_confirmation", reply: INVALID_CONFIRMATION_REPLY };
  }
  const confirmation = consumed.confirmation;
  const outcome = await enqueueDurableCommand(
    client,
    context,
    input,
    {
      version: PAPER_PORTFOLIO_COMMAND_VERSION,
      kind: "paper-robot.action",
      portfolioId: confirmation.portfolioId,
      expectedPortfolioRevision: confirmation.portfolioRevision,
      expectedLedgerEpoch: confirmation.ledgerEpoch,
      botId: confirmation.botId,
      expectedBotRevision: confirmation.botRevision,
      action: confirmation.action,
      confirm: true,
      origin: PAPER_TELEGRAM_COMMAND_ORIGIN
    },
    {
      purpose: TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME,
      requestContext: {
        command: "confirm",
        action: confirmation.action,
        handle: paperRobotHandle(confirmation.botId)
      }
    }
  );
  if (outcome.outcome === "queued") {
    input.bindingAttempts.success(input.chatFingerprint);
    return { outcome: "confirmed" };
  }
  return outcome;
}

/**
 * Enqueue one durable executor command plus its pending reply row. Capacity
 * and idempotency conflicts are answered client-side without poisoning the
 * surrounding batch transaction (both are thrown before any failed SQL).
 */
async function enqueueDurableCommand(
  client: PoolClient,
  context: TelegramCommandContext,
  input: TelegramPaperCommandInput,
  payload: PaperPortfolioExecutorPayload,
  reply: { purpose: string; requestContext: Record<string, unknown> }
): Promise<TelegramPaperCommandOutcome> {
  const target = paperPortfolioCommandTarget(payload);
  let commandId: string;
  try {
    const enqueued = await enqueueExecutorCommandInTransaction(
      client,
      validateEnqueueExecutorCommandInput({
        ownerUserId: context.ownerUserId,
        actorUserId: null,
        sessionIdHash: telegramCommandSessionIdHash(context.bindingId, context.bindingRevision),
        authorizationRevision: context.authorizationRevision,
        authorizationEpoch: TELEGRAM_COMMAND_AUTHORIZATION_EPOCH,
        commandType: payload.kind,
        targetType: target.targetType,
        targetId: target.targetId,
        idempotencyKey: telegramCommandIdempotencyKey(input.botFingerprint, input.updateId),
        requestHash: paperPortfolioRequestHash(context.ownerUserId, payload),
        payload: payload as unknown as Record<string, unknown>
      }),
      ENQUEUE_OPTIONS
    );
    commandId = enqueued.command.id;
  } catch (error) {
    if (error instanceof ExecutorCommandCapacityError) {
      return { outcome: "capacity_exhausted", reply: CAPACITY_REPLY };
    }
    if (error instanceof ExecutorCommandIdempotencyConflictError) {
      return { outcome: "idempotency_conflict", reply: UNAVAILABLE_REPLY };
    }
    throw error;
  }
  await client.query(
    `INSERT INTO telegram_command_replies (
       command_id, owner_user_id, binding_id, binding_revision, purpose, request_context
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (command_id) DO NOTHING`,
    [
      commandId,
      context.ownerUserId,
      context.bindingId,
      context.bindingRevision,
      reply.purpose,
      JSON.stringify(reply.requestContext)
    ]
  );
  return { outcome: "queued" };
}

function snapshotPayload(): PaperPortfolioExecutorPayload {
  return {
    version: PAPER_PORTFOLIO_COMMAND_VERSION,
    kind: "paper-portfolio.snapshot",
    origin: PAPER_TELEGRAM_COMMAND_ORIGIN
  };
}

/** /alerts reads PostgreSQL directly: enabled rules (≤10) + recent events (≤5). */
async function alertsSummary(client: PoolClient, ownerUserId: string): Promise<string> {
  const rules = await client.query<{ rule_kind: string; name: string | null }>(
    `SELECT r.rule_kind, v.definition->>'name' AS name
     FROM alert_rules r
     INNER JOIN alert_rule_revisions v
       ON v.owner_user_id = r.owner_user_id AND v.alert_rule_id = r.id
         AND v.revision = r.current_revision
     WHERE r.owner_user_id = $1 AND r.status = 'active'
     ORDER BY r.updated_at DESC, r.id DESC
     LIMIT 10`,
    [ownerUserId]
  );
  const events = await client.query<{ event_type: string; occurred_at: Date; name: string | null }>(
    `SELECT e.event_type, e.occurred_at, v.definition->>'name' AS name
     FROM alert_rule_events e
     LEFT JOIN alert_rule_revisions v
       ON v.owner_user_id = e.owner_user_id AND v.alert_rule_id = e.alert_rule_id
         AND v.revision = e.rule_revision
     WHERE e.owner_user_id = $1
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT 5`,
    [ownerUserId]
  );
  const lines: string[] = [];
  if (rules.rows.length === 0) {
    lines.push("No enabled alert rules.");
  } else {
    lines.push(`Enabled alert rules (${rules.rows.length}):`);
    for (const rule of rules.rows) lines.push(`- ${rule.name ?? "unnamed"} (${rule.rule_kind})`);
  }
  if (events.rows.length === 0) {
    lines.push("No recent alert events.");
  } else {
    lines.push("Recent alert events:");
    for (const event of events.rows) {
      lines.push(`- ${utcTimestamp(event.occurred_at)} ${event.event_type}${event.name ? ` ${event.name}` : ""}`);
    }
  }
  return lines.join("\n");
}

function utcTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function safePositive(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Stored telegram ${label} is invalid`);
  }
  return parsed;
}
