import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME,
  TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
  TELEGRAM_REPLY_PURPOSE_READ
} from "../src/notifications/commandBridge.js";
import { hashTelegramConfirmationToken } from "../src/notifications/confirmations.js";
import { createTelegramSendRateLimits } from "../src/notifications/rateLimits.js";
import { TelegramRepliesLane, TELEGRAM_REPLY_TIMEOUT_MS } from "../src/notifications/repliesLane.js";
import type { TelegramApi } from "../src/notifications/telegramApi.js";

const NOW = 1_752_000_000_000;
const OWNER = "00000000-0000-4000-8000-0000000000e1";
const BINDING = "00000000-0000-4000-8000-0000000000e2";
const CHAT_FINGERPRINT = "3".repeat(64);

interface ReplyRow {
  commandId: string;
  ownerUserId: string;
  bindingId: string;
  bindingRevision: number;
  purpose: string;
  requestContext: Record<string, unknown>;
  createdAt: number;
  repliedAt: number | undefined;
}

interface CommandRow {
  status: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
}

interface BindingRow {
  status: string;
  revision: number;
  chatId: string | null;
  fingerprint: string;
  ownerStatus: string;
  authorizationRevision: number;
}

/**
 * In-memory double for the replies-lane SQL surface with BEGIN/ROLLBACK
 * semantics, so the settle-before-send fence behaves like PostgreSQL.
 */
class FakeRepliesDatabase {
  replies = new Map<string, ReplyRow>();
  commands = new Map<string, CommandRow>();
  bindings = new Map<string, BindingRow>();
  confirmations: Array<Record<string, unknown>> = [];
  events: string[] = [];
  onBegin: (() => void) | undefined;
  private snapshot: { replies: Map<string, ReplyRow>; confirmations: Array<Record<string, unknown>> } | undefined;

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
    if (sql === "BEGIN") {
      this.snapshot = {
        replies: new Map([...this.replies].map(([key, row]) => [key, { ...row }])),
        confirmations: [...this.confirmations]
      };
      this.events.push("begin");
      this.onBegin?.();
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      if (sql === "ROLLBACK" && this.snapshot) {
        this.replies = this.snapshot.replies;
        this.confirmations = this.snapshot.confirmations;
      }
      this.snapshot = undefined;
      this.events.push(sql.toLowerCase());
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM telegram_command_replies r")) {
      const rows = [...this.replies.values()]
        .filter((row) => row.repliedAt === undefined && this.commands.has(row.commandId))
        .sort((left, right) => left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId))
        .slice(0, 8)
        .map((row) => {
          const command = this.commands.get(row.commandId)!;
          return {
            command_id: row.commandId,
            owner_user_id: row.ownerUserId,
            binding_id: row.bindingId,
            binding_revision: row.bindingRevision,
            purpose: row.purpose,
            request_context: row.requestContext,
            created_at: new Date(row.createdAt),
            status: command.status,
            result: command.result,
            error_code: command.errorCode
          };
        });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("b.status AS binding_status")) {
      const binding = this.bindings.get(params[1] as string);
      if (!binding) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          binding_status: binding.status,
          binding_current_revision: binding.revision,
          recipient_chat_id: binding.chatId,
          owner_status: binding.ownerStatus,
          authorization_revision: binding.authorizationRevision
        }],
        rowCount: 1
      };
    }
    if (sql.includes("SET replied_at = clock_timestamp()")) {
      const row = this.replies.get(params[0] as string);
      if (!row || row.repliedAt !== undefined) return { rows: [], rowCount: 0 };
      row.repliedAt = NOW;
      this.events.push(`replied:${row.commandId}`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT recipient_fingerprint")) {
      const binding = this.bindings.get(params[1] as string);
      return binding
        ? { rows: [{ recipient_fingerprint: binding.fingerprint }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT id FROM users")) return { rows: [{ id: params[0] }], rowCount: 1 };
    if (sql.includes("count(*)::int AS live")) {
      const live = this.confirmations.filter((row) => row.owner_user_id === params[0]).length;
      return { rows: [{ live }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO telegram_confirmations")) {
      this.confirmations.push({
        owner_user_id: params[0],
        binding_id: params[1],
        binding_revision: params[2],
        chat_fingerprint: params[3],
        action: params[4],
        portfolio_id: params[5],
        bot_id: params[6],
        bot_status_at_issue: params[7],
        portfolio_revision: params[8],
        ledger_epoch: params[9],
        bot_revision: params[10],
        authorization_revision: params[11],
        token_hash: params[12]
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected replies lane SQL: ${sql}`);
  }

  addBinding(bindingId = BINDING, overrides: Partial<BindingRow> = {}): void {
    this.bindings.set(bindingId, {
      status: "active",
      revision: 1,
      chatId: "555",
      fingerprint: CHAT_FINGERPRINT,
      ownerStatus: "active",
      authorizationRevision: 4,
      ...overrides
    });
  }

  addReply(commandId: string, command: Partial<CommandRow>, reply: Partial<ReplyRow> = {}): void {
    this.commands.set(commandId, { status: "applied", result: null, errorCode: null, ...command });
    this.replies.set(commandId, {
      commandId,
      ownerUserId: OWNER,
      bindingId: BINDING,
      bindingRevision: 1,
      purpose: TELEGRAM_REPLY_PURPOSE_READ,
      requestContext: { command: "balance" },
      createdAt: NOW - 1_000,
      repliedAt: undefined,
      ...reply
    });
  }
}

interface Harness {
  database: FakeRepliesDatabase;
  lane: TelegramRepliesLane;
  sendMessage: ReturnType<typeof vi.fn>;
  errors: Array<{ error: unknown; phase: string }>;
}

function harness(now: () => number = () => NOW): Harness {
  const database = new FakeRepliesDatabase();
  const sendMessage = vi.fn(async (chatId: string) => {
    database.events.push(`send:${chatId}`);
    return { messageId: "1" };
  });
  const errors: Array<{ error: unknown; phase: string }> = [];
  const lane = new TelegramRepliesLane(database.pool, {
    api: { sendMessage } as unknown as TelegramApi,
    limits: createTelegramSendRateLimits(),
    now,
    onError: (error, phase) => errors.push({ error, phase })
  });
  return { database, lane, sendMessage, errors };
}

function snapshotResult(): Record<string, unknown> {
  return {
    portfolio: { id: "portfolio-1", name: "Main", portfolioRevision: 3, ledgerEpoch: 2 },
    capital: { available: "90000.000000", reserved: "10000.000000" },
    robots: [
      { idPrefix8: "abcd1234", fullId: "bot-abcd1234ef", name: "Alpha", status: "running", realizedPnl: "1.000000", botRevision: 5 }
    ]
  };
}

describe("telegram replies lane", () => {
  it("settles a terminal read reply durably before sending the formatted view", async () => {
    const { database, lane, sendMessage, errors } = harness();
    database.addBinding();
    database.addReply("command-1", { result: snapshotResult() });

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 1, pending: 0, suppressed: 0, timedOut: 0 });

    expect(errors).toEqual([]);
    expect(database.replies.get("command-1")!.repliedAt).toBe(NOW);
    expect(sendMessage).toHaveBeenCalledWith("555", expect.stringContaining("Available capital: 90000.000000 USDT"));
    // The replied_at fence commits before the external send.
    expect(database.events.indexOf("commit")).toBeLessThan(database.events.indexOf("send:555"));

    // A replayed sweep finds nothing: replied_at fences duplicates.
    await expect(lane.sweep()).resolves.toMatchObject({ replied: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("formats trades, rejected and action-outcome replies from the durable command state", async () => {
    const { database, lane, sendMessage } = harness();
    // One binding per reply: the shared 1 msg/s per-chat budget stays out of the way.
    const bindings = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
    bindings.forEach((bindingId, index) => database.addBinding(bindingId, { chatId: `60${index}` }));
    database.addReply("command-1", {
      result: { robot: { idPrefix8: "abcd1234", name: "Alpha" }, trades: [] }
    }, { bindingId: bindings[0]!, requestContext: { command: "trades", handle: "abcd1234" }, createdAt: NOW - 3_000 });
    database.addReply("command-2", { status: "rejected", errorCode: "authorization_stale" }, { bindingId: bindings[1]!, createdAt: NOW - 2_000 });
    database.addReply("command-3", { result: { portfolioId: "portfolio-1" } }, {
      bindingId: bindings[2]!,
      purpose: TELEGRAM_REPLY_PURPOSE_ACTION_OUTCOME,
      requestContext: { command: "confirm", action: "pause", handle: "abcd1234" },
      createdAt: NOW - 1_000
    });

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 3 });
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining("No recorded fills for robot abcd1234 Alpha"),
      expect.stringContaining("Authorization changed"),
      "Robot abcd1234 was paused."
    ]);
  });

  it("leaves young pending commands alone and times out ten-minute-old ones once", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding();
    database.addReply("command-young", { status: "queued" }, { createdAt: NOW - TELEGRAM_REPLY_TIMEOUT_MS + 5_000 });
    database.addReply("command-old", { status: "applying" }, { createdAt: NOW - TELEGRAM_REPLY_TIMEOUT_MS });

    await expect(lane.sweep()).resolves.toMatchObject({ pending: 1, timedOut: 1, replied: 0 });

    expect(database.replies.get("command-young")!.repliedAt).toBeUndefined();
    expect(database.replies.get("command-old")!.repliedAt).toBe(NOW);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain("timed out");
    await expect(lane.sweep()).resolves.toMatchObject({ pending: 1, timedOut: 0 });
  });

  it("suppresses the reply without sending when the binding or owner fence fails", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding(BINDING, { revision: 2 });
    database.addReply("command-revised", { result: snapshotResult() }, { createdAt: NOW - 3_000 });
    const revokedBinding = "00000000-0000-4000-8000-0000000000e3";
    database.addBinding(revokedBinding, { status: "revoked" });
    database.addReply("command-revoked", { result: snapshotResult() }, { bindingId: revokedBinding, createdAt: NOW - 2_000 });
    const inactiveOwnerBinding = "00000000-0000-4000-8000-0000000000e4";
    database.addBinding(inactiveOwnerBinding, { ownerStatus: "disabled" });
    database.addReply("command-inactive", { result: snapshotResult() }, { bindingId: inactiveOwnerBinding, createdAt: NOW - 1_000 });

    await expect(lane.sweep()).resolves.toMatchObject({ suppressed: 3, replied: 0 });

    expect(sendMessage).not.toHaveBeenCalled();
    for (const commandId of ["command-revised", "command-revoked", "command-inactive"]) {
      expect(database.replies.get(commandId)!.repliedAt).toBe(NOW);
    }
  });

  it("loses the replied_at race cleanly: no send, no counters, a clean rollback", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding();
    database.addReply("command-1", { result: snapshotResult() });
    // Another worker settles the same row between the candidate read and our fence.
    database.onBegin = () => {
      database.replies.get("command-1")!.repliedAt = NOW - 1;
      database.onBegin = undefined;
    };

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 0, suppressed: 0, deferred: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(database.events).toContain("rollback");
  });

  it("defers on drained send rate limits and stops the sweep without settling", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding();
    database.addReply("command-1", { result: snapshotResult() }, { createdAt: NOW - 2_000 });
    database.addReply("command-2", { result: snapshotResult() }, { createdAt: NOW - 1_000 });

    // Both replies share one chat: the 1 msg/s per-chat bucket defers the second.
    await expect(lane.sweep()).resolves.toMatchObject({ replied: 1, deferred: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(database.replies.get("command-2")!.repliedAt).toBeUndefined();
  });

  it("bounds one sweep to five settled replies", async () => {
    const { database, lane } = harness();
    for (let index = 0; index < 6; index += 1) {
      const bindingId = `00000000-0000-4000-8000-00000000000${index}`;
      database.addBinding(bindingId, { chatId: `70${index}` });
      database.addReply(`command-${index}`, { result: snapshotResult() }, {
        bindingId,
        ownerUserId: `00000000-0000-4000-8000-0000000000a${index}`,
        createdAt: NOW - 10_000 + index
      });
    }

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 5 });
    expect([...database.replies.values()].filter((row) => row.repliedAt === undefined)).toHaveLength(1);
  });
});

describe("telegram replies lane confirm-target", () => {
  it("resolves the handle, pins every fence in the minted confirmation and prompts with the token", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding();
    database.addReply("command-1", { result: snapshotResult() }, {
      purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
      requestContext: { command: "pause", action: "pause", handle: "abcd1234" }
    });

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 1, confirmationsIssued: 1 });

    const prompt = sendMessage.mock.calls[0]![1] as string;
    expect(prompt).toContain("To confirm pause of abcd1234 Alpha [running]");
    const token = /\/confirm ([a-z2-7]{16})/.exec(prompt)?.[1];
    expect(token).toBeDefined();
    expect(database.confirmations).toEqual([{
      owner_user_id: OWNER,
      binding_id: BINDING,
      binding_revision: 1,
      chat_fingerprint: CHAT_FINGERPRINT,
      action: "pause",
      portfolio_id: "portfolio-1",
      bot_id: "bot-abcd1234ef",
      bot_status_at_issue: "running",
      portfolio_revision: 3,
      ledger_epoch: 2,
      bot_revision: 5,
      authorization_revision: 4,
      token_hash: hashTelegramConfirmationToken(token!)
    }]);
    expect(JSON.stringify(database.confirmations)).not.toContain(token);
  });

  it("answers handle misses, ambiguity and missing fences without minting a token", async () => {
    const { database, lane, sendMessage } = harness();
    const bindings = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
    bindings.forEach((bindingId, index) => database.addBinding(bindingId, { chatId: `61${index}` }));
    database.addReply("command-miss", { result: snapshotResult() }, {
      bindingId: bindings[0]!,
      purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
      requestContext: { action: "stop", handle: "00000000" },
      createdAt: NOW - 3_000
    });
    const ambiguous = snapshotResult();
    (ambiguous.robots as Record<string, unknown>[]).push({ idPrefix8: "abcd1234", fullId: "bot-other" });
    database.addReply("command-ambiguous", { result: ambiguous }, {
      bindingId: bindings[1]!,
      purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
      requestContext: { action: "stop", handle: "abcd1234" },
      createdAt: NOW - 2_000
    });
    const unpinned = snapshotResult();
    unpinned.portfolio = { id: "portfolio-1", ledgerEpoch: 2 };
    database.addReply("command-unpinned", { result: unpinned }, {
      bindingId: bindings[2]!,
      purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
      requestContext: { action: "pause", handle: "abcd1234" },
      createdAt: NOW - 1_000
    });

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 3, confirmationsIssued: 0 });
    expect(database.confirmations).toEqual([]);
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      expect.stringContaining("No robot matches handle 00000000"),
      expect.stringContaining("matches more than one robot"),
      expect.stringContaining("unavailable right now")
    ]);
  });

  it("reports the three-confirmation quota instead of minting a fourth token", async () => {
    const { database, lane, sendMessage } = harness();
    database.addBinding();
    for (let index = 0; index < 3; index += 1) {
      database.confirmations.push({ owner_user_id: OWNER, token_hash: `${index}`.repeat(64) });
    }
    database.addReply("command-1", { result: snapshotResult() }, {
      purpose: TELEGRAM_REPLY_PURPOSE_CONFIRM_TARGET,
      requestContext: { action: "pause", handle: "abcd1234" }
    });

    await expect(lane.sweep()).resolves.toMatchObject({ replied: 1, confirmationsIssued: 0 });
    expect(database.confirmations).toHaveLength(3);
    expect(sendMessage.mock.calls[0]![1]).toContain("3 pending confirmations");
  });
});
