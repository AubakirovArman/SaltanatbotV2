import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresExecutorCommandRepository } from "../src/database/executorCommands.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { IdentityService } from "../src/identity/service.js";
import { PostgresIdentityRepository } from "../src/identity/postgresRepository.js";
import {
  consumeBindingCode,
  createBindingCode,
  recipientFingerprint,
  type ConsumeBindingCodeResult
} from "../src/notifications/bindingService.js";
import { telegramCommandSessionIdHash } from "../src/notifications/commandBridge.js";
import {
  hashTelegramConfirmationToken,
  issueTelegramConfirmation,
  TELEGRAM_CONFIRMATION_MAX_OUTSTANDING,
  type IssueTelegramConfirmationInput
} from "../src/notifications/confirmations.js";
import { TelegramIngressLane } from "../src/notifications/ingressLane.js";
import { createTelegramIngressRateLimits, createTelegramSendRateLimits } from "../src/notifications/rateLimits.js";
import { TelegramRepliesLane, type RepliesSweepResult } from "../src/notifications/repliesLane.js";
import type { TelegramApi, TelegramUpdateEnvelope } from "../src/notifications/telegramApi.js";
import { paperRobotHandle } from "../src/trading/paperPortfolioExecutorReads.js";
import { createPaperPortfolioRuntime, type PaperPortfolioRuntime } from "../src/trading/paperPortfolioRuntime.js";
import { createPaperPortfolioIn, reserveAndBindPaperBotIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import type { TradingEngine } from "../src/trading/engine.js";
import type { BotConfig } from "../src/trading/types.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

/**
 * R5.3b-2 end-to-end proof: private-chat paper commands become durable fenced
 * executor commands in the SAME transaction as their journaled update, a REAL
 * fenced executor (PostgreSQL queue + temporary SQLite trading store) answers
 * them, and the replies lane closes the loop under the confirmation fences.
 */

const connectionString = process.env.TELEGRAM_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-0000000000e5";
const OWNER_B = "00000000-0000-4000-8000-0000000000e6";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const BOT = "e".repeat(64);
const BOT_ID = `bot-${"0123456789abcdef".repeat(2)}`;
const HANDLE = paperRobotHandle(BOT_ID);
const SEEDED_AT = 1_752_000_000_000;
// Shared with the other two telegram PG suites: they mutate shared tables and
// one plants a fake future schema row, so all three serialize on this lock.
const TELEGRAM_SUITE_ADVISORY_LOCK = 7_431_053;
let pool: Pool;
let suiteLock: PoolClient | undefined;
const sqlites: DatabaseSync[] = [];
const runtimes: PaperPortfolioRuntime[] = [];

describePostgres("telegram paper commands against isolated PostgreSQL and a real fenced executor", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 10 });
    await assertIsolatedTestDatabase(pool, process.env.TELEGRAM_TEST_DATABASE_URL ? "TELEGRAM_TEST_DATABASE_URL" : "ALERTS_TEST_DATABASE_URL");
    suiteLock = await pool.connect();
    await suiteLock.query("SELECT pg_advisory_lock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]);
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status, app_role, trading_role)
       VALUES ($1, 'telegram-command-owner-a', 'telegram-command-owner-a', $3, 'active', 'user', 'paper-trade'),
              ($2, 'telegram-command-owner-b', 'telegram-command-owner-b', $3, 'active', 'user', 'paper-trade')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active', trading_role = 'paper-trade', must_change_password = FALSE, authorization_revision = 1`,
      [OWNER_A, OWNER_B, PASSWORD_HASH]
    );
  }, 180_000);

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE telegram_confirmations, telegram_command_replies, executor_commands,
         telegram_updates, telegram_ingress_consumers, notification_bindings, notification_binding_codes CASCADE`
    );
    await pool.query("UPDATE users SET authorization_revision = 1, status = 'active' WHERE id = ANY($1::uuid[])", [[OWNER_A, OWNER_B]]);
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const database of sqlites.splice(0)) database.close();
  });

  afterAll(async () => {
    await suiteLock?.query("SELECT pg_advisory_unlock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]).catch(() => undefined);
    suiteLock?.release();
    await pool?.end();
  });

  it("installs the v16 command bridge tables with cascade and no-action foreign keys", async () => {
    const objects = await pool.query<{ name: string | null }>(
      `SELECT unnest(ARRAY[
         to_regclass('public.telegram_command_replies'),
         to_regclass('public.telegram_confirmations'),
         to_regclass('public.telegram_command_replies_pending_index'),
         to_regclass('public.telegram_command_replies_retention_index'),
         to_regclass('public.telegram_command_replies_owner_recent_index'),
         to_regclass('public.telegram_confirmations_owner_pending_index'),
         to_regclass('public.telegram_confirmations_retention_index')
       ])::text AS name`
    );
    expect(objects.rows.map(({ name }) => name)).toEqual([
      "telegram_command_replies",
      "telegram_confirmations",
      "telegram_command_replies_pending_index",
      "telegram_command_replies_retention_index",
      "telegram_command_replies_owner_recent_index",
      "telegram_confirmations_owner_pending_index",
      "telegram_confirmations_retention_index"
    ]);

    const binding = await activateBinding(OWNER_A, "9001");
    const sweep = await sweepIngress([[privateMessage(5001, "9001", "/balance")]]);
    expect(sweep.result).toMatchObject({ queuedCommands: 1 });
    // Executor retention deleting the command must cascade its reply row...
    await pool.query("DELETE FROM executor_commands WHERE owner_user_id = $1", [OWNER_A]);
    expect((await replyRows(OWNER_A))).toHaveLength(0);
    // ...while the binding tuple stays pinned NO ACTION for confirmations.
    await mintConfirmation({ bindingId: binding, chatFingerprint: recipientFingerprint("9001") });
    await expect(pool.query("DELETE FROM notification_bindings WHERE id = $1", [binding])).rejects.toMatchObject({
      code: "23503",
      table: "telegram_confirmations"
    });
  });

  it("answers /balance through the real fenced executor and replays a redelivered update as a no-op", { timeout: 60_000 }, async () => {
    const bindingId = await activateBinding(OWNER_A, "9011");
    const fixture = fencedRuntime();
    await fixture.runtime.start();

    const sweep = await sweepIngress([[privateMessage(6001, "9011", "/balance")]]);
    expect(sweep.result).toMatchObject({ held: true, polled: 1, queuedCommands: 1, replied: 0 });
    expect(sweep.api.sent).toEqual([]);

    const command = await commandRow(`telegram:${BOT}:6001`);
    expect(command).toMatchObject({
      owner_user_id: OWNER_A,
      actor_user_id: null,
      session_id_hash: telegramCommandSessionIdHash(bindingId, 1),
      authorization_revision: 1,
      authorization_epoch: 0,
      command_type: "paper-portfolio.snapshot",
      target_type: "paper-portfolio",
      target_id: "default"
    });
    expect(command.payload).toMatchObject({ kind: "paper-portfolio.snapshot", origin: "telegram" });
    expect(await replyRows(OWNER_A)).toEqual([
      expect.objectContaining({ purpose: "read", request_context: { command: "balance" }, replied: false })
    ]);

    await waitForTerminal(`telegram:${BOT}:6001`);
    const replies = await sweepReplies();
    expect(replies.result).toMatchObject({ replied: 1, suppressed: 0, timedOut: 0 });
    expect(replies.sent).toEqual([{ chatId: "9011", text: expect.stringContaining("Paper portfolio: Telegram portfolio") }]);
    expect(replies.sent[0]!.text).toContain("Available capital: 90000.000000 USDT");
    expect(replies.sent[0]!.text).toContain(`- ${HANDLE} Telegram bot [running]`);
    expect(await replyRows(OWNER_A)).toEqual([expect.objectContaining({ replied: true })]);

    // Crash/takeover simulation: a successor consumer sees the same update
    // redelivered beside new work and the (bot, update_id) key keeps one
    // durable command.
    await expireIngressLease();
    const replay = await sweepIngress(
      [[privateMessage(6001, "9011", "/balance"), privateMessage(6002, "9011", "/help")]],
      "telegram-commands:ingress-2"
    );
    expect(replay.result).toMatchObject({ held: true, replayed: 1, replied: 1, queuedCommands: 0 });
    const commands = await pool.query("SELECT count(*)::int AS total FROM executor_commands WHERE owner_user_id = $1", [OWNER_A]);
    expect(commands.rows[0]).toEqual({ total: 1 });
    await expect(sweepReplies()).resolves.toMatchObject({ result: { replied: 0 } });
  });

  it("runs the full fenced /pause round trip: snapshot, token, /confirm, action, reply", { timeout: 60_000 }, async () => {
    await activateBinding(OWNER_A, "9021");
    const fixture = fencedRuntime();
    await fixture.runtime.start();

    const pauseSweep = await sweepIngress([[privateMessage(6101, "9021", `/pause ${HANDLE}`)]]);
    expect(pauseSweep.result).toMatchObject({ queuedCommands: 1 });
    expect(await replyRows(OWNER_A)).toEqual([
      expect.objectContaining({
        purpose: "confirm-target",
        request_context: { command: "pause", action: "pause", handle: HANDLE }
      })
    ]);

    await waitForTerminal(`telegram:${BOT}:6101`);
    const prompt = await sweepReplies();
    expect(prompt.result).toMatchObject({ replied: 1, confirmationsIssued: 1 });
    expect(prompt.sent[0]!.text).toContain(`To confirm pause of ${HANDLE} Telegram bot [running]`);
    const token = /\/confirm ([a-z2-7]{16})/.exec(prompt.sent[0]!.text)?.[1];
    expect(token).toBeDefined();

    const stored = await pool.query<{ token_hash: string; action: string; bot_id: string; chat_fingerprint: string; ttl_s: number }>(
      `SELECT token_hash, action, bot_id, chat_fingerprint,
         extract(epoch FROM expires_at - created_at)::int AS ttl_s
       FROM telegram_confirmations WHERE owner_user_id = $1`,
      [OWNER_A]
    );
    expect(stored.rows).toEqual([{
      token_hash: hashTelegramConfirmationToken(token!),
      action: "pause",
      bot_id: BOT_ID,
      chat_fingerprint: recipientFingerprint("9021"),
      ttl_s: 120
    }]);

    const confirmSweep = await sweepIngress([[privateMessage(6102, "9021", `/confirm ${token}`)]]);
    expect(confirmSweep.result).toMatchObject({ queuedCommands: 1 });
    const consumed = await pool.query<{ consumed: boolean; consumed_update_id: string | number | null }>(
      "SELECT consumed_at IS NOT NULL AS consumed, consumed_update_id FROM telegram_confirmations WHERE owner_user_id = $1",
      [OWNER_A]
    );
    expect(consumed.rows[0]).toMatchObject({ consumed: true });
    expect(Number(consumed.rows[0]!.consumed_update_id)).toBe(6102);
    const action = await commandRow(`telegram:${BOT}:6102`);
    expect(action).toMatchObject({ command_type: "paper-robot.action", target_type: "paper-robot", target_id: BOT_ID });
    expect(action.payload).toMatchObject({ action: "pause", confirm: true, origin: "telegram", botId: BOT_ID });

    await waitForTerminal(`telegram:${BOT}:6102`);
    expect(fixture.pauseCalls).toEqual([{ ownerUserId: OWNER_A, botId: BOT_ID }]);
    expect(fixture.sqlite.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 3 });
    const outcome = await sweepReplies();
    expect(outcome.result).toMatchObject({ replied: 1 });
    expect(outcome.sent).toEqual([{ chatId: "9021", text: `Robot ${HANDLE} was paused.` }]);

    // Redelivered /confirm after a takeover replays; a fresh update with the
    // same one-time token fails closed.
    await expireIngressLease();
    const replay = await sweepIngress([[privateMessage(6102, "9021", `/confirm ${token}`)]], "telegram-commands:ingress-4");
    expect(replay.result).toMatchObject({ replayed: 1, queuedCommands: 0 });
    const reuse = await sweepIngress([[privateMessage(6103, "9021", `/confirm ${token}`)]], "telegram-commands:ingress-4");
    expect(reuse.result).toMatchObject({ queuedCommands: 0, replied: 1 });
    expect(reuse.api.sent[0]!.text).toContain("invalid, expired or already used");
    const commands = await pool.query("SELECT count(*)::int AS total FROM executor_commands WHERE owner_user_id = $1", [OWNER_A]);
    expect(commands.rows[0]).toEqual({ total: 2 });
  });

  it("keeps one update to at most one durable command across a crash before the batch commit", async () => {
    await activateBinding(OWNER_A, "9031");
    const stolen = await sweepIngress([[privateMessage(6201, "9031", "/balance")]], "telegram-commands:ingress-5", async () => {
      await pool.query("UPDATE telegram_ingress_consumers SET lease_generation = lease_generation + 1 WHERE bot_fingerprint = $1", [BOT]);
    });
    expect(stolen.result).toMatchObject({ held: false, polled: 1 });
    const empty = await pool.query(
      `SELECT (SELECT count(*)::int FROM executor_commands WHERE owner_user_id = $1) AS commands,
         (SELECT count(*)::int FROM telegram_updates WHERE bot_fingerprint = $2) AS updates,
         (SELECT count(*)::int FROM telegram_command_replies WHERE owner_user_id = $1) AS replies`,
      [OWNER_A, BOT]
    );
    expect(empty.rows[0]).toEqual({ commands: 0, updates: 0, replies: 0 });

    // The successor replays the exact same update once, durably.
    await expireIngressLease();
    await expect(sweepIngress([[privateMessage(6201, "9031", "/balance")]], "telegram-commands:ingress-6"))
      .resolves.toMatchObject({ result: { held: true, queuedCommands: 1 } });
    await expireIngressLease();
    await expect(sweepIngress([[privateMessage(6201, "9031", "/balance")]], "telegram-commands:ingress-7"))
      .resolves.toMatchObject({ result: { replayed: 1, queuedCommands: 0 } });
    const commands = await pool.query("SELECT count(*)::int AS total FROM executor_commands WHERE owner_user_id = $1", [OWNER_A]);
    expect(commands.rows[0]).toEqual({ total: 1 });
  });

  it("fails /confirm closed across owners, expiry, authorization changes and revocation", async () => {
    const bindingA = await activateBinding(OWNER_A, "9101");
    await activateBinding(OWNER_B, "9102");
    const fingerprintA = recipientFingerprint("9101");

    // Cross-owner: the token leaks to another bound chat and still dies.
    const crossToken = await mintConfirmation({ bindingId: bindingA, chatFingerprint: fingerprintA });
    const cross = await sweepIngress([[privateMessage(6301, "9102", `/confirm ${crossToken}`)]]);
    expect(cross.result).toMatchObject({ queuedCommands: 0, replied: 1 });
    expect(cross.api.sent[0]!.text).toContain("invalid, expired or already used");
    await expectUnconsumed(crossToken);

    // Expired token.
    const expiredToken = await mintConfirmation({ bindingId: bindingA, chatFingerprint: fingerprintA });
    await expireConfirmation(expiredToken);
    const expired = await sweepIngress([[privateMessage(6302, "9101", `/confirm ${expiredToken}`)]]);
    expect(expired.result).toMatchObject({ queuedCommands: 0, replied: 1 });
    await expectUnconsumed(expiredToken);

    // The owner's authorization revision moved between issue and confirm.
    const staleToken = await mintConfirmation({ bindingId: bindingA, chatFingerprint: fingerprintA });
    await pool.query("UPDATE users SET authorization_revision = 2 WHERE id = $1", [OWNER_A]);
    const stale = await sweepIngress([[privateMessage(6303, "9101", `/confirm ${staleToken}`)]]);
    expect(stale.result).toMatchObject({ queuedCommands: 0, replied: 1 });
    expect(stale.api.sent[0]!.text).toContain("invalid, expired or already used");
    await expectUnconsumed(staleToken);
    await pool.query("UPDATE users SET authorization_revision = 1 WHERE id = $1", [OWNER_A]);

    // A revoked binding never even reaches the token: the chat is unbound.
    await pool.query(
      "UPDATE notification_bindings SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
      [bindingA]
    );
    const revoked = await sweepIngress([[privateMessage(6304, "9101", `/confirm ${staleToken}`)]]);
    expect(revoked.result).toMatchObject({ queuedCommands: 0 });
    expect(revoked.api.sent[0]!.text).toContain("not bound to a SaltanatbotV2 account");
    await expectUnconsumed(staleToken);
    const commands = await pool.query("SELECT count(*)::int AS total FROM executor_commands");
    expect(commands.rows[0]).toEqual({ total: 0 });
  });

  it("enforces the three-outstanding confirmation quota per owner on real rows", async () => {
    expect(TELEGRAM_CONFIRMATION_MAX_OUTSTANDING).toBe(3);
    const bindingId = await activateBinding(OWNER_A, "9201");
    const chatFingerprint = recipientFingerprint("9201");
    for (let index = 0; index < 3; index += 1) {
      await mintConfirmation({ bindingId, chatFingerprint });
    }
    await expect(issueInTransaction({ bindingId, chatFingerprint })).resolves.toEqual({ outcome: "quota_exceeded" });

    // Expiry releases quota without consumption.
    const oldest = await pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM telegram_confirmations WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [OWNER_A]
    );
    await expireConfirmationHash(oldest.rows[0]!.token_hash);
    await expect(issueInTransaction({ bindingId, chatFingerprint })).resolves.toMatchObject({ outcome: "issued" });
  });
});

/** Scripted getUpdates/sendMessage double, with an optional mid-poll side effect. */
class FakeTelegramApi {
  readonly sent: Array<{ chatId: string; text: string }> = [];

  constructor(
    private readonly batches: TelegramUpdateEnvelope[][] = [],
    private readonly onPoll?: () => Promise<void>
  ) {}

  async getUpdates(): Promise<TelegramUpdateEnvelope[]> {
    await this.onPoll?.();
    return this.batches.shift() ?? [];
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
}

async function sweepIngress(
  batches: TelegramUpdateEnvelope[][],
  workerId = "telegram-commands:ingress-1",
  onPoll?: () => Promise<void>
) {
  const api = new FakeTelegramApi(batches, onPoll);
  const lane = new TelegramIngressLane(pool, {
    workerId,
    api: api as unknown as TelegramApi,
    botFingerprint: BOT,
    limits: createTelegramIngressRateLimits()
  });
  return { api, result: await lane.sweep() };
}

async function sweepReplies(): Promise<{ result: RepliesSweepResult; sent: Array<{ chatId: string; text: string }> }> {
  const api = new FakeTelegramApi();
  const errors: unknown[] = [];
  const lane = new TelegramRepliesLane(pool, {
    api: api as unknown as TelegramApi,
    limits: createTelegramSendRateLimits(),
    onError: (error) => errors.push(error)
  });
  const result = await lane.sweep();
  expect(errors).toEqual([]);
  return { result, sent: api.sent };
}

function privateMessage(updateId: number, chatId: string, text: string): TelegramUpdateEnvelope {
  return { update_id: updateId, message: { chat: { id: chatId, type: "private" }, text } };
}

async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function activateBinding(ownerUserId: string, chatId: string): Promise<string> {
  const code = await createBindingCode(pool, ownerUserId);
  const consumed = await withClient<ConsumeBindingCodeResult>((client) => consumeBindingCode(client, code.code, chatId));
  if (consumed.outcome !== "activated") throw new Error("Expected the binding code to activate.");
  return consumed.bindingId;
}

function issueInput(overrides: Partial<IssueTelegramConfirmationInput>): IssueTelegramConfirmationInput {
  return {
    ownerUserId: OWNER_A,
    bindingId: "invalid",
    bindingRevision: 1,
    chatFingerprint: "0".repeat(64),
    action: "pause",
    portfolioId: "telegram-portfolio",
    botId: BOT_ID,
    botStatusAtIssue: "running",
    portfolioRevision: 2,
    ledgerEpoch: 1,
    botRevision: 2,
    authorizationRevision: 1,
    ...overrides
  };
}

async function issueInTransaction(overrides: Partial<IssueTelegramConfirmationInput>) {
  return withClient((client) => issueTelegramConfirmation(client, issueInput(overrides)));
}

async function mintConfirmation(overrides: Partial<IssueTelegramConfirmationInput>): Promise<string> {
  const issued = await issueInTransaction(overrides);
  if (issued.outcome !== "issued") throw new Error("Expected the confirmation to be issued.");
  return issued.token;
}

/** Backdate the row so it expires without violating the expires_at > created_at CHECK. */
async function expireConfirmation(token: string): Promise<void> {
  await expireConfirmationHash(hashTelegramConfirmationToken(token));
}

async function expireConfirmationHash(tokenHash: string): Promise<void> {
  await pool.query(
    `UPDATE telegram_confirmations
     SET created_at = clock_timestamp() - interval '3 minutes',
         expires_at = clock_timestamp() - interval '1 second'
     WHERE token_hash = $1`,
    [tokenHash]
  );
}

async function expectUnconsumed(token: string): Promise<void> {
  const row = await pool.query<{ consumed: boolean }>(
    "SELECT consumed_at IS NOT NULL AS consumed FROM telegram_confirmations WHERE token_hash = $1",
    [hashTelegramConfirmationToken(token)]
  );
  expect(row.rows).toEqual([{ consumed: false }]);
}

async function expireIngressLease(): Promise<void> {
  await pool.query(
    "UPDATE telegram_ingress_consumers SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE bot_fingerprint = $1",
    [BOT]
  );
}

interface StoredCommandRow {
  owner_user_id: string;
  actor_user_id: string | null;
  session_id_hash: string;
  authorization_revision: number;
  authorization_epoch: number;
  command_type: string;
  target_type: string;
  target_id: string;
  status: string;
  error_code: string | null;
  payload: Record<string, unknown>;
}

async function commandRow(idempotencyKey: string): Promise<StoredCommandRow> {
  const result = await pool.query<StoredCommandRow>(
    `SELECT owner_user_id, actor_user_id, session_id_hash,
       authorization_revision::int AS authorization_revision,
       authorization_epoch::int AS authorization_epoch,
       command_type, target_type, target_id, status, error_code, payload
     FROM executor_commands WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (result.rows.length !== 1) throw new Error(`Expected exactly one command for ${idempotencyKey}.`);
  return result.rows[0]!;
}

async function replyRows(ownerUserId: string) {
  const result = await pool.query(
    `SELECT purpose, request_context, replied_at IS NOT NULL AS replied
     FROM telegram_command_replies WHERE owner_user_id = $1 ORDER BY created_at ASC`,
    [ownerUserId]
  );
  return result.rows;
}

async function waitForTerminal(idempotencyKey: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await pool.query<{ status: string; error_code: string | null; error_message: string | null }>(
      "SELECT status, error_code, error_message FROM executor_commands WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    const found = row.rows[0];
    if (found && (found.status === "applied" || found.status === "rejected")) {
      if (found.status !== "applied") {
        throw new Error(`Executor rejected ${idempotencyKey}: ${found.error_code} ${found.error_message ?? ""}`);
      }
      return;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${idempotencyKey} (${found?.status ?? "missing"}).`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function fencedRuntime() {
  const sqlite = new DatabaseSync(":memory:");
  sqlites.push(sqlite);
  migrateTradingStore(sqlite, () => SEEDED_AT, { legacyOwnerUserId: OWNER_A });
  seedDefaultPortfolio(sqlite);
  const pauseCalls: Array<{ ownerUserId: string; botId: string }> = [];
  const engine = {
    isRunningForOwner: () => true,
    isPausedForOwner: () => false,
    async startForOwner() {},
    async pauseForOwner(ownerUserId: string, botId: string) {
      pauseCalls.push({ ownerUserId, botId });
      return true;
    },
    async confirmResumeForOwner() {
      return true;
    },
    async stopSafelyForOwner() {}
  } as unknown as TradingEngine;
  const runtime = createPaperPortfolioRuntime({
    database: sqlite,
    engine,
    executorCommands: new PostgresExecutorCommandRepository(pool),
    identityService: new IdentityService(new PostgresIdentityRepository(pool)),
    workerId: "telegram-commands-test-executor"
  });
  runtimes.push(runtime);
  return { sqlite, runtime, pauseCalls };
}

function seedDefaultPortfolio(sqlite: DatabaseSync): void {
  const portfolio = createPaperPortfolioIn(sqlite, OWNER_A, {
    mutationId: "telegram-create",
    idempotencyKey: "telegram-create-key",
    requestHash: "b".repeat(64),
    now: SEEDED_AT,
    portfolioId: "telegram-portfolio",
    name: "Telegram portfolio",
    initialCapitalMicros: 100_000_000_000,
    makeDefault: true
  });
  const bot = upsertBotIntoForOwner(sqlite, OWNER_A, paperBot());
  reserveAndBindPaperBotIn(sqlite, OWNER_A, {
    mutationId: "telegram-bind",
    idempotencyKey: "telegram-bind-key",
    requestHash: "c".repeat(64),
    now: SEEDED_AT + 1,
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId: bot.id,
    expectedBotRevision: bot.revision!,
    allocationMicros: 10_000_000_000
  });
}

function paperBot(): BotConfig {
  return {
    id: BOT_ID,
    ownerUserId: OWNER_A,
    accountId: `paper:${BOT_ID}`,
    name: "Telegram bot",
    strategyName: "Telegram strategy",
    ir: { name: "telegram", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT
  };
}
