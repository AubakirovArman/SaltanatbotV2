import { createHash } from "node:crypto";
import type { Candle, ScreenerAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { parseAndHashAlertDefinition } from "../src/alerts/repositoryRows.js";
import { SCREENER_ALERT_LEASE_MS, type ClaimedScreenerAlertRule, type CompleteScreenerEvaluationInput } from "../src/alerts/repositoryTypes.js";
import { defaultScreenerAlertRuntimeState, screenerAlertStateKey, type ScreenerAlertRuntimeStateV1 } from "../src/alerts/screenerAlertEvaluator.js";
import { SCREENER_ALERT_EVALUATION_BUDGET_MS, SCREENER_ALERT_EVALUATIONS_PER_SWEEP, createScreenerAlertLane, runScreenerAlertSweep, type ScreenerAlertRunnerOptions, type ScreenerAlertRunnerRepository } from "../src/alerts/screenerAlertRunner.js";
import { ScreenerMarketDataError, type ScreenerMarketDataSnapshotV1 } from "../src/screener/marketData.js";

const OWNER = "00000000-0000-4000-8000-000000000061";
const RULE_ID = "00000000-0000-4000-8000-000000000062";
const WORKER = "research-worker:screener-lane";
const BAR = 300_000;
const BAR_ONE = Date.parse("2026-07-17T06:00:00.000Z");
const BAR_TWO = BAR_ONE + BAR;
const NOW = BAR_TWO + 2 * BAR;
const SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT", "GGGUSDT", "HHHUSDT", "IIIUSDT", "JJJUSDT"];

describe("screener alert worker lane", () => {
  it("dispatches at most one screener evaluation per sweep with the full 300s lease", async () => {
    const repository = repositoryDouble([claim(), claim(), claim()]);
    const result = await runScreenerAlertSweep(repository, options({ marketData: async () => snapshot(BAR_ONE, ["AAAUSDT"]) }));

    expect(SCREENER_ALERT_EVALUATIONS_PER_SWEEP).toBe(1);
    expect(SCREENER_ALERT_LEASE_MS).toBe(300_000);
    expect(repository.claimDueScreenerAlert).toHaveBeenCalledTimes(1);
    expect(repository.claimDueScreenerAlert).toHaveBeenCalledWith({ workerId: WORKER, leaseMs: SCREENER_ALERT_LEASE_MS });
    expect(result).toMatchObject({ claimAttempts: 1, claimed: 1, applied: 1 });
  });

  it("initializes first evaluations under the abort budget and completes without a transition", async () => {
    const repository = repositoryDouble([claim()]);
    const dependencies: unknown[] = [];
    const marketData = vi.fn(async (_definition: unknown, injected?: unknown) => {
      dependencies.push(injected);
      return snapshot(BAR_ONE, ["AAAUSDT", "BBBUSDT"]);
    });

    const result = await runScreenerAlertSweep(repository, options({ marketData }));

    expect(result).toMatchObject({ claimed: 1, applied: 1, initialized: 1, triggered: 0, deferred: 0, backedOff: 0 });
    expect(dependencies[0]).toMatchObject({ runBudgetMs: SCREENER_ALERT_EVALUATION_BUDGET_MS });
    expect((dependencies[0] as { signal: unknown }).signal).toBeInstanceOf(AbortSignal);
    const completion = vi.mocked(repository.completeScreenerEvaluation).mock.calls[0]![0] as CompleteScreenerEvaluationInput;
    expect(completion).toMatchObject({
      ownerUserId: OWNER,
      ruleId: RULE_ID,
      expectedRevision: 3,
      workerId: WORKER,
      expectedStateRevision: 0,
      nextState: {
        matchedSymbols: ["AAAUSDT", "BBBUSDT"],
        lastClosedBarTimeMax: BAR_ONE,
        initialized: true
      }
    });
    expect(completion.observation.subjectKey).toBe(claim().stateKey);
    expect(completion).not.toHaveProperty("transition");
  });

  it("routes a durable match-set change through the triggered completion lane", async () => {
    const repository = repositoryDouble([claim({ state: initializedState(["AAAUSDT"], BAR_ONE), stateRevision: 1 })]);
    const result = await runScreenerAlertSweep(repository, options({ marketData: async () => snapshot(BAR_TWO, ["AAAUSDT", "BBBUSDT"]) }));

    expect(result).toMatchObject({ claimed: 1, applied: 1, triggered: 1, initialized: 0 });
    const completion = vi.mocked(repository.completeScreenerEvaluation).mock.calls[0]![0] as CompleteScreenerEvaluationInput;
    expect(completion.expectedStateRevision).toBe(1);
    expect(completion.transition).toMatchObject({
      kind: "screener-alert-triggered",
      enteredSymbols: ["BBBUSDT"],
      leftSymbols: [],
      matchedCount: 2,
      occurredAt: BAR_TWO
    });
  });

  it("defers idle, cooldown and availability-floor outcomes without completing", async () => {
    const idle = repositoryDouble([claim({ state: initializedState(["AAAUSDT"], BAR_ONE), stateRevision: 1 })]);
    expect(await runScreenerAlertSweep(idle, options({ marketData: async () => snapshot(BAR_ONE, ["AAAUSDT"]) }))).toMatchObject({ claimed: 1, deferred: 1, applied: 0 });
    expect(idle.deferScreenerEvaluation).toHaveBeenCalledWith(expect.not.objectContaining({ retryAfterSeconds: expect.anything() }));

    const cooling = repositoryDouble([claim({ state: initializedState(["AAAUSDT"], BAR_ONE), stateRevision: 2, cooldownUntil: NOW + 45_000 })]);
    expect(await runScreenerAlertSweep(cooling, options({ marketData: async () => snapshot(BAR_TWO, ["AAAUSDT", "BBBUSDT"]) }))).toMatchObject({ claimed: 1, deferred: 1, cooldownDeferred: 1 });
    expect(cooling.deferScreenerEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 45 }));

    const floored = repositoryDouble([claim()]);
    expect(await runScreenerAlertSweep(floored, options({ marketData: async () => snapshot(BAR_ONE, ["AAAUSDT"], SYMBOLS.slice(5, 9)) }))).toMatchObject({ claimed: 1, deferred: 1, availabilityFloorDeferred: 1 });
    for (const repository of [idle, cooling, floored]) {
      expect(repository.completeScreenerEvaluation).not.toHaveBeenCalled();
      expect(repository.failScreenerEvaluation).not.toHaveBeenCalled();
    }
  });

  it("backs off market-data failures with fenced screener error codes", async () => {
    const typed = repositoryDouble([claim()]);
    const typedResult = await runScreenerAlertSweep(
      typed,
      options({
        marketData: async () => {
          throw new ScreenerMarketDataError("ticker_unavailable", "whole-market ticker unavailable");
        }
      })
    );
    expect(typedResult).toMatchObject({ claimed: 1, backedOff: 1, applied: 0 });
    expect(typed.failScreenerEvaluation).toHaveBeenCalledWith(expect.objectContaining({ ruleId: RULE_ID, stateKey: claim().stateKey, errorCode: "screener_ticker_unavailable" }));

    const generic = repositoryDouble([claim()]);
    await runScreenerAlertSweep(generic, options({ marketData: async () => Promise.reject(new Error("socket hangup")) }));
    expect(generic.failScreenerEvaluation).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "screener_market_data_unavailable" }));
  });

  it("is single-flight per lane and reports sweep metrics after quiescing", async () => {
    const gate = deferred<ScreenerMarketDataSnapshotV1>();
    const repository = repositoryDouble([claim()]);
    const sweeps: unknown[] = [];
    const lane = createScreenerAlertLane(repository, {
      ...options({ marketData: () => gate.promise }),
      intervalMs: 60_000,
      onSweep: (result) => sweeps.push(result)
    });

    expect(await lane.trigger()).toMatchObject({ claimAttempts: 0, claimed: 0 });
    await lane.start();
    const first = lane.trigger();
    expect(lane.trigger()).toBe(first);

    lane.quiesce();
    gate.resolve(snapshot(BAR_ONE, ["AAAUSDT"]));
    await lane.drain();
    await expect(first).resolves.toMatchObject({ claimed: 1, applied: 1, initialized: 1 });
    expect(sweeps).toHaveLength(1);
    expect(await lane.trigger()).toMatchObject({ claimAttempts: 0 });
    expect(repository.claimDueScreenerAlert).toHaveBeenCalledTimes(1);
  });
});

function repositoryDouble(claims: ClaimedScreenerAlertRule[]) {
  const queue = [...claims];
  return {
    claimDueScreenerAlert: vi.fn(async () => queue.shift()),
    completeScreenerEvaluation: vi.fn(async () => ({ outcome: "applied" as const })),
    deferScreenerEvaluation: vi.fn(async () => true),
    failScreenerEvaluation: vi.fn(async () => true)
  } satisfies ScreenerAlertRunnerRepository;
}

function options(override: Partial<ScreenerAlertRunnerOptions> = {}): ScreenerAlertRunnerOptions {
  return { workerId: WORKER, now: () => NOW, ...override };
}

function definition(): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Momentum screen alert",
    enabled: true,
    cooldownSeconds: 3_600,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    screen: {
      schemaVersion: "screener-definition-v1",
      kind: "technical",
      name: "Momentum screen",
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

function claim(override: Partial<ClaimedScreenerAlertRule> = {}): ClaimedScreenerAlertRule {
  const parsed = parseAndHashAlertDefinition(definition());
  const screenerDefinition = parsed.definition as ScreenerAlertDefinitionV1;
  return {
    id: RULE_ID,
    ownerUserId: OWNER,
    clientId: "browser.screen-01",
    status: "active",
    currentRevision: 3,
    authorizationRevision: 7,
    evaluationIntervalSeconds: 300,
    nextEvaluationAt: new Date(NOW).toISOString(),
    evaluationFailureCount: 0,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    definitionHash: parsed.hash,
    definition: screenerDefinition,
    workerId: WORKER,
    leaseToken: "00000000-0000-4000-8000-000000000063",
    leaseGeneration: 5,
    leaseExpiresAt: new Date(NOW + SCREENER_ALERT_LEASE_MS).toISOString(),
    stateKey: screenerAlertStateKey(screenerDefinition.screen, parsed.hash),
    stateRevision: 0,
    state: defaultScreenerAlertRuntimeState(),
    ...override
  };
}

function initializedState(matchedSymbols: string[], lastClosedBarTimeMax: number): ScreenerAlertRuntimeStateV1 {
  const sorted = [...matchedSymbols].sort();
  return {
    schemaVersion: "screener-alert-state-v1",
    matchedSymbols: sorted,
    unknownSymbols: [],
    matchSetFingerprint: createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex"),
    lastClosedBarTimeMax,
    initialized: true
  };
}

function snapshot(barTime: number, matched: readonly string[], unavailable: readonly string[] = []): ScreenerMarketDataSnapshotV1 {
  const matchedSet = new Set(matched);
  const unavailableSet = new Set(unavailable);
  const candlesBySymbol = new Map<string, Candle[]>();
  const unavailableReasonBySymbol = new Map<string, string>();
  for (const symbol of SYMBOLS) {
    if (unavailableSet.has(symbol)) {
      unavailableReasonBySymbol.set(symbol, "ticker-unavailable");
      continue;
    }
    const close = matchedSet.has(symbol) ? 150 : 50;
    candlesBySymbol.set(symbol, [candle(barTime - 2 * BAR, close), candle(barTime - BAR, close), candle(barTime, close)]);
  }
  return {
    observedAt: NOW,
    universe: SYMBOLS.map((symbol) => ({ symbol })),
    candlesBySymbol,
    unavailableReasonBySymbol
  };
}

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10, final: true, source: "public-test" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
