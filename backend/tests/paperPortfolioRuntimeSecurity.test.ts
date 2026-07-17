import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorCommandRepository } from "../src/database/executorCommandTypes.js";
import type { IdentityService } from "../src/identity/service.js";
import type { IdentitySession, IdentityUser } from "../src/identity/types.js";
import {
  paperPortfolioRequestHash,
  type PaperPortfolioExecutorPayload
} from "../src/trading/paperPortfolioCommandContract.js";
import { createPaperPortfolioRuntime, type PaperPortfolioRuntime } from "../src/trading/paperPortfolioRuntime.js";
import { createPaperPortfolioIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { TradingEngine } from "../src/trading/engine.js";
import type { PaperPortfolioCommandPrincipal } from "../src/trading/paperPortfolioGatewayTypes.js";
import { ExecutorCommandRepositoryDouble } from "./support/executorCommandRepositoryDouble.js";

const NOW = 1_900_000_000_000;
const OWNER = "runtime-owner";
const OTHER_OWNER = "runtime-other-owner";
const SESSION = "a".repeat(64);
const REVISION = 7;
const EPOCH = 11;

const databases: DatabaseSync[] = [];
const runtimes: PaperPortfolioRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const database of databases.splice(0)) database.close();
});

describe("paper portfolio fenced runtime authorization", () => {
  it("applies once and exactly replays one owner-scoped command", async () => {
    const fixture = createFixture();
    const payload = createPayload("runtime-created", "Runtime created");
    const command = input(principal(), "runtime-create-key", payload);

    await expect(fixture.runtime.commands.execute(command)).resolves.toEqual({ replayed: false });
    await expect(fixture.runtime.commands.execute(command)).resolves.toEqual({ replayed: true });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get()).toEqual({ value: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 1 });
    expect([...fixture.repository.commands.values()][0]).toMatchObject({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      status: "applied"
    });
  });

  it("reconciles a durable SQLite receipt after a lost PostgreSQL ACK even when access is later revoked", async () => {
    const authorization: SecurityOverrides = {};
    const fixture = createFixture(authorization);
    const payload = createPayload("lost-ack-created", "Lost ACK created");
    fixture.repository.nextAppliedAcknowledgement = "throw";
    const queued = await fixture.repository.enqueue({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      commandType: payload.kind,
      targetType: "paper-portfolio",
      targetId: payload.portfolioId,
      idempotencyKey: "lost-ack-key",
      requestHash: paperPortfolioRequestHash(OWNER, payload),
      payload
    });

    await fixture.runtime.start();
    await waitFor(() => (
      fixture.repository.inspect(queued.command.id)?.attempt === 1
      && fixture.database.prepare(`
        SELECT COUNT(*) AS value FROM paper_portfolio_mutations
        WHERE ownerUserId = ? AND id = ? AND status = 'applied'
      `).get(OWNER, queued.command.id) as { value: number }
    ).value === 1);
    expect(fixture.repository.inspect(queued.command.id)).toMatchObject({ status: "applying" });

    authorization.current = false;
    fixture.repository.expire(queued.command.id);
    await waitFor(() => fixture.repository.inspect(queued.command.id)?.status === "applied");

    expect(fixture.repository.inspect(queued.command.id)).toMatchObject({
      status: "applied",
      attempt: 2,
      sqliteReceiptHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(fixture.identity.executionAuthorizationSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.identity.repository.findSession).toHaveBeenCalledTimes(1);
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get())
      .toEqual({ value: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get())
      .toEqual({ value: 1 });
  });

  it("accepts the real initial authorization epoch zero", async () => {
    const fixture = createFixture({ snapshotEpoch: 0 });
    const payload = createPayload("epoch-zero-created", "Epoch zero");
    const initialPrincipal = principal({ authorizationEpoch: 0 });

    await expect(fixture.runtime.commands.execute(input(initialPrincipal, "epoch-zero-key", payload)))
      .resolves.toEqual({ replayed: false });
    expect([...fixture.repository.commands.values()][0]).toMatchObject({
      authorizationEpoch: 0,
      status: "applied"
    });
    expect(fixture.database.prepare("SELECT name FROM paper_portfolios WHERE id = ?").get(payload.portfolioId))
      .toEqual({ name: "Epoch zero" });
  });

  it("rejects a conflicting request hash without a second SQLite mutation", async () => {
    const fixture = createFixture();
    const first = createPayload("runtime-conflict", "First");
    const conflicting = createPayload("runtime-conflict", "Different");

    await expect(fixture.runtime.commands.execute(input(principal(), "runtime-conflict-key", first)))
      .resolves.toEqual({ replayed: false });
    await expect(fixture.runtime.commands.execute(input(principal(), "runtime-conflict-key", conflicting)))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get()).toEqual({ value: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 1 });
  });

  it("rejects a queue record whose command target does not match its validated payload", async () => {
    const fixture = createFixture();
    const payload = createPayload("identity-target", "Identity target");
    const queued = await fixture.repository.enqueue({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      commandType: payload.kind,
      targetType: "paper-robot",
      targetId: "tampered-target",
      idempotencyKey: "tampered-target-key",
      requestHash: paperPortfolioRequestHash(OWNER, payload),
      payload
    });

    await fixture.runtime.start();
    await waitFor(() => fixture.repository.inspect(queued.command.id)?.status === "rejected");
    expect(fixture.repository.inspect(queued.command.id)).toMatchObject({
      status: "rejected",
      errorCode: "invalid_command_identity"
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get()).toEqual({ value: 0 });
  });

  it.each([
    ["actor differs from owner", { principal: { actorUserId: OTHER_OWNER } }],
    ["actor identity is absent", { principal: { actorUserId: null } }],
    ["session hash is unknown", { principal: { sessionIdHash: "9".repeat(64) } }],
    ["session belongs to another owner", { sessionUserId: OTHER_OWNER }],
    ["session was revoked", { sessionRevoked: true }],
    ["session expired", { sessionExpired: true }],
    ["account was disabled", { userStatus: "disabled" as const }],
    ["password change is still required", { mustChangePassword: true }],
    ["authorization snapshot disappeared", { missingSnapshot: true }],
    ["authorization revision changed", { snapshotRevision: REVISION + 1 }],
    ["authorization epoch changed", { snapshotEpoch: EPOCH + 1 }],
    ["paper trading role was removed", { snapshotRole: "read-only" as const }],
    ["in-process authorization epoch is no longer current", { current: false }]
  ])("fails closed when %s", async (_name, overrides: SecurityOverrides) => {
    const fixture = createFixture(overrides);
    const payload = createPayload(`rejected-${fixture.sequence}`, "Must not exist");

    await expect(
      fixture.runtime.commands.execute(input(principal(overrides.principal), `rejected-key-${fixture.sequence}`, payload))
    ).rejects.toMatchObject({ status: 401, code: "authorization_stale" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios").get()).toEqual({ value: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toEqual({ value: 0 });
    expect([...fixture.repository.commands.values()][0]).toMatchObject({
      status: "rejected",
      errorCode: "authorization_stale"
    });
  });

  it("denies cross-owner portfolio access even with an otherwise valid session", async () => {
    const fixture = createFixture({
      acceptedOwner: OTHER_OWNER,
      sessionUserId: OTHER_OWNER,
      snapshotRole: "admin"
    });
    const portfolio = createPaperPortfolioIn(fixture.database, OWNER, {
      mutationId: "owner-a-create",
      idempotencyKey: "owner-a-create-key",
      requestHash: "b".repeat(64),
      now: NOW,
      portfolioId: "owner-a-portfolio",
      name: "Owner A",
      initialCapitalMicros: 100_000_000,
      makeDefault: true
    });
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-portfolio.rename",
      portfolioId: portfolio.id,
      expectedPortfolioRevision: portfolio.revision,
      expectedLedgerEpoch: portfolio.currentEpoch,
      name: "Stolen"
    };

    await expect(
      fixture.runtime.commands.execute(input(principal({ ownerUserId: OTHER_OWNER, actorUserId: OTHER_OWNER }), "cross-owner", payload))
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fixture.database.prepare("SELECT name FROM paper_portfolios WHERE id = ?").get(portfolio.id))
      .toEqual({ name: "Owner A" });
    expect(fixture.database.prepare(`
      SELECT status, targetId FROM paper_portfolio_mutations
      WHERE ownerUserId = ? AND idempotencyKey = 'cross-owner'
    `).get(OTHER_OWNER)).toEqual({ status: "rejected", targetId: portfolio.id });
  });

  it("atomically rolls back a cross-owner robot bind", async () => {
    const fixture = createFixture({ acceptedOwner: OTHER_OWNER, sessionUserId: OTHER_OWNER });
    const portfolio = createPaperPortfolioIn(fixture.database, OWNER, {
      mutationId: "robot-owner-a-create",
      idempotencyKey: "robot-owner-a-create-key",
      requestHash: "d".repeat(64),
      now: NOW,
      portfolioId: "robot-owner-a-portfolio",
      name: "Owner A robot capital",
      initialCapitalMicros: 100_000_000,
      makeDefault: true
    });
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-robot.create",
      portfolioId: portfolio.id,
      expectedPortfolioRevision: portfolio.revision,
      expectedLedgerEpoch: portfolio.currentEpoch,
      botId: "cross-owner-bot",
      expectedBotRevision: 1,
      allocationMicros: 10_000_000,
      maxBots: 10,
      bot: {
        id: "cross-owner-bot",
        accountId: "paper:cross-owner-bot",
        name: "Cross owner",
        strategyName: "Cross owner strategy",
        ir: { name: "cross-owner", inputs: [], body: [] },
        symbol: "BTCUSDT",
        timeframe: "1m",
        exchange: "paper",
        market: "spot",
        sizeMode: "quote",
        sizeValue: 1,
        leverage: 1,
        bybitCrossCollateral: false,
        notifyMarkers: false
      }
    };

    await expect(fixture.runtime.commands.execute(input(
      principal({ ownerUserId: OTHER_OWNER, actorUserId: OTHER_OWNER }),
      "cross-owner-bot-key",
      payload
    ))).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM bots WHERE id = 'cross-owner-bot'").get())
      .toEqual({ value: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_bot_allocations").get()).toEqual({ value: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_events").get()).toEqual({ value: 0 });
    expect(fixture.database.prepare("SELECT revision FROM paper_portfolios WHERE id = ?").get(portfolio.id))
      .toEqual({ revision: 1 });
  });

  it.each([
    ["portfolio revision", { expectedPortfolioRevision: 2, expectedLedgerEpoch: 1 }],
    ["ledger epoch", { expectedPortfolioRevision: 1, expectedLedgerEpoch: 2 }]
  ])("rejects a stale %s before changing the portfolio", async (_name, expected) => {
    const fixture = createFixture();
    const portfolio = createPaperPortfolioIn(fixture.database, OWNER, {
      mutationId: "stale-create",
      idempotencyKey: "stale-create-key",
      requestHash: "c".repeat(64),
      now: NOW,
      portfolioId: "stale-portfolio",
      name: "Current",
      initialCapitalMicros: 100_000_000,
      makeDefault: true
    });
    const payload: PaperPortfolioExecutorPayload = {
      version: 1,
      kind: "paper-portfolio.rename",
      portfolioId: portfolio.id,
      ...expected,
      name: "Must not persist"
    };

    await expect(fixture.runtime.commands.execute(input(principal(), `stale-${_name}`, payload)))
      .rejects.toMatchObject({ status: 409, code: expect.stringMatching(/revision_conflict|epoch_conflict/) });
    expect(fixture.database.prepare("SELECT name, revision, currentEpoch FROM paper_portfolios WHERE id = ?").get(portfolio.id))
      .toEqual({ name: "Current", revision: 1, currentEpoch: 1 });
  });
});

interface SecurityOverrides {
  acceptedOwner?: string;
  principal?: Partial<PaperPortfolioCommandPrincipal>;
  sessionUserId?: string;
  sessionRevoked?: boolean;
  sessionExpired?: boolean;
  userStatus?: IdentityUser["status"];
  mustChangePassword?: boolean;
  missingSnapshot?: boolean;
  snapshotRevision?: number;
  snapshotEpoch?: number;
  snapshotRole?: "admin" | "live-trade" | "paper-trade" | "read-only";
  current?: boolean;
}

let fixtureSequence = 0;

function createFixture(overrides: SecurityOverrides = {}) {
  const sequence = ++fixtureSequence;
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => NOW, { legacyOwnerUserId: OWNER });
  const repository = new ExecutorCommandRepositoryDouble(3, () => NOW + sequence);
  const identity = identityDouble(overrides);
  const engine = engineDouble();
  const runtime = createPaperPortfolioRuntime({
    database,
    engine,
    executorCommands: repository as ExecutorCommandRepository,
    identityService: identity,
    workerId: `runtime-security-${sequence}`
  });
  runtimes.push(runtime);
  return { database, repository, identity, runtime, sequence };
}

function identityDouble(overrides: SecurityOverrides): IdentityService {
  const acceptedOwner = overrides.acceptedOwner ?? OWNER;
  const sessionUserId = overrides.sessionUserId ?? acceptedOwner;
  const sessionUser = identityUser(sessionUserId, overrides);
  const session: IdentitySession = {
    publicId: "11111111-1111-4111-8111-111111111111",
    idHash: SESSION,
    userId: sessionUserId,
    csrfHash: "d".repeat(64),
    expiresAt: new Date(overrides.sessionExpired ? Date.now() - 1 : Date.now() + 60_000),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    ...(overrides.sessionRevoked ? { revokedAt: new Date(), revokeReason: "test" } : {})
  };
  return {
    repository: {
      findSession: vi.fn(async (hash: string) => hash === SESSION ? { session, user: sessionUser } : undefined)
    },
    executionAuthorizationSnapshot: vi.fn(async (ownerUserId: string) => {
      if (overrides.missingSnapshot || ownerUserId !== acceptedOwner) return undefined;
      return {
        ownerUserId,
        authorizationRevision: overrides.snapshotRevision ?? REVISION,
        authorizationEpoch: overrides.snapshotEpoch ?? EPOCH,
        role: overrides.snapshotRole ?? "paper-trade"
      };
    }),
    isExecutionAuthorizationCurrent: vi.fn(() => overrides.current ?? true)
  } as unknown as IdentityService;
}

function identityUser(id: string, overrides: SecurityOverrides): IdentityUser {
  return {
    id,
    login: id,
    loginNormalized: id,
    passwordHash: "test-only-password-hash",
    status: overrides.userStatus ?? "active",
    appRole: "user",
    tradingRole: "paper-trade",
    mustChangePassword: overrides.mustChangePassword ?? false,
    authorizationRevision: REVISION,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW)
  };
}

function engineDouble(): TradingEngine {
  return {
    isRunningForOwner: () => false,
    isPausedForOwner: () => false,
    async startForOwner() {},
    async pauseForOwner() { return false; },
    async confirmResumeForOwner() { return false; },
    async stopSafelyForOwner() {}
  } as unknown as TradingEngine;
}

function principal(overrides: Partial<PaperPortfolioCommandPrincipal> = {}): PaperPortfolioCommandPrincipal {
  return {
    ownerUserId: OWNER,
    actorUserId: OWNER,
    sessionIdHash: SESSION,
    authorizationRevision: REVISION,
    authorizationEpoch: EPOCH,
    ...overrides
  };
}

function createPayload(portfolioId: string, name: string): PaperPortfolioExecutorPayload {
  return {
    version: 1,
    kind: "paper-portfolio.create",
    portfolioId,
    name,
    initialCapitalMicros: 100_000_000,
    makeDefault: false
  };
}

function input(principalValue: PaperPortfolioCommandPrincipal, idempotencyKey: string, payload: PaperPortfolioExecutorPayload) {
  return {
    principal: principalValue,
    idempotencyKey,
    requestHash: paperPortfolioRequestHash(principalValue.ownerUserId, payload),
    payload
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for executor result");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
