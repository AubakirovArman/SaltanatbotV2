import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { hashBindingCode } from "../src/notifications/bindingService.js";
import { acquireConsumerLease, advanceConsumerCursor, releaseConsumerLease, renewConsumerLease } from "../src/notifications/consumerLease.js";
import { TelegramIngressLane } from "../src/notifications/ingressLane.js";
import { createTelegramIngressRateLimits } from "../src/notifications/rateLimits.js";
import type { TelegramApi, TelegramUpdateEnvelope } from "../src/notifications/telegramApi.js";

const BOT = "b".repeat(64);
const OWNER = "00000000-0000-4000-8000-0000000000c1";
const RAW_CODE = "abcdefghijklmnopqrstuv2345";

interface ConsumerRow {
  generation: number;
  owner?: string;
  token?: string;
  expiresAt?: number;
  cursor: number;
}

interface UpdateRow {
  chatFingerprint: string | null;
  kind: string;
  outcome: string;
}

/**
 * In-memory double for the ingress tables with real BEGIN/ROLLBACK semantics,
 * so batch atomicity and lease/cursor fencing behave like PostgreSQL.
 */
class FakeIngressDatabase {
  consumer: ConsumerRow | undefined;
  updates = new Map<number, UpdateRow>();
  codeByHash = new Map<string, { id: string; owner: string }>();
  bindingInserts: Array<readonly unknown[]> = [];
  recordedParams: unknown[] = [];
  events: string[] = [];
  private snapshot: { consumer: ConsumerRow | undefined; updates: Map<number, UpdateRow>; codeByHash: Map<string, { id: string; owner: string }>; bindingInserts: Array<readonly unknown[]> } | undefined;

  readonly pool = {
    query: (sql: string, params: readonly unknown[] = []) => this.execute(sql, params),
    connect: async () =>
      ({
        query: (sql: string, params: readonly unknown[] = []) => this.execute(sql, params),
        release: () => undefined
      }) as unknown as PoolClient
  } as unknown as Pool;

  private async execute(rawSql: string, params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    this.recordedParams.push(...params);
    if (sql === "BEGIN") {
      this.snapshot = {
        consumer: this.consumer && { ...this.consumer },
        updates: new Map([...this.updates].map(([key, row]) => [key, { ...row }])),
        codeByHash: new Map(this.codeByHash),
        bindingInserts: [...this.bindingInserts]
      };
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      if (sql === "ROLLBACK" && this.snapshot) {
        this.consumer = this.snapshot.consumer;
        this.updates = this.snapshot.updates;
        this.codeByHash = this.snapshot.codeByHash;
        this.bindingInserts = this.snapshot.bindingInserts;
      }
      this.snapshot = undefined;
      this.events.push(sql.toLowerCase());
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO telegram_ingress_consumers")) {
      this.consumer ??= { generation: 0, cursor: 0 };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET lease_generation = lease_generation + 1")) {
      const row = this.consumer!;
      const free = row.owner === undefined || (row.expiresAt ?? 0) <= Date.now() || row.owner === params[1];
      if (!free) return { rows: [], rowCount: 0 };
      row.generation += 1;
      row.owner = params[1] as string;
      row.token = params[2] as string;
      row.expiresAt = Date.now() + (params[3] as number);
      return { rows: [{ lease_generation: row.generation, cursor_update_id: row.cursor }], rowCount: 1 };
    }
    if (sql.includes("SET lease_owner = NULL")) {
      const row = this.consumer;
      if (!row || row.owner !== params[1] || row.token !== params[2] || row.generation !== params[3]) return { rows: [], rowCount: 0 };
      row.owner = row.token = row.expiresAt = undefined;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET cursor_update_id = $5")) {
      const row = this.consumer;
      const fenced =
        row && row.owner === params[1] && row.token === params[2] && row.generation === params[3] && (row.expiresAt ?? 0) > Date.now() && row.cursor < (params[4] as number);
      if (!fenced) return { rows: [], rowCount: 0 };
      row.cursor = params[4] as number;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET lease_expires_at")) {
      const row = this.consumer;
      const fenced = row && row.owner === params[1] && row.token === params[2] && row.generation === params[3] && (row.expiresAt ?? 0) > Date.now();
      if (!fenced) return { rows: [], rowCount: 0 };
      row.expiresAt = Date.now() + (params[4] as number);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO telegram_updates")) {
      const updateId = params[1] as number;
      if (this.updates.has(updateId)) return { rows: [], rowCount: 0 };
      this.updates.set(updateId, { chatFingerprint: params[2] as string | null, kind: params[3] as string, outcome: params[4] as string });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE telegram_updates SET outcome")) {
      this.updates.get(params[1] as number)!.outcome = params[2] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM notification_binding_codes")) {
      const found = this.codeByHash.get(params[0] as string);
      return { rows: found ? [{ id: found.id, owner_user_id: found.owner }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("SELECT id FROM notification_bindings")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO notification_bindings")) {
      this.bindingInserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET consumed_at")) {
      for (const [hash, row] of this.codeByHash) if (row.id === params[0]) this.codeByHash.delete(hash);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

interface Harness {
  database: FakeIngressDatabase;
  lane: TelegramIngressLane;
  getUpdates: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  errors: Array<{ error: unknown; phase: string }>;
}

function harness(batches: TelegramUpdateEnvelope[][]): Harness {
  const database = new FakeIngressDatabase();
  const errors: Array<{ error: unknown; phase: string }> = [];
  const getUpdates = vi.fn(async () => batches.shift() ?? []);
  const sendMessage = vi.fn(async (chatId: string) => {
    database.events.push(`reply:${chatId}`);
    return { messageId: "1" };
  });
  const lane = new TelegramIngressLane(database.pool, {
    workerId: "ingress-test:1",
    api: { getUpdates, sendMessage } as unknown as TelegramApi,
    botFingerprint: BOT,
    limits: createTelegramIngressRateLimits(),
    onError: (error, phase) => errors.push({ error, phase })
  });
  return { database, lane, getUpdates, sendMessage, errors };
}

function privateMessage(updateId: number, chatId: string, text: string): TelegramUpdateEnvelope {
  return { update_id: updateId, message: { chat: { id: chatId, type: "private" }, text } };
}

function fingerprint(chatId: string): string {
  return createHash("sha256").update(chatId, "utf8").digest("hex");
}

describe("telegram ingress lane", () => {
  it("does not poll while another consumer holds an unexpired lease", async () => {
    const { database, lane, getUpdates } = harness([]);
    database.consumer = { generation: 3, owner: "other-consumer", token: "t".repeat(64), expiresAt: Date.now() + 60_000, cursor: 5 };

    await expect(lane.sweep()).resolves.toMatchObject({ held: false, polled: 0 });
    expect(getUpdates).not.toHaveBeenCalled();
    expect(database.consumer.generation).toBe(3);
  });

  it("takes over an expired lease with a new generation and polls from the durable cursor", async () => {
    const { database, lane, getUpdates } = harness([[]]);
    database.consumer = { generation: 3, owner: "crashed-consumer", token: "t".repeat(64), expiresAt: Date.now() - 1_000, cursor: 41 };

    await expect(lane.sweep()).resolves.toMatchObject({ held: true, polled: 0 });
    expect(getUpdates).toHaveBeenCalledWith(42);
    expect(database.consumer).toMatchObject({ generation: 4, owner: "ingress-test:1" });
  });

  it("normalizes a mixed batch, stores only hashed identifiers, and replies after commit", async () => {
    const batch: TelegramUpdateEnvelope[] = [
      { update_id: 100 },
      { update_id: 101, message: { chat: { id: -500123, type: "group" }, text: `/start ${RAW_CODE}` } },
      privateMessage(102, "555", "/help"),
      privateMessage(103, "556", `/start ${RAW_CODE}`),
      privateMessage(104, "557", "what is this")
    ];
    const { database, lane, sendMessage } = harness([batch]);

    const result = await lane.sweep();

    expect(result).toMatchObject({ held: true, polled: 5, ignored: 2, replied: 2, invalidCodes: 1, activated: 0, rateLimited: 0, replayed: 0 });
    expect([...database.updates.entries()].map(([id, row]) => [id, row.kind, row.outcome])).toEqual([
      [100, "non_message", "ignored"],
      [101, "group_message", "ignored"],
      [102, "help_command", "replied"],
      [103, "bind_command", "invalid_code"],
      [104, "other_message", "replied"]
    ]);
    expect(database.updates.get(102)!.chatFingerprint).toBe(fingerprint("555"));
    expect(database.consumer!.cursor).toBe(104);
    // Raw chat ids and message text never reach the telegram_updates rows.
    for (const row of database.updates.values()) {
      expect([row.kind, row.outcome, row.chatFingerprint]).not.toContain("555");
      expect(row.chatFingerprint === null || /^[0-9a-f]{64}$/.test(row.chatFingerprint)).toBe(true);
    }
    // Replies are sent only once the batch transaction is durable.
    const commitIndex = database.events.indexOf("commit");
    const firstReply = database.events.findIndex((event) => event.startsWith("reply:"));
    expect(commitIndex).toBeGreaterThan(-1);
    expect(firstReply).toBeGreaterThan(commitIndex);
    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual(["555", "556", "557"]);
  });

  it("activates a binding via /start <code> and treats redelivered updates as no-ops", async () => {
    const { database, lane, getUpdates, sendMessage } = harness([
      [privateMessage(200, "777", `/start ${RAW_CODE}`)],
      [privateMessage(200, "777", `/start ${RAW_CODE}`), privateMessage(201, "777", "/help")]
    ]);
    database.codeByHash.set(hashBindingCode(RAW_CODE), { id: "code-1", owner: OWNER });

    await expect(lane.sweep()).resolves.toMatchObject({ activated: 1, invalidCodes: 0 });
    expect(database.updates.get(200)).toMatchObject({ kind: "bind_command", outcome: "activated" });
    expect(database.bindingInserts).toEqual([[expect.any(String), OWNER, fingerprint("777"), "777"]]);
    expect(sendMessage.mock.calls[0]![1]).toMatch(/notifications are now bound/i);

    // Telegram redelivers update 200: the (bot, update_id) key makes it a no-op.
    await expect(lane.sweep()).resolves.toMatchObject({ replayed: 1, replied: 1, activated: 0 });
    expect(getUpdates).toHaveBeenLastCalledWith(201);
    expect(database.bindingInserts).toHaveLength(1);
    expect(database.updates.get(200)!.outcome).toBe("activated");
    expect(database.consumer!.cursor).toBe(201);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("rolls back the whole batch and drops the lease when the cursor fence is lost mid-poll", async () => {
    const database = new FakeIngressDatabase();
    const sendMessage = vi.fn();
    const getUpdates = vi.fn(async () => {
      // A takeover lands while our long poll is parked on Telegram.
      database.consumer = { generation: database.consumer!.generation + 1, owner: "usurper", token: "u".repeat(64), expiresAt: Date.now() + 60_000, cursor: database.consumer!.cursor };
      return [privateMessage(300, "888", "/help")];
    });
    const lane = new TelegramIngressLane(database.pool, {
      workerId: "ingress-test:1",
      api: { getUpdates, sendMessage } as unknown as TelegramApi,
      botFingerprint: BOT,
      limits: createTelegramIngressRateLimits()
    });

    await expect(lane.sweep()).resolves.toMatchObject({ held: false, polled: 1 });
    expect(database.events).toContain("rollback");
    expect(database.updates.has(300)).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rate limits commands per hashed chat and binding attempts more strictly", async () => {
    const helpBatch = Array.from({ length: 7 }, (_, index) => privateMessage(400 + index, "888", "/help"));
    const bindBatch = Array.from({ length: 6 }, (_, index) => privateMessage(500 + index, "999", `/bind ${RAW_CODE}`));
    const { database, lane, sendMessage } = harness([helpBatch, bindBatch]);

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 6, rateLimited: 1 });
    expect(database.updates.get(406)!.outcome).toBe("rate_limited");
    expect(sendMessage).toHaveBeenCalledTimes(6);

    // Binding attempts cap at 5 per 10 minutes even though 6 commands fit.
    await expect(lane.sweep()).resolves.toMatchObject({ invalidCodes: 5, rateLimited: 1 });
    expect(database.updates.get(505)!.outcome).toBe("rate_limited");
  });
});

describe("consumer lease fencing", () => {
  it("fences renew, release and cursor advance on owner, token and generation", async () => {
    const database = new FakeIngressDatabase();
    const client = (await database.pool.connect()) as PoolClient;

    const first = (await acquireConsumerLease(database.pool, BOT, "consumer-a"))!;
    expect(first).toMatchObject({ leaseGeneration: 1, cursorUpdateId: 0 });
    expect(await acquireConsumerLease(database.pool, BOT, "consumer-b")).toBeUndefined();
    expect(await renewConsumerLease(database.pool, first)).toBe(true);
    expect(await renewConsumerLease(database.pool, { ...first, leaseToken: "f".repeat(64) })).toBe(false);
    expect(await renewConsumerLease(database.pool, { ...first, leaseGeneration: 99 })).toBe(false);

    expect(await advanceConsumerCursor(client, first, 10)).toBe(true);
    // Forward-only: an equal or smaller cursor is a fence failure, not a rewind.
    expect(await advanceConsumerCursor(client, first, 10)).toBe(false);
    expect(await advanceConsumerCursor(client, first, 9)).toBe(false);
    await expect(advanceConsumerCursor(client, first, -1)).rejects.toThrow(/nonnegative/);

    expect(await releaseConsumerLease(database.pool, first)).toBe(true);
    const second = (await acquireConsumerLease(database.pool, BOT, "consumer-b"))!;
    expect(second).toMatchObject({ leaseGeneration: 2, cursorUpdateId: 10 });
    // The paused former holder can no longer renew, advance or release.
    expect(await renewConsumerLease(database.pool, first)).toBe(false);
    expect(await advanceConsumerCursor(client, first, 11)).toBe(false);
    expect(await releaseConsumerLease(database.pool, first)).toBe(false);
    expect(await advanceConsumerCursor(client, second, 11)).toBe(true);
  });
});
