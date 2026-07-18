import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  consumeTelegramConfirmation,
  hashTelegramConfirmationToken,
  issueTelegramConfirmation,
  TELEGRAM_CONFIRMATION_MAX_OUTSTANDING,
  TELEGRAM_CONFIRMATION_TTL_MS,
  type ConsumeTelegramConfirmationInput,
  type IssueTelegramConfirmationInput
} from "../src/notifications/confirmations.js";

const OWNER = "00000000-0000-4000-8000-0000000000f1";
const OUTSIDER = "00000000-0000-4000-8000-0000000000f2";
const BINDING = "00000000-0000-4000-8000-0000000000f3";
const CHAT = "1".repeat(64);
const START = 1_752_000_000_000;

interface ConfirmationRow {
  id: string;
  owner_user_id: string;
  binding_id: string;
  binding_revision: number;
  chat_fingerprint: string;
  action: string;
  portfolio_id: string;
  bot_id: string;
  bot_status_at_issue: string | null;
  portfolio_revision: number;
  ledger_epoch: number;
  bot_revision: number;
  authorization_revision: number;
  token_hash: string;
  expiresAt: number;
  consumedAt: number | undefined;
  consumedUpdateId: number | undefined;
}

/**
 * In-memory double for the telegram_confirmations SQL surface. FOR UPDATE
 * serialization is modeled by the double executing queries one at a time,
 * which matches how PostgreSQL settles the row-lock races the module relies
 * on: the loser of a consume race re-reads the already-consumed row.
 */
class FakeConfirmationDatabase {
  now = START;
  rows: ConfirmationRow[] = [];
  private nextId = 1;

  readonly client = {
    query: (sql: string, params: readonly unknown[] = []) => this.execute(sql, params)
  } as unknown as PoolClient;

  private async execute(rawSql: string, params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT id FROM users")) {
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("count(*)::int AS live")) {
      const live = this.rows.filter(
        (row) => row.owner_user_id === params[0] && row.consumedAt === undefined && row.expiresAt > this.now
      ).length;
      return { rows: [{ live }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO telegram_confirmations")) {
      this.rows.push({
        id: `confirmation-${this.nextId++}`,
        owner_user_id: params[0] as string,
        binding_id: params[1] as string,
        binding_revision: params[2] as number,
        chat_fingerprint: params[3] as string,
        action: params[4] as string,
        portfolio_id: params[5] as string,
        bot_id: params[6] as string,
        bot_status_at_issue: params[7] as string | null,
        portfolio_revision: params[8] as number,
        ledger_epoch: params[9] as number,
        bot_revision: params[10] as number,
        authorization_revision: params[11] as number,
        token_hash: params[12] as string,
        expiresAt: this.now + (params[13] as number),
        consumedAt: undefined,
        consumedUpdateId: undefined
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("WHERE token_hash = $1")) {
      const found = this.rows.find(
        (row) => row.token_hash === params[0] && row.consumedAt === undefined && row.expiresAt > this.now
      );
      return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("SET consumed_at = clock_timestamp()")) {
      const found = this.rows.find((row) => row.id === params[0]);
      if (!found) return { rows: [], rowCount: 0 };
      found.consumedAt = this.now;
      found.consumedUpdateId = params[1] as number;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected telegram confirmation SQL: ${sql}`);
  }
}

function issueInput(overrides: Partial<IssueTelegramConfirmationInput> = {}): IssueTelegramConfirmationInput {
  return {
    ownerUserId: OWNER,
    bindingId: BINDING,
    bindingRevision: 1,
    chatFingerprint: CHAT,
    action: "pause",
    portfolioId: "portfolio-1",
    botId: "bot-abcd1234",
    botStatusAtIssue: "running",
    portfolioRevision: 3,
    ledgerEpoch: 2,
    botRevision: 5,
    authorizationRevision: 7,
    ...overrides
  };
}

function consumeInput(token: string, overrides: Partial<ConsumeTelegramConfirmationInput> = {}): ConsumeTelegramConfirmationInput {
  return {
    token,
    updateId: 9_001,
    chatFingerprint: CHAT,
    ownerUserId: OWNER,
    bindingId: BINDING,
    bindingRevision: 1,
    authorizationRevision: 7,
    ...overrides
  };
}

async function issuedToken(database: FakeConfirmationDatabase, overrides: Partial<IssueTelegramConfirmationInput> = {}): Promise<string> {
  const issued = await issueTelegramConfirmation(database.client, issueInput(overrides));
  if (issued.outcome !== "issued") throw new Error("Expected the confirmation to be issued.");
  return issued.token;
}

describe("telegram confirmation issue", () => {
  it("stores only the sha256 of a fresh base32 token with the 120s TTL and pinned fences", async () => {
    const database = new FakeConfirmationDatabase();
    const issued = await issueTelegramConfirmation(database.client, issueInput());

    expect(issued).toMatchObject({ outcome: "issued", expiresInSeconds: 120 });
    const token = (issued as { token: string }).token;
    expect(token).toMatch(/^[a-z2-7]{16}$/);
    expect(database.rows).toHaveLength(1);
    const row = database.rows[0]!;
    expect(row.token_hash).toBe(hashTelegramConfirmationToken(token));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({
      owner_user_id: OWNER,
      binding_id: BINDING,
      binding_revision: 1,
      chat_fingerprint: CHAT,
      action: "pause",
      portfolio_revision: 3,
      ledger_epoch: 2,
      bot_revision: 5,
      authorization_revision: 7,
      bot_status_at_issue: "running",
      expiresAt: database.now + TELEGRAM_CONFIRMATION_TTL_MS
    });
  });

  it("nulls a non-canonical bot status instead of storing it", async () => {
    const database = new FakeConfirmationDatabase();
    await issuedToken(database, { botStatusAtIssue: "Weird Status!" });
    expect(database.rows[0]!.bot_status_at_issue).toBeNull();
  });

  it("caps outstanding confirmations at three per owner and ignores expired rows", async () => {
    const database = new FakeConfirmationDatabase();
    for (let index = 0; index < TELEGRAM_CONFIRMATION_MAX_OUTSTANDING; index += 1) {
      await issuedToken(database);
    }
    await expect(issueTelegramConfirmation(database.client, issueInput())).resolves.toEqual({
      outcome: "quota_exceeded"
    });
    // Another owner is unaffected; expiry frees the quota without consumption.
    await expect(issueTelegramConfirmation(database.client, issueInput({ ownerUserId: OUTSIDER })))
      .resolves.toMatchObject({ outcome: "issued" });
    database.rows[0]!.expiresAt = database.now - 1;
    await expect(issueTelegramConfirmation(database.client, issueInput())).resolves.toMatchObject({
      outcome: "issued"
    });
  });
});

describe("telegram confirmation consume", () => {
  it("consumes a live token once and returns the pinned action fences", async () => {
    const database = new FakeConfirmationDatabase();
    const token = await issuedToken(database);

    await expect(consumeTelegramConfirmation(database.client, consumeInput(token))).resolves.toEqual({
      outcome: "consumed",
      confirmation: {
        action: "pause",
        portfolioId: "portfolio-1",
        botId: "bot-abcd1234",
        portfolioRevision: 3,
        ledgerEpoch: 2,
        botRevision: 5
      }
    });
    expect(database.rows[0]).toMatchObject({ consumedAt: database.now, consumedUpdateId: 9_001 });

    // A replayed or raced /confirm re-reads the consumed row and loses.
    await expect(consumeTelegramConfirmation(database.client, consumeInput(token, { updateId: 9_002 })))
      .resolves.toEqual({ outcome: "rejected" });
    expect(database.rows[0]!.consumedUpdateId).toBe(9_001);
  });

  it("rejects an expired or unknown token without consuming anything", async () => {
    const database = new FakeConfirmationDatabase();
    const token = await issuedToken(database);
    await expect(consumeTelegramConfirmation(database.client, consumeInput("a".repeat(16))))
      .resolves.toEqual({ outcome: "rejected" });

    database.now += TELEGRAM_CONFIRMATION_TTL_MS + 1;
    await expect(consumeTelegramConfirmation(database.client, consumeInput(token)))
      .resolves.toEqual({ outcome: "rejected" });
    expect(database.rows[0]!.consumedAt).toBeUndefined();
  });

  it("rejects every fence mismatch without burning the token", async () => {
    const database = new FakeConfirmationDatabase();
    const token = await issuedToken(database);
    const mismatches: Array<Partial<ConsumeTelegramConfirmationInput>> = [
      { chatFingerprint: "2".repeat(64) },
      { ownerUserId: OUTSIDER },
      { bindingId: "00000000-0000-4000-8000-0000000000f4" },
      // A rebind or revoke race changes the binding revision underneath.
      { bindingRevision: 2 },
      // Trading access changed between issue and confirm.
      { authorizationRevision: 8 }
    ];

    for (const mismatch of mismatches) {
      await expect(consumeTelegramConfirmation(database.client, consumeInput(token, mismatch)))
        .resolves.toEqual({ outcome: "rejected" });
      expect(database.rows[0]!.consumedAt).toBeUndefined();
    }
    // The token an outsider failed to burn still works for its real context.
    await expect(consumeTelegramConfirmation(database.client, consumeInput(token)))
      .resolves.toMatchObject({ outcome: "consumed" });
  });

  it("refuses a stored action outside the pause/resume/stop contract", async () => {
    const database = new FakeConfirmationDatabase();
    const token = await issuedToken(database);
    database.rows[0]!.action = "archive";
    await expect(consumeTelegramConfirmation(database.client, consumeInput(token)))
      .resolves.toEqual({ outcome: "rejected" });
    expect(database.rows[0]!.consumedAt).toBeUndefined();
  });
});
