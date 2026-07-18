import { createHash } from "node:crypto";
import type { Candle, PriceThresholdAlertDefinitionV1, ScreenerAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { priceThresholdAlertScopeKey } from "../src/alerts/priceEvaluator.js";
import { AlertRepository } from "../src/alerts/repository.js";
import type { ClaimedPriceAlertRule, CompletePriceEvaluationInput } from "../src/alerts/repositoryTypes.js";
import { runScreenerAlertSweep } from "../src/alerts/screenerAlertRunner.js";
import { migrateDatabase } from "../src/database/migrations.js";
import {
  BINDING_CODE_MAX_OUTSTANDING,
  BindingCodeQuotaError,
  BindingRevisionConflictError,
  consumeBindingCode,
  createBindingCode,
  hashBindingCode,
  listBindings,
  recipientFingerprint,
  revokeBinding,
  telegramDeliveryCounters,
  type ConsumeBindingCodeResult
} from "../src/notifications/bindingService.js";
import { acquireConsumerLease, advanceConsumerCursor, renewConsumerLease } from "../src/notifications/consumerLease.js";
import { TelegramDeliveryLane } from "../src/notifications/deliveryLane.js";
import { TelegramIngressLane } from "../src/notifications/ingressLane.js";
import { createTelegramIngressRateLimits, createTelegramSendRateLimits } from "../src/notifications/rateLimits.js";
import { TelegramApiError, TelegramRateLimitError, type TelegramApi, type TelegramUpdateEnvelope } from "../src/notifications/telegramApi.js";
import type { ScreenerMarketDataSnapshotV1 } from "../src/screener/marketData.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.TELEGRAM_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-0000000000d1";
const OWNER_B = "00000000-0000-4000-8000-0000000000d2";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const BOT = "d".repeat(64);
const MINUTE = 60_000;
const BAR = 300_000;
const BAR_BASE = Math.floor(Date.now() / BAR) * BAR - 4 * BAR;
const SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
// Serializes the two telegram PG suites on a shared database: the worker boot
// suite plants a fake future schema_migrations row that must never be visible
// to this suite's migrate. Both files take the same session advisory lock.
const TELEGRAM_SUITE_ADVISORY_LOCK = 7_431_053;
let pool: Pool;
let suiteLock: PoolClient | undefined;
let repository: AlertRepository;

describePostgres("telegram ingress and delivery against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 10 });
    await assertIsolatedTestDatabase(pool, process.env.TELEGRAM_TEST_DATABASE_URL ? "TELEGRAM_TEST_DATABASE_URL" : "ALERTS_TEST_DATABASE_URL");
    suiteLock = await pool.connect();
    await suiteLock.query("SELECT pg_advisory_lock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]);
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status, app_role)
       VALUES ($1, 'telegram-owner-a', 'telegram-owner-a', $3, 'active', 'user'),
              ($2, 'telegram-owner-b', 'telegram-owner-b', $3, 'active', 'user')
       ON CONFLICT (id) DO UPDATE SET status = 'active', must_change_password = FALSE, authorization_revision = 1`,
      [OWNER_A, OWNER_B, PASSWORD_HASH]
    );
    repository = new AlertRepository(pool);
  }, 180_000);

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE alert_event_sequences, alert_rules, notification_bindings, notification_binding_codes,
         telegram_ingress_consumers, telegram_updates, alert_evaluation_receipts CASCADE`
    );
  });

  afterAll(async () => {
    await suiteLock?.query("SELECT pg_advisory_unlock($1)", [TELEGRAM_SUITE_ADVISORY_LOCK]).catch(() => undefined);
    suiteLock?.release();
    await pool?.end();
  });

  it("installs the v15 ingress tables, indexes and the binding chat column", async () => {
    const objects = await pool.query<{ name: string | null }>(
      `SELECT unnest(ARRAY[
         to_regclass('public.notification_binding_codes'),
         to_regclass('public.telegram_ingress_consumers'),
         to_regclass('public.telegram_updates'),
         to_regclass('public.notification_binding_codes_owner_recent_index'),
         to_regclass('public.notification_binding_codes_retention_index'),
         to_regclass('public.telegram_updates_retention_index')
       ])::text AS name`
    );
    expect(objects.rows.map(({ name }) => name)).toEqual([
      "notification_binding_codes",
      "telegram_ingress_consumers",
      "telegram_updates",
      "notification_binding_codes_owner_recent_index",
      "notification_binding_codes_retention_index",
      "telegram_updates_retention_index"
    ]);
    const chatColumn = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notification_bindings' AND column_name = 'recipient_chat_id'`
    );
    expect(chatColumn.rowCount).toBe(1);
    const version = await pool.query<{ version: number }>("SELECT max(version)::integer AS version FROM schema_migrations");
    expect(version.rows[0]?.version).toBe(17);
  });

  it("stores only hashed one-consume codes and enforces the outstanding quota", async () => {
    const created = await createBindingCode(pool, OWNER_A);
    expect(created.code).toMatch(/^[a-z2-7]{26}$/);

    const stored = await pool.query<{ code_hash: string; consumed_at: Date | null; ttl_s: number }>(
      `SELECT code_hash, consumed_at, extract(epoch FROM expires_at - created_at)::int AS ttl_s
       FROM notification_binding_codes WHERE id = $1`,
      [created.id]
    );
    expect(stored.rows[0]).toMatchObject({ code_hash: hashBindingCode(created.code), consumed_at: null });
    expect(stored.rows[0]!.ttl_s).toBeGreaterThanOrEqual(9 * 60);
    expect(stored.rows[0]!.ttl_s).toBeLessThanOrEqual(11 * 60);

    await createBindingCode(pool, OWNER_A);
    const third = await createBindingCode(pool, OWNER_A);
    await expect(createBindingCode(pool, OWNER_A)).rejects.toBeInstanceOf(BindingCodeQuotaError);
    expect(BINDING_CODE_MAX_OUTSTANDING).toBe(3);
    // Owners are independent, and expired codes stop counting.
    await expect(createBindingCode(pool, OWNER_B)).resolves.toBeDefined();
    await pool.query(`UPDATE notification_binding_codes
       SET created_at = clock_timestamp() - interval '11 minutes', expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`, [third.id]);
    await expect(createBindingCode(pool, OWNER_A)).resolves.toBeDefined();
  });

  it("consumes a code exactly once, refuses expiry and settles a race to one winner", async () => {
    const expired = await createBindingCode(pool, OWNER_A);
    await pool.query(`UPDATE notification_binding_codes
       SET created_at = clock_timestamp() - interval '11 minutes', expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`, [expired.id]);
    await expect(consumeInTransaction(expired.code, "101")).resolves.toEqual({ outcome: "invalid_code" });

    const valid = await createBindingCode(pool, OWNER_A);
    const consumed = await consumeInTransaction(valid.code, "102");
    expect(consumed).toMatchObject({ outcome: "activated", ownerUserId: OWNER_A });
    const binding = await pool.query(
      `SELECT status, revision::int AS revision, recipient_chat_id, recipient_fingerprint,
         activated_at IS NOT NULL AS activated
       FROM notification_bindings WHERE id = $1`,
      [(consumed as { bindingId: string }).bindingId]
    );
    expect(binding.rows[0]).toEqual({
      status: "active",
      revision: 1,
      recipient_chat_id: "102",
      recipient_fingerprint: recipientFingerprint("102"),
      activated: true
    });
    const codeRow = await pool.query("SELECT consumed_at, consumed_binding_id FROM notification_binding_codes WHERE id = $1", [valid.id]);
    expect(codeRow.rows[0]!.consumed_at).not.toBeNull();
    await expect(consumeInTransaction(valid.code, "103")).resolves.toEqual({ outcome: "invalid_code" });

    // Two chats racing for one fresh code: FOR UPDATE leaves exactly one winner.
    await revokeAllBindings(OWNER_A);
    const contested = await createBindingCode(pool, OWNER_A);
    const outcomes = await Promise.all([consumeInTransaction(contested.code, "201"), consumeInTransaction(contested.code, "202")]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["activated", "invalid_code"]);
    const active = await pool.query("SELECT count(*)::int AS active FROM notification_bindings WHERE owner_user_id = $1 AND status = 'active'", [OWNER_A]);
    expect(active.rows[0]).toEqual({ active: 1 });
  });

  it("replaces the previous active binding on rebind and fences revocation by revision", async () => {
    const first = await activateBinding(OWNER_A, "301");
    const replaced = await consumeInTransaction((await createBindingCode(pool, OWNER_A)).code, "302");
    expect(replaced).toMatchObject({ outcome: "activated", replacedBindingId: first });

    const bindings = await listBindings(pool, OWNER_A);
    expect(bindings).toHaveLength(2);
    expect(bindings.map(({ status }) => status).sort()).toEqual(["active", "revoked"]);
    const current = bindings.find(({ status }) => status === "active")!;
    expect(current.recipientHandle).toBe(recipientFingerprint("302").slice(0, 8));
    expect(current.recipientHandle).toHaveLength(8);

    await expect(revokeBinding(pool, { ownerUserId: OWNER_A, bindingId: current.id, expectedRevision: 99 })).rejects.toBeInstanceOf(BindingRevisionConflictError);
    // Cross-owner revocation is a not-found, never a mutation.
    await expect(revokeBinding(pool, { ownerUserId: OWNER_B, bindingId: current.id, expectedRevision: 1 })).rejects.toThrow(/not found/i);
    const revoked = await revokeBinding(pool, { ownerUserId: OWNER_A, bindingId: current.id, expectedRevision: 1 });
    expect(revoked.binding).toMatchObject({ id: current.id, status: "revoked" });
    await expect(revokeBinding(pool, { ownerUserId: OWNER_A, bindingId: current.id, expectedRevision: 1 })).rejects.toBeInstanceOf(BindingRevisionConflictError);
  });

  it("queues a telegram delivery from the price completion only when a binding is active", async () => {
    const skippedBefore = telegramDeliveryCounters.skippedWithoutBinding;
    await triggerPriceAlert("telegram:price-unbound");
    expect(await deliveryRows(OWNER_A)).toEqual([expect.objectContaining({ channel: "in-app", status: "delivered" })]);
    expect(telegramDeliveryCounters.skippedWithoutBinding).toBe(skippedBefore + 1);

    const bindingId = await activateBinding(OWNER_A, "401");
    await triggerPriceAlert("telegram:price-bound");
    const rows = await deliveryRows(OWNER_A);
    const telegram = rows.filter((row) => row.channel === "telegram");
    expect(telegram).toEqual([
      expect.objectContaining({
        channel: "telegram",
        status: "queued",
        binding_id: bindingId,
        binding_revision: 1,
        attempt: 0,
        lease_owner: null
      })
    ]);
    // Same dedup key as the sibling in-app row; uniqueness is per channel.
    const inApp = rows.filter((row) => row.channel === "in-app" && row.deduplication_key === telegram[0]!.deduplication_key);
    expect(inApp).toHaveLength(1);
  });

  it("queues a telegram delivery from the screener completion under an active binding", async () => {
    await activateBinding(OWNER_A, "402");
    const rule = await repository.create({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      authorizationRevision: 1,
      clientId: "telegram:screener-bound",
      definition: screenerDefinition()
    });
    await makeDue(rule.id);
    await screenerSweep(snapshot(BAR_BASE, ["AAAUSDT"]));
    await makeDue(rule.id);
    await screenerSweep(snapshot(BAR_BASE + BAR, ["AAAUSDT", "BBBUSDT"]));

    const telegram = (await deliveryRows(OWNER_A)).filter((row) => row.channel === "telegram");
    expect(telegram).toEqual([expect.objectContaining({ status: "queued", binding_revision: 1, attempt: 0 })]);
  });

  it("delivers a claimed telegram row and records the provider receipt", async () => {
    await activateBinding(OWNER_A, "501");
    await triggerPriceAlert("telegram:deliver");
    const api = new FakeSendApi();
    api.plan(() => ({ messageId: "provider-777" }));

    const sweep = await deliveryLane(api).sweep();

    expect(sweep).toMatchObject({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0, cancelled: 0 });
    expect(api.calls).toEqual([expect.objectContaining({ chatId: "501" })]);
    expect(api.calls[0]!.text).toContain("SaltanatbotV2 research/paper notification");
    const row = (await deliveryRows(OWNER_A)).find((delivery) => delivery.channel === "telegram")!;
    expect(row).toMatchObject({ status: "delivered", provider_receipt: "provider-777", attempt: 1, lease_owner: null });
    expect(row.terminal).toBe(true);
  });

  it("retries with capped exponential backoff, honours 429 and dead-letters at the cap", async () => {
    await activateBinding(OWNER_A, "502");
    await triggerPriceAlert("telegram:retry");
    const api = new FakeSendApi();

    api.plan(() => {
      throw new TelegramApiError("Telegram sendMessage HTTP 502", true);
    });
    await expect(deliveryLane(api).sweep()).resolves.toMatchObject({ claimed: 1, retried: 1 });
    let row = await telegramDelivery(OWNER_A);
    expect(row).toMatchObject({ status: "retrying", attempt: 1, error_code: "telegram_send_failed", lease_owner: null });
    expect(row.delay_s).toBeGreaterThan(50);
    expect(row.delay_s).toBeLessThan(70);

    // Telegram 429 pushes run_after out to the requested pause.
    await makeDeliveryDue(row.id);
    api.plan(() => {
      throw new TelegramRateLimitError(240_000);
    });
    await expect(deliveryLane(api).sweep()).resolves.toMatchObject({ claimed: 1, retried: 1 });
    row = await telegramDelivery(OWNER_A);
    expect(row).toMatchObject({ status: "retrying", attempt: 2, error_code: "telegram_rate_limited" });
    expect(row.delay_s).toBeGreaterThan(230);
    expect(row.delay_s).toBeLessThan(250);

    // At the attempt cap the next failure is terminal.
    await pool.query(
      `UPDATE notification_deliveries SET attempt = 5, lease_generation = 5, run_after = created_at
       WHERE id = $1`,
      [row.id]
    );
    api.plan(() => {
      throw new TelegramApiError("Telegram sendMessage HTTP 502", true);
    });
    await expect(deliveryLane(api).sweep()).resolves.toMatchObject({ claimed: 1, deadLettered: 1 });
    row = await telegramDelivery(OWNER_A);
    expect(row).toMatchObject({ status: "dead_letter", attempt: 6 });
    expect(row.terminal).toBe(true);
  });

  it("cancels pending deliveries on revoke at both the service and the lane fence", async () => {
    await activateBinding(OWNER_A, "503");
    await triggerPriceAlert("telegram:cancel-service");
    const active = (await listBindings(pool, OWNER_A)).find(({ status }) => status === "active")!;
    const revoked = await revokeBinding(pool, { ownerUserId: OWNER_A, bindingId: active.id, expectedRevision: 1 });
    expect(revoked.cancelledDeliveries).toBe(1);
    expect(await telegramDelivery(OWNER_A)).toMatchObject({ status: "cancelled", error_code: "binding_revoked" });

    // A row that survives revocation (crash between revoke and cancel) is
    // cancelled by the lane before any external send.
    await activateBinding(OWNER_A, "504");
    await triggerPriceAlert("telegram:cancel-lane");
    await pool.query(
      `UPDATE notification_bindings SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE owner_user_id = $1 AND status = 'active'`,
      [OWNER_A]
    );
    const api = new FakeSendApi();
    await expect(deliveryLane(api).sweep()).resolves.toMatchObject({ claimed: 1, cancelled: 1, delivered: 0 });
    expect(api.calls).toEqual([]);
    const rows = await deliveryRows(OWNER_A);
    expect(rows.filter((row) => row.channel === "telegram").map((row) => row.status).sort()).toEqual(["cancelled", "cancelled"]);
  });

  it("activates bindings through the real ingress lane and replays redeliveries as no-ops", async () => {
    const code = await createBindingCode(pool, OWNER_A);
    const api = new FakeIngressApi([
      [{ update_id: 9001, message: { chat: { id: 444, type: "private" }, text: `/start ${code.code}` } }],
      [
        { update_id: 9001, message: { chat: { id: 444, type: "private" }, text: `/start ${code.code}` } },
        { update_id: 9002, message: { chat: { id: 444, type: "private" }, text: "/help" } }
      ]
    ]);
    const lane = new TelegramIngressLane(pool, {
      workerId: "telegram-test:ingress",
      api: api as unknown as TelegramApi,
      botFingerprint: BOT,
      limits: createTelegramIngressRateLimits()
    });

    await expect(lane.sweep()).resolves.toMatchObject({ held: true, polled: 1, activated: 1 });
    const binding = await pool.query("SELECT status, recipient_chat_id FROM notification_bindings WHERE owner_user_id = $1", [OWNER_A]);
    expect(binding.rows).toEqual([{ status: "active", recipient_chat_id: "444" }]);
    const recorded = await pool.query(
      "SELECT update_id::int AS update_id, chat_fingerprint, kind, outcome FROM telegram_updates WHERE bot_fingerprint = $1 ORDER BY update_id",
      [BOT]
    );
    expect(recorded.rows).toEqual([{ update_id: 9001, chat_fingerprint: recipientFingerprint("444"), kind: "bind_command", outcome: "activated" }]);
    expect(api.sent.map(({ text }) => text.slice(0, 22))).toEqual(["Telegram notifications"]);

    // Telegram redelivers 9001 beside new work: the PK makes it a no-op.
    await expect(lane.sweep()).resolves.toMatchObject({ held: true, polled: 2, replayed: 1, replied: 1, activated: 0 });
    expect(api.polledOffsets).toEqual([1, 9002]);
    const consumers = await pool.query(
      "SELECT cursor_update_id::int AS cursor, lease_generation::int AS generation FROM telegram_ingress_consumers WHERE bot_fingerprint = $1",
      [BOT]
    );
    expect(consumers.rows).toEqual([{ cursor: 9002, generation: 1 }]);
    const bindingsAfter = await pool.query("SELECT count(*)::int AS total FROM notification_bindings WHERE owner_user_id = $1", [OWNER_A]);
    expect(bindingsAfter.rows[0]).toEqual({ total: 1 });
  });

  it("fences the durable cursor by lease generation across takeover and crash simulations", async () => {
    const leaseA = (await acquireConsumerLease(pool, BOT, "worker-a"))!;
    expect(leaseA).toMatchObject({ leaseGeneration: 1, cursorUpdateId: 0 });
    expect(await acquireConsumerLease(pool, BOT, "worker-b")).toBeUndefined();

    // Crash before commit: recorded updates and the cursor advance both vanish.
    await withClient(async (client) => {
      await client.query("BEGIN");
      await recordUpdate(client, 1);
      expect(await advanceConsumerCursor(client, leaseA, 1)).toBe(true);
      await client.query("ROLLBACK");
    });
    expect(await cursorState()).toEqual({ cursor: 0, generation: 1 });
    expect((await pool.query("SELECT count(*)::int AS total FROM telegram_updates WHERE bot_fingerprint = $1", [BOT])).rows[0]).toEqual({ total: 0 });

    // The committed batch is durable and a replayed update becomes a no-op.
    await withClient(async (client) => {
      await client.query("BEGIN");
      expect((await recordUpdate(client, 1)).rowCount).toBe(1);
      expect(await advanceConsumerCursor(client, leaseA, 1)).toBe(true);
      await client.query("COMMIT");
    });
    expect((await recordUpdate(pool, 1)).rowCount).toBe(0);

    // Takeover: the expired holder can neither renew nor move the cursor.
    await pool.query("UPDATE telegram_ingress_consumers SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE bot_fingerprint = $1", [BOT]);
    expect(await renewConsumerLease(pool, leaseA)).toBe(false);
    const leaseB = (await acquireConsumerLease(pool, BOT, "worker-b"))!;
    expect(leaseB).toMatchObject({ leaseGeneration: 2, cursorUpdateId: 1 });
    await withClient(async (client) => {
      await client.query("BEGIN");
      expect(await advanceConsumerCursor(client, leaseA, 5)).toBe(false);
      expect(await advanceConsumerCursor(client, leaseB, 2)).toBe(true);
      await client.query("COMMIT");
    });

    // Crash after commit: a successor resumes from the durable cursor.
    const resumed = (await acquireConsumerLease(pool, BOT, "worker-b"))!;
    expect(resumed.cursorUpdateId).toBe(2);
    expect(await cursorState()).toEqual({ cursor: 2, generation: 3 });
  });
});

/** Scripted sendMessage double for the delivery lane. */
class FakeSendApi {
  readonly calls: Array<{ chatId: string; text: string }> = [];
  private nextOutcome: (() => { messageId: string }) | undefined;

  plan(outcome: () => { messageId: string }): void {
    this.nextOutcome = outcome;
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    this.calls.push({ chatId, text });
    const outcome = this.nextOutcome ?? (() => ({ messageId: String(this.calls.length) }));
    return outcome();
  }
}

/** Scripted getUpdates/sendMessage double for the ingress lane. */
class FakeIngressApi {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly polledOffsets: number[] = [];

  constructor(private readonly batches: TelegramUpdateEnvelope[][]) {}

  async getUpdates(offset: number): Promise<TelegramUpdateEnvelope[]> {
    this.polledOffsets.push(offset);
    return this.batches.shift() ?? [];
  }

  async sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
}

function deliveryLane(api: FakeSendApi): TelegramDeliveryLane {
  return new TelegramDeliveryLane(pool, {
    workerId: "telegram-test:delivery",
    api: api as unknown as TelegramApi,
    limits: createTelegramSendRateLimits(),
    onError: (error, phase) => {
      throw new Error(`Unexpected delivery lane ${phase} error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function consumeInTransaction(rawCode: string, chatId: string): Promise<ConsumeBindingCodeResult> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      const result = await consumeBindingCode(client, rawCode, chatId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function activateBinding(ownerUserId: string, chatId: string): Promise<string> {
  const code = await createBindingCode(pool, ownerUserId);
  const consumed = await consumeInTransaction(code.code, chatId);
  if (consumed.outcome !== "activated") throw new Error("Expected the binding code to activate.");
  return consumed.bindingId;
}

async function revokeAllBindings(ownerUserId: string): Promise<void> {
  await pool.query(
    `UPDATE notification_bindings SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE owner_user_id = $1 AND status <> 'revoked'`,
    [ownerUserId]
  );
}

async function recordUpdate(database: Pool | PoolClient, updateId: number) {
  return database.query(
    `INSERT INTO telegram_updates (bot_fingerprint, update_id, chat_fingerprint, kind, outcome)
     VALUES ($1, $2, NULL, 'non_message', 'ignored')
     ON CONFLICT (bot_fingerprint, update_id) DO NOTHING`,
    [BOT, updateId]
  );
}

async function cursorState() {
  const result = await pool.query<{ cursor: number; generation: number }>(
    "SELECT cursor_update_id::int AS cursor, lease_generation::int AS generation FROM telegram_ingress_consumers WHERE bot_fingerprint = $1",
    [BOT]
  );
  return result.rows[0];
}

interface DeliveryRow {
  id: string;
  channel: string;
  status: string;
  binding_id: string | null;
  binding_revision: number | null;
  attempt: number;
  lease_owner: string | null;
  provider_receipt: string | null;
  error_code: string | null;
  deduplication_key: string;
  terminal: boolean;
  delay_s: number;
}

async function deliveryRows(ownerUserId: string): Promise<DeliveryRow[]> {
  const result = await pool.query<DeliveryRow>(
    `SELECT id, channel, status, binding_id, binding_revision::int AS binding_revision, attempt::int AS attempt,
       lease_owner, provider_receipt, error_code, deduplication_key,
       terminal_at IS NOT NULL AS terminal,
       extract(epoch FROM run_after - clock_timestamp())::float AS delay_s
     FROM notification_deliveries WHERE owner_user_id = $1 ORDER BY created_at ASC, id ASC`,
    [ownerUserId]
  );
  return result.rows;
}

async function telegramDelivery(ownerUserId: string): Promise<DeliveryRow> {
  const rows = (await deliveryRows(ownerUserId)).filter((row) => row.channel === "telegram");
  if (rows.length !== 1) throw new Error(`Expected exactly one telegram delivery, found ${rows.length}.`);
  return rows[0]!;
}

async function makeDeliveryDue(deliveryId: string): Promise<void> {
  // run_after may never precede created_at; the creation instant is already due.
  await pool.query("UPDATE notification_deliveries SET run_after = created_at WHERE id = $1", [deliveryId]);
}

async function makeDue(ruleId: string): Promise<void> {
  await pool.query("UPDATE alert_rules SET next_evaluation_at = clock_timestamp() - interval '1 second' WHERE id = $1", [ruleId]);
}

function priceDefinition(name: string): PriceThresholdAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name,
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app", "telegram"],
    researchOnly: true,
    executionPermission: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    symbol: "BTCUSDT",
    timeframe: "1m",
    direction: "above",
    threshold: "101",
    crossing: "inclusive",
    repeat: "once-until-rearmed"
  };
}

/** Create, seed, claim and complete one triggered price alert for OWNER_A. */
async function triggerPriceAlert(clientId: string): Promise<void> {
  const rule = await repository.create({
    ownerUserId: OWNER_A,
    actorUserId: OWNER_A,
    authorizationRevision: 1,
    clientId,
    definition: priceDefinition(clientId)
  });
  await seedInitializedState(rule.id, rule.currentRevision, rule.definition);
  const claimed = await repository.claimDuePriceAlert({ workerId: `telegram-test:${clientId}`, leaseMs: 30_000 });
  if (!claimed || claimed.id !== rule.id) throw new Error(`Expected to claim ${clientId}.`);
  const result = await repository.completePriceEvaluation(completion(claimed, firstBarAfterArming(claimed), 102));
  if (result.outcome !== "applied") throw new Error(`Expected an applied trigger for ${clientId}.`);
}

function firstBarAfterArming(claimed: ClaimedPriceAlertRule): number {
  return claimed.state.lastEvaluatedBarTime === undefined
    ? Math.floor(claimed.state.armedAt / MINUTE) * MINUTE
    : claimed.state.lastEvaluatedBarTime + MINUTE;
}

function completion(claimed: ClaimedPriceAlertRule, candleOpenTime: number, close: number): CompletePriceEvaluationInput {
  const subjectKey = priceThresholdAlertScopeKey(claimed.definition);
  const observationKey = `${subjectKey}:bar:${candleOpenTime}`;
  const evidenceFingerprint = hash(JSON.stringify(["telegram-observation-v1", claimed.id, observationKey, close]));
  const transitionKey = hash(
    JSON.stringify(["price-threshold-transition-v1", claimed.id, claimed.currentRevision, claimed.definition.direction, claimed.definition.threshold, observationKey, evidenceFingerprint])
  );
  return {
    ownerUserId: claimed.ownerUserId,
    ruleId: claimed.id,
    expectedRevision: claimed.currentRevision,
    authorizationRevision: claimed.authorizationRevision,
    workerId: claimed.workerId,
    leaseToken: claimed.leaseToken,
    leaseGeneration: claimed.leaseGeneration,
    expectedStateRevision: claimed.stateRevision,
    observation: {
      schemaVersion: "price-threshold-observation-v1",
      subjectKey,
      observationKey,
      evidenceFingerprint,
      candleOpenTime,
      candleCloseTime: candleOpenTime + MINUTE,
      evaluatedAt: candleOpenTime + MINUTE,
      close,
      researchOnly: true,
      executionPermission: false
    },
    nextState: {
      status: "triggered",
      armedAt: claimed.state.armedAt,
      initialized: true,
      eligible: true,
      lastEvaluatedBarTime: candleOpenTime,
      triggeredByTransitionKey: transitionKey
    },
    transition: {
      kind: "price-threshold-triggered",
      ruleId: claimed.id,
      ruleRevision: claimed.currentRevision,
      from: "armed",
      to: "triggered",
      subjectKey,
      transitionKey,
      observationKey,
      evidenceFingerprint,
      occurredAt: candleOpenTime + MINUTE,
      observedPrice: close,
      threshold: claimed.definition.threshold,
      direction: claimed.definition.direction,
      researchOnly: true,
      executionPermission: false
    }
  };
}

async function seedInitializedState(ruleId: string, ruleRevision: number, document: unknown): Promise<void> {
  const parsed = document as PriceThresholdAlertDefinitionV1;
  const stateKey = priceThresholdAlertScopeKey(parsed);
  const clock = await pool.query<{ now_ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms");
  const latestClosedOpen = Math.floor(Number(clock.rows[0]!.now_ms) / MINUTE) * MINUTE - MINUTE;
  const cursor = latestClosedOpen - 2 * MINUTE;
  const observationId = `${stateKey}:bar:${cursor}`;
  await pool.query(
    `INSERT INTO alert_rule_states (
       owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
       state_status, initialized, eligible, armed, last_observation_id,
       last_observation_hash, last_evaluated_bar_time, state, last_evaluated_at
     ) VALUES ($1,$2,$3,$4,1,'ineligible',TRUE,FALSE,TRUE,$5,$6,$7,$8::jsonb,statement_timestamp())`,
    [OWNER_A, ruleId, stateKey, ruleRevision, observationId, hash(`seed:${ruleId}:${cursor}`), cursor, JSON.stringify({ status: "armed", armedAt: cursor, initialized: true, eligible: false, lastEvaluatedBarTime: cursor })]
  );
}

function screenerDefinition(): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Telegram screen alert",
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app", "telegram"],
    researchOnly: true,
    executionPermission: false,
    screen: {
      schemaVersion: "screener-definition-v1",
      kind: "technical",
      name: "Telegram screen",
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      timeframe: "5m",
      universeLimit: 10,
      sort: { key: "symbol", direction: "asc" },
      filters: [{ kind: "price", min: "100", max: "200" }],
      researchOnly: true,
      executionPermission: false
    },
    repeat: "on-change"
  };
}

async function screenerSweep(snap: ScreenerMarketDataSnapshotV1): Promise<void> {
  const errors: unknown[] = [];
  await runScreenerAlertSweep(repository, {
    workerId: "telegram-test:screener",
    marketData: async () => snap,
    onError: (error) => errors.push(error)
  });
  expect(errors).toEqual([]);
}

function snapshot(barTime: number, matched: readonly string[]): ScreenerMarketDataSnapshotV1 {
  const matchedSet = new Set(matched);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    const close = matchedSet.has(symbol) ? 150 : 50;
    candlesBySymbol.set(symbol, [candle(barTime - 2 * BAR, close), candle(barTime - BAR, close), candle(barTime, close)]);
  }
  return {
    observedAt: Date.now(),
    universe: SYMBOLS.map((symbol) => ({ symbol })),
    candlesBySymbol,
    unavailableReasonBySymbol: new Map()
  };
}

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10, final: true, source: "public-test" };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
