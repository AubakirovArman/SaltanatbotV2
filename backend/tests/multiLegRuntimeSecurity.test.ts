import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairwiseOpportunity } from "../src/arbitrage/engines/pairwise/index.js";
import type { ExecutorCommandRepository } from "../src/database/executorCommandTypes.js";
import type { IdentityService } from "../src/identity/service.js";
import type { IdentitySession, IdentityUser } from "../src/identity/types.js";
import { multiLegKillSwitchSettingsKey } from "../src/trading/multiLeg/contract.js";
import { createPaperMultiLegIntentIn, paperMultiLegIntentIdFor } from "../src/trading/multiLeg/intentStore.js";
import {
  paperPortfolioRequestHash,
  type PaperPortfolioExecutorPayload
} from "../src/trading/paperPortfolioCommandContract.js";
import type { PaperPortfolioCommandPrincipal } from "../src/trading/paperPortfolioGatewayTypes.js";
import { createPaperPortfolioRuntime, type PaperPortfolioRuntime } from "../src/trading/paperPortfolioRuntime.js";
import { createPaperPortfolioIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { TradingEngine } from "../src/trading/engine.js";
import { ExecutorCommandRepositoryDouble } from "./support/executorCommandRepositoryDouble.js";

const OWNER = "multi-leg-runtime-owner";
const SESSION = "a".repeat(64);
const REVISION = 7;
const EPOCH = 11;

const databases: DatabaseSync[] = [];
const runtimes: PaperPortfolioRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const database of databases.splice(0)) database.close();
});

describe("multi-leg executor commands through the fenced runtime", () => {
  it("applies a submit round trip once, replays it exactly and lands the durable intent", async () => {
    const fixture = createFixture();
    const portfolio = seedPortfolio(fixture.database, "multi-leg-portfolio", 100_000_000_000);
    const payload = submitPayload(portfolio.id);
    const command = input(principal(), "multi-leg-submit-key", payload);

    await expect(fixture.runtime.commands.execute(command)).resolves.toEqual({ replayed: false });
    await expect(fixture.runtime.commands.execute(command)).resolves.toEqual({ replayed: true });

    const intentId = paperMultiLegIntentIdFor(OWNER, "multi-leg-submit-key");
    expect(fixture.database.prepare(`
      SELECT status, terminalOutcome, reservedCapitalMicros, netPnlMicros, feesMicros
      FROM paper_multi_leg_intents WHERE ownerUserId = ? AND intentId = ?
    `).get(OWNER, intentId)).toEqual({
      status: "terminal",
      terminalOutcome: "completed",
      reservedCapitalMicros: 1_150_460_000,
      netPnlMicros: 949_770_000,
      feesMicros: 230_000
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS value FROM paper_multi_leg_intent_events WHERE intentId = ?"
    ).get(intentId)).toEqual({ value: 4 });
    // One durable receipt covers both deliveries.
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE ownerUserId = ? AND action = 'executor'
    `).get(OWNER)).toEqual({ value: 1 });
    expect([...fixture.repository.commands.values()].at(-1)).toMatchObject({
      status: "applied",
      commandType: "paper-multi-leg.submit",
      targetType: "paper-portfolio",
      targetId: portfolio.id
    });
  });

  it("applies the owner kill switch and then rejects a submit with the exact code", async () => {
    const fixture = createFixture();
    const portfolio = seedPortfolio(fixture.database, "multi-leg-kill-portfolio", 100_000_000_000);
    const killSwitch: PaperPortfolioExecutorPayload = { version: 1, kind: "paper-multi-leg.kill-switch", enabled: true };

    await expect(fixture.runtime.commands.execute(input(principal(), "kill-switch-on-key", killSwitch)))
      .resolves.toEqual({ replayed: false });
    expect([...fixture.repository.commands.values()].at(-1)).toMatchObject({
      status: "applied",
      commandType: "paper-multi-leg.kill-switch",
      targetId: "multi-leg-kill-switch"
    });
    const stored = fixture.database.prepare("SELECT value FROM settings WHERE key = ?")
      .get(multiLegKillSwitchSettingsKey(OWNER)) as { value: string };
    expect(JSON.parse(stored.value)).toMatchObject({ enabled: true });

    await expect(fixture.runtime.commands.execute(input(principal(), "blocked-submit-key", submitPayload(portfolio.id))))
      .rejects.toMatchObject({ status: 409, code: "multi_leg_kill_switch" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_multi_leg_intents").get())
      .toEqual({ value: 0 });
  });

  it("rejects stale source evidence as multi_leg_plan_rejected without creating an intent", async () => {
    const fixture = createFixture();
    const portfolio = seedPortfolio(fixture.database, "multi-leg-stale-portfolio", 100_000_000_000);
    const stale = submitPayload(portfolio.id, Date.now() - 120_000);

    await expect(fixture.runtime.commands.execute(input(principal(), "stale-submit-key", stale)))
      .rejects.toMatchObject({ status: 409, code: "multi_leg_plan_rejected" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_multi_leg_intents").get())
      .toEqual({ value: 0 });
    expect([...fixture.repository.commands.values()].at(-1)).toMatchObject({
      status: "rejected",
      errorCode: "multi_leg_plan_rejected"
    });
  });

  it("rejects the third concurrent intent for one portfolio as multi_leg_limit_exceeded", async () => {
    const fixture = createFixture();
    const portfolio = seedPortfolio(fixture.database, "multi-leg-limit-portfolio", 100_000_000_000);
    plantRunningIntent(fixture.database, portfolio.id, "limit-planted-1");
    plantRunningIntent(fixture.database, portfolio.id, "limit-planted-2");

    await expect(fixture.runtime.commands.execute(input(principal(), "limit-submit-key", submitPayload(portfolio.id))))
      .rejects.toMatchObject({ status: 429, code: "multi_leg_limit_exceeded" });
  });

  it("rejects an under-capitalized portfolio as multi_leg_insufficient_capital", async () => {
    const fixture = createFixture();
    // One micro below the 1150.46 USDT worst case.
    const portfolio = seedPortfolio(fixture.database, "multi-leg-poor-portfolio", 1_150_459_999);

    await expect(fixture.runtime.commands.execute(input(principal(), "poor-submit-key", submitPayload(portfolio.id))))
      .rejects.toMatchObject({ status: 409, code: "multi_leg_insufficient_capital" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_multi_leg_intents").get())
      .toEqual({ value: 0 });
  });

  it("fails closed on stale authorization before any multi-leg mutation", async () => {
    const fixture = createFixture({ current: false });
    const portfolio = seedPortfolio(fixture.database, "multi-leg-authorization-portfolio", 100_000_000_000);

    await expect(fixture.runtime.commands.execute(input(principal(), "unauthorized-submit-key", submitPayload(portfolio.id))))
      .rejects.toMatchObject({ status: 401, code: "authorization_stale" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_multi_leg_intents").get())
      .toEqual({ value: 0 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE action = 'executor'").get())
      .toEqual({ value: 0 });
  });
});

interface SecurityOverrides {
  current?: boolean;
}

let fixtureSequence = 0;

function createFixture(overrides: SecurityOverrides = {}) {
  const sequence = ++fixtureSequence;
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => Date.now() - 600_000, { legacyOwnerUserId: OWNER });
  const repository = new ExecutorCommandRepositoryDouble(3);
  const runtime = createPaperPortfolioRuntime({
    database,
    engine: engineDouble(),
    executorCommands: repository as ExecutorCommandRepository,
    identityService: identityDouble(overrides),
    workerId: `multi-leg-runtime-${sequence}`
  });
  runtimes.push(runtime);
  return { database, repository, runtime };
}

function seedPortfolio(database: DatabaseSync, portfolioId: string, initialCapitalMicros: number) {
  return createPaperPortfolioIn(database, OWNER, {
    mutationId: `${portfolioId}-create`,
    idempotencyKey: `${portfolioId}-create-key`,
    requestHash: "b".repeat(64),
    now: Date.now() - 60_000,
    portfolioId,
    name: `Portfolio ${portfolioId}`,
    initialCapitalMicros,
    makeDefault: true
  });
}

function plantRunningIntent(database: DatabaseSync, portfolioId: string, key: string): void {
  const intentId = paperMultiLegIntentIdFor(OWNER, key);
  const now = Date.now();
  createPaperMultiLegIntentIn(database, OWNER, {
    intentId,
    portfolioId,
    portfolioEpoch: 1,
    plan: {
      schemaVersion: "paper-multi-leg-plan-v1",
      runId: intentId,
      source: {
        kind: "route-family",
        engine: "route-families-v1",
        family: "spot-dated-future",
        opportunityId: `planted:${key}`,
        evaluatedAt: now - 10,
        provenanceHash: "a".repeat(64)
      },
      createdAt: now,
      expiresAt: now + 60_000,
      executionMode: "paper-sequential-legs",
      simulationPolicy: "explicit-deterministic-fill-ratios-v1",
      legs: []
    },
    planHash: "d".repeat(64),
    reservedCapitalMicros: 1_000_000,
    now
  });
}

function submitPayload(portfolioId: string, evaluatedAt = Date.now() - 1_000): PaperPortfolioExecutorPayload {
  return {
    version: 1,
    kind: "paper-multi-leg.submit",
    portfolioId,
    source: {
      type: "route-family",
      family: "spot-dated-future",
      opportunity: routeFamilyOpportunity(evaluatedAt) as unknown as Record<string, unknown>
    }
  };
}

function routeFamilyOpportunity(evaluatedAt: number): PairwiseOpportunity {
  const legs = [
    {
      role: "long",
      instrumentId: "fixture-spot",
      venue: "fixture-a",
      symbol: "BTCUSDT",
      marketType: "spot",
      side: "buy",
      bookSide: "asks",
      nativeQuantity: 1,
      quantityUnit: "base",
      baseEquivalentQuantity: 1,
      averagePrice: 100,
      worstPrice: 100,
      quoteNotional: 100,
      entryFeeBps: 2,
      entryFeeQuote: 0.02,
      levelsUsed: 1,
      depthLimited: false,
      exchangeTs: evaluatedAt - 10,
      receivedAt: evaluatedAt - 5
    },
    {
      role: "short",
      instrumentId: "fixture-future",
      venue: "fixture-b",
      symbol: "BTC-FUT",
      marketType: "future",
      side: "sell",
      bookSide: "bids",
      nativeQuantity: 10,
      quantityUnit: "contract",
      baseEquivalentQuantity: 1,
      averagePrice: 105,
      worstPrice: 105,
      quoteNotional: 105,
      entryFeeBps: 2,
      entryFeeQuote: 0.021,
      levelsUsed: 1,
      depthLimited: false,
      exchangeTs: evaluatedAt - 9,
      receivedAt: evaluatedAt - 4
    }
  ];
  return {
    id: "pairwise-opportunity:runtime-fixture",
    strategyKind: "spot-dated-future",
    edgeKind: "research-simulation",
    executable: false,
    routeId: "rf:spot-dated-future:runtime-fixture",
    legs,
    timestamps: { evaluatedAt },
    provenance: { engine: "pairwise-v1", books: [{ sourceId: "fixture-spot-book" }, { sourceId: "fixture-future-book" }] }
  } as unknown as PairwiseOpportunity;
}

function identityDouble(overrides: SecurityOverrides): IdentityService {
  const user: IdentityUser = {
    id: OWNER,
    login: OWNER,
    loginNormalized: OWNER,
    passwordHash: "test-only-password-hash",
    status: "active",
    appRole: "user",
    tradingRole: "paper-trade",
    mustChangePassword: false,
    authorizationRevision: REVISION,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const session: IdentitySession = {
    publicId: "11111111-1111-4111-8111-111111111111",
    idHash: SESSION,
    userId: OWNER,
    csrfHash: "d".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    createdAt: new Date()
  };
  return {
    repository: {
      findSession: vi.fn(async (hash: string) => hash === SESSION ? { session, user } : undefined)
    },
    executionAuthorizationSnapshot: vi.fn(async (ownerUserId: string) => ({
      ownerUserId,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      role: "paper-trade"
    })),
    isExecutionAuthorizationCurrent: vi.fn(() => overrides.current ?? true)
  } as unknown as IdentityService;
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

function principal(): PaperPortfolioCommandPrincipal {
  return {
    ownerUserId: OWNER,
    actorUserId: OWNER,
    sessionIdHash: SESSION,
    authorizationRevision: REVISION,
    authorizationEpoch: EPOCH
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
