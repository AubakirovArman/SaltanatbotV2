import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  BINDING_CODE_MAX_OUTSTANDING,
  BindingCodeQuotaError,
  BindingNotFoundError,
  BindingRevisionConflictError,
  consumeBindingCode,
  createBindingCode,
  hashBindingCode,
  listBindings,
  queueTelegramDeliveryForActiveBinding,
  recipientFingerprint,
  revokeBinding,
  telegramDeliveryCounters
} from "../src/notifications/bindingService.js";

const OWNER = "00000000-0000-4000-8000-000000000091";
const BINDING_ID = "00000000-0000-4000-8000-0000000000a1";
const CHAT_ID = "987654321";

interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
}

/** Scripted pg double: answers by SQL substring, records every statement. */
function fakePool(answers: Array<{ match: RegExp; rows?: unknown[]; rowCount?: number }>) {
  const queries: RecordedQuery[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    queries.push({ sql, params });
    for (const answer of answers) {
      if (answer.match.test(sql)) return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? answer.rows?.length ?? 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  return { pool, client, queries };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("binding code creation", () => {
  it("returns a 26-character base32 raw code once and stores only its sha256", async () => {
    const database = fakePool([
      { match: /count\(\*\)::int AS live/, rows: [{ live: 0 }] },
      { match: /INSERT INTO notification_binding_codes/, rows: [{ id: BINDING_ID, expires_at: new Date("2026-07-17T10:10:00.000Z") }] }
    ]);

    const created = await createBindingCode(database.pool, OWNER);

    expect(created.code).toMatch(/^[a-z2-7]{26}$/);
    expect(created).toMatchObject({ id: BINDING_ID, expiresAt: "2026-07-17T10:10:00.000Z" });
    const insert = database.queries.find((query) => query.sql.includes("INSERT INTO notification_binding_codes"))!;
    expect(insert.params[1]).toBe(sha256(created.code));
    // The raw code must never travel to the database in any statement.
    expect(database.queries.every((query) => !query.params.includes(created.code))).toBe(true);
    expect(database.queries.some((query) => query.sql.includes("FROM users") && query.sql.includes("FOR UPDATE"))).toBe(true);
    expect(database.queries.map((query) => query.sql)).toContain("COMMIT");
  });

  it("refuses a fourth outstanding code inside the owner-serialized transaction", async () => {
    const database = fakePool([{ match: /count\(\*\)::int AS live/, rows: [{ live: BINDING_CODE_MAX_OUTSTANDING }] }]);

    await expect(createBindingCode(database.pool, OWNER)).rejects.toBeInstanceOf(BindingCodeQuotaError);
    expect(database.queries.some((query) => query.sql.includes("INSERT INTO notification_binding_codes"))).toBe(false);
    expect(database.queries.map((query) => query.sql)).toContain("ROLLBACK");
  });
});

describe("binding code consumption", () => {
  it("rejects malformed chat ids before any database work", async () => {
    const database = fakePool([]);
    await expect(consumeBindingCode(database.client, "somecodevalue26chars12345", "not-a-chat")).resolves.toEqual({ outcome: "invalid_code" });
    expect(database.queries).toHaveLength(0);
  });

  it("looks up the trimmed code by hash and reports unknown codes as invalid", async () => {
    const database = fakePool([]);
    const raw = "abcdefghijklmnopqrstuv2345";

    await expect(consumeBindingCode(database.client, `  ${raw} `, CHAT_ID)).resolves.toEqual({ outcome: "invalid_code" });
    expect(database.queries[0]!.sql).toContain("FOR UPDATE");
    expect(database.queries[0]!.params).toEqual([hashBindingCode(raw)]);
  });

  it("replaces the previous active binding and activates the new chat in one pass", async () => {
    const previousId = "00000000-0000-4000-8000-0000000000b2";
    const database = fakePool([
      { match: /FROM notification_binding_codes/, rows: [{ id: "code-1", owner_user_id: OWNER }] },
      { match: /SELECT id FROM notification_bindings/, rows: [{ id: previousId }] },
      { match: /UPDATE notification_deliveries/, rowCount: 2 }
    ]);

    const consumed = await consumeBindingCode(database.client, "abcdefghijklmnopqrstuv2345", CHAT_ID);

    expect(consumed).toMatchObject({ outcome: "activated", ownerUserId: OWNER, replacedBindingId: previousId });
    const statements = database.queries.map((query) => query.sql.replace(/\s+/g, " "));
    expect(statements.some((sql) => sql.includes("UPDATE notification_bindings") && sql.includes("'revoked'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE notification_deliveries") && sql.includes("'cancelled'"))).toBe(true);
    const insert = database.queries.find((query) => query.sql.includes("INSERT INTO notification_bindings"))!;
    expect(insert.params).toEqual([expect.any(String), OWNER, recipientFingerprint(CHAT_ID), CHAT_ID]);
    const consume = database.queries.find((query) => query.sql.includes("SET consumed_at"))!;
    expect(consume.params).toEqual(["code-1", (consumed as { bindingId: string }).bindingId]);
  });
});

describe("binding listing and revocation", () => {
  it("projects bindings with an 8-character hashed handle and ISO timestamps only", async () => {
    const fingerprint = recipientFingerprint(CHAT_ID);
    const database = fakePool([
      {
        match: /FROM notification_bindings/,
        rows: [
          {
            id: BINDING_ID,
            status: "active",
            revision: "1",
            recipient_fingerprint: fingerprint,
            created_at: new Date("2026-07-17T09:00:00.000Z"),
            activated_at: new Date("2026-07-17T09:01:00.000Z"),
            revoked_at: null
          }
        ]
      }
    ]);

    await expect(listBindings(database.pool, OWNER)).resolves.toEqual([
      {
        id: BINDING_ID,
        status: "active",
        revision: 1,
        recipientHandle: fingerprint.slice(0, 8),
        createdAt: "2026-07-17T09:00:00.000Z",
        activatedAt: "2026-07-17T09:01:00.000Z"
      }
    ]);
  });

  it("fences revocation on the expected revision and surfaces not-found distinctly", async () => {
    const missing = fakePool([]);
    await expect(revokeBinding(missing.pool, { ownerUserId: OWNER, bindingId: BINDING_ID, expectedRevision: 1 })).rejects.toBeInstanceOf(BindingNotFoundError);

    const row = {
      id: BINDING_ID,
      status: "active",
      revision: "2",
      recipient_fingerprint: recipientFingerprint(CHAT_ID),
      created_at: new Date("2026-07-17T09:00:00.000Z"),
      activated_at: new Date("2026-07-17T09:01:00.000Z"),
      revoked_at: null
    };
    const stale = fakePool([{ match: /FOR UPDATE/, rows: [row] }]);
    await expect(revokeBinding(stale.pool, { ownerUserId: OWNER, bindingId: BINDING_ID, expectedRevision: 1 })).rejects.toBeInstanceOf(BindingRevisionConflictError);
    expect(stale.queries.map((query) => query.sql)).toContain("ROLLBACK");
  });

  it("revokes and cancels queued deliveries in the same transaction", async () => {
    const row = {
      id: BINDING_ID,
      status: "active",
      revision: "1",
      recipient_fingerprint: recipientFingerprint(CHAT_ID),
      created_at: new Date("2026-07-17T09:00:00.000Z"),
      activated_at: new Date("2026-07-17T09:01:00.000Z"),
      revoked_at: null
    };
    const database = fakePool([
      { match: /FOR UPDATE/, rows: [row] },
      { match: /SET status = 'revoked'/, rows: [{ ...row, status: "revoked", revoked_at: new Date("2026-07-17T09:05:00.000Z") }] },
      { match: /UPDATE notification_deliveries/, rowCount: 3 }
    ]);

    const result = await revokeBinding(database.pool, { ownerUserId: OWNER, bindingId: BINDING_ID, expectedRevision: 1 });

    expect(result.binding).toMatchObject({ id: BINDING_ID, status: "revoked", revokedAt: "2026-07-17T09:05:00.000Z" });
    expect(result.cancelledDeliveries).toBe(3);
    const commitIndex = database.queries.findIndex((query) => query.sql === "COMMIT");
    const cancelIndex = database.queries.findIndex((query) => query.sql.includes("UPDATE notification_deliveries"));
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeLessThan(commitIndex);
  });
});

describe("completion-path telegram queueing", () => {
  it("skips silently (counted) when the owner has no active binding", async () => {
    const database = fakePool([]);
    const skippedBefore = telegramDeliveryCounters.skippedWithoutBinding;

    await expect(
      queueTelegramDeliveryForActiveBinding(database.client, { ownerUserId: OWNER, outboxId: BINDING_ID, deduplicationKey: "dedup-1" })
    ).resolves.toEqual({ queued: false });

    expect(telegramDeliveryCounters.skippedWithoutBinding).toBe(skippedBefore + 1);
    expect(database.queries.some((query) => query.sql.includes("INSERT INTO notification_deliveries"))).toBe(false);
  });

  it("queues one telegram delivery pinned to the active binding revision", async () => {
    const database = fakePool([{ match: /SELECT id, revision FROM notification_bindings/, rows: [{ id: BINDING_ID, revision: "4" }] }]);
    const queuedBefore = telegramDeliveryCounters.queued;

    await expect(
      queueTelegramDeliveryForActiveBinding(database.client, { ownerUserId: OWNER, outboxId: "outbox-1", deduplicationKey: "dedup-2" })
    ).resolves.toEqual({ queued: true });

    expect(telegramDeliveryCounters.queued).toBe(queuedBefore + 1);
    const insert = database.queries.find((query) => query.sql.includes("INSERT INTO notification_deliveries"))!;
    expect(insert.sql).toContain("'telegram'");
    expect(insert.params).toEqual([expect.any(String), OWNER, "outbox-1", BINDING_ID, 4, "dedup-2"]);
  });
});
