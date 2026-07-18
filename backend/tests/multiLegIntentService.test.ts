import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NLegOpportunity } from "../src/arbitrage/engines/nLeg/index.js";
import type { PairwiseOpportunity } from "../src/arbitrage/engines/pairwise/index.js";
import { createPaperMultiLegInitialEvent, nextPaperMultiLegEvent, replayPaperMultiLegEvents } from "../src/arbitrage/paperMultiLeg/engine.js";
import { paperMultiLegHash, stableJson } from "../src/arbitrage/paperMultiLeg/canonical.js";
import type { PaperMultiLegEvent } from "../src/arbitrage/paperMultiLeg/types.js";
import { multiLegKillSwitchSettingsKey } from "../src/trading/multiLeg/contract.js";
import {
  continuePaperMultiLegIntent,
  formatSignedMultiLegMicros,
  isPaperMultiLegKillSwitchEnabled,
  recoverIncompletePaperMultiLegIntents,
  setPaperMultiLegKillSwitch,
  submitPaperMultiLegIntent,
  type PaperMultiLegSubmitPayload
} from "../src/trading/multiLeg/intentService.js";
import {
  appendPaperMultiLegIntentEventIn,
  createPaperMultiLegIntentIn,
  finalizePaperMultiLegIntentIn,
  getPaperMultiLegIntentFrom,
  listPaperMultiLegIntentEventsFrom,
  paperMultiLegEventIdempotencyKey,
  paperMultiLegIntentIdFor,
  sumRunningPaperMultiLegReservedMicrosFrom
} from "../src/trading/multiLeg/intentStore.js";
import { createPaperPortfolioIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";

const NOW = 2_000_000_000_000;
const OWNER = "intent-service-owner";

const databases: DatabaseSync[] = [];
let sequence = 0;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("multi-leg submit pipeline", () => {
  it("runs a 2-leg route-family submit to terminal with the exact combined both-legs-all-costs PnL", () => {
    const { database, portfolio } = fixture();
    const result = submitPaperMultiLegIntent(database, OWNER, mutation("happy"), routeFamilyPayload(portfolio.id));

    // buy 1@100 fee 0.02 → −100.02; sell 10@105 fee 0.21 → +1049.79; net 949.77, fees 0.23.
    const intentId = paperMultiLegIntentIdFor(OWNER, "happy-key");
    expect(result).toMatchObject({
      portfolioId: portfolio.id,
      ledgerEpoch: 1,
      intentId,
      status: "terminal",
      outcome: "completed",
      reservedCapital: "1150.460000",
      netPnl: "949.770000",
      fees: "0.230000",
      residualExposure: []
    });
    const intent = getPaperMultiLegIntentFrom(database, OWNER, intentId);
    expect(intent).toMatchObject({
      status: "terminal",
      terminalOutcome: "completed",
      sourceEngine: "route-families-v1",
      sourceOpportunityId: "pairwise-opportunity:fixture",
      reservedCapitalMicros: 1_150_460_000,
      netPnlMicros: 949_770_000,
      feesMicros: 230_000
    });
    const events = listPaperMultiLegIntentEventsFrom(database, OWNER, intentId);
    expect(events.map((event) => event.type)).toEqual(["run-created", "original-fill", "original-fill", "run-terminal"]);
    expect(sumRunningPaperMultiLegReservedMicrosFrom(database, OWNER, portfolio.id)).toBe(0);
    expect(JSON.stringify(events)).not.toMatch(/apiKey|apiSecret|liveOrders":true|privateRequests":true/i);
  });

  it("prices an unwind through compensation fills and reports residual exposure explicitly", () => {
    const { database, portfolio } = fixture();
    const result = submitPaperMultiLegIntent(database, OWNER, mutation("unwind"), routeFamilyPayload(portfolio.id, [
      { compensationFillRatioBps: 5_000 },
      { fillRatioBps: 0 }
    ]));

    // buy 1@100 fee 0.02 → −100.02; leg 2 unfilled; compensation sell 0.5@100
    // fee 0.01 → +49.99; realized net −50.03, fees 0.03, residual 0.5 base.
    const intentId = paperMultiLegIntentIdFor(OWNER, "unwind-key");
    expect(result).toMatchObject({
      status: "terminal",
      outcome: "manual-review-required",
      netPnl: "-50.030000",
      fees: "0.030000",
      residualExposure: [{
        instrumentId: "fixture-spot",
        quantityUnit: "base",
        quantity: 0.5
      }]
    });
    expect(getPaperMultiLegIntentFrom(database, OWNER, intentId)).toMatchObject({
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000
    });
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId).map((event) => event.type)).toEqual([
      "run-created", "original-fill", "original-fill", "compensation-decision", "compensation-fill", "run-terminal"
    ]);
  });

  it("completes a fully compensated unwind without inventing exposure", () => {
    const { database, portfolio } = fixture();
    const result = submitPaperMultiLegIntent(database, OWNER, mutation("compensated"), routeFamilyPayload(portfolio.id, [
      {},
      { fillRatioBps: 0 }
    ]));

    // buy 1@100 fee 0.02 → −100.02; compensation sell 1@100 fee 0.02 → +99.98.
    expect(result).toMatchObject({
      status: "terminal",
      outcome: "compensated",
      netPnl: "-0.040000",
      fees: "0.040000",
      residualExposure: []
    });
  });

  it("runs a 4-leg n-leg cycle to completed with the exact combined figures", () => {
    const { database, portfolio } = fixture();
    const result = submitPaperMultiLegIntent(database, OWNER, mutation("n-leg"), nLegPayload(portfolio.id));

    // −100.02 + 201.9596 − 306.0612 + 411.9176 = 207.796; fees 0.204.
    const intentId = paperMultiLegIntentIdFor(OWNER, "n-leg-key");
    expect(result).toMatchObject({
      status: "terminal",
      outcome: "completed",
      reservedCapital: "1020.408000",
      netPnl: "207.796000",
      fees: "0.204000"
    });
    expect(getPaperMultiLegIntentFrom(database, OWNER, intentId)).toMatchObject({
      sourceEngine: "n-leg-v1",
      reservedCapitalMicros: 1_020_408_000,
      netPnlMicros: 207_796_000,
      feesMicros: 204_000
    });
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId)).toHaveLength(6);
  });
});

describe("multi-leg submit rejections", () => {
  it("rejects stale source evidence fail-closed as MULTI_LEG_PLAN_REJECTED", () => {
    const { database, portfolio } = fixture();
    const stale = routeFamilyPayload(portfolio.id);
    (stale.source.opportunity as { timestamps: { evaluatedAt: number } }).timestamps.evaluatedAt = NOW - 60_001;

    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("stale"), stale))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_PLAN_REJECTED" }));
    expect(getPaperMultiLegIntentFrom(database, OWNER, paperMultiLegIntentIdFor(OWNER, "stale-key"))).toBeUndefined();
  });

  it("rejects a forged executable opportunity fail-closed as MULTI_LEG_PLAN_REJECTED", () => {
    const { database, portfolio } = fixture();
    const forged = routeFamilyPayload(portfolio.id);
    (forged.source.opportunity as { executable: boolean }).executable = true;

    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("forged"), forged))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_PLAN_REJECTED" }));
  });

  it("blocks submissions behind the owner kill switch and fails closed on unreadable state", () => {
    const { database, portfolio } = fixture();
    setPaperMultiLegKillSwitch(database, OWNER, mutation("switch-on"), { version: 1, kind: "paper-multi-leg.kill-switch", enabled: true });
    expect(isPaperMultiLegKillSwitchEnabled(database, OWNER)).toBe(true);
    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("blocked"), routeFamilyPayload(portfolio.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_KILL_SWITCH" }));

    setPaperMultiLegKillSwitch(database, OWNER, mutation("switch-off"), { version: 1, kind: "paper-multi-leg.kill-switch", enabled: false });
    expect(isPaperMultiLegKillSwitchEnabled(database, OWNER)).toBe(false);

    // An unreadable settings value must never silently re-enable submissions.
    database.prepare("UPDATE settings SET value = 'not json' WHERE key = ?")
      .run(multiLegKillSwitchSettingsKey(OWNER));
    expect(isPaperMultiLegKillSwitchEnabled(database, OWNER)).toBe(true);
    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("unreadable"), routeFamilyPayload(portfolio.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_KILL_SWITCH" }));
  });

  it("enforces the per-portfolio and per-owner running intent limits", () => {
    const { database, portfolio } = fixture(100_000_000_000);
    const second = portfolioIn(database, "portfolio-second", 100_000_000_000);
    plantRunningIntent(database, portfolio.id, "planted-1");
    plantRunningIntent(database, portfolio.id, "planted-2");

    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("portfolio-limit"), routeFamilyPayload(portfolio.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_LIMIT_EXCEEDED" }));

    plantRunningIntent(database, second.id, "planted-3");
    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("owner-limit"), routeFamilyPayload(second.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_LIMIT_EXCEEDED" }));
  });

  it("rejects one micro short of the worst-case reservation and accepts the exact boundary", () => {
    // Worst case: (1·100 + 10·105)·1.0004 = 1150.46 → 1_150_460_000 micros.
    const short = fixture(1_150_459_999);
    expect(() => submitPaperMultiLegIntent(short.database, OWNER, mutation("short"), routeFamilyPayload(short.portfolio.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_INSUFFICIENT_CAPITAL" }));
    expect(sumRunningPaperMultiLegReservedMicrosFrom(short.database, OWNER, short.portfolio.id)).toBe(0);

    const exact = fixture(1_150_460_000);
    expect(submitPaperMultiLegIntent(exact.database, OWNER, mutation("exact"), routeFamilyPayload(exact.portfolio.id)))
      .toMatchObject({ outcome: "completed", reservedCapital: "1150.460000" });
  });

  it("subtracts running reservations from the available capital before reserving", () => {
    const { database, portfolio } = fixture(2_000_000_000); // 2000 USDT covers one run, not two.
    plantRunningIntent(database, portfolio.id, "holds-capital", 1_000_000_000);
    expect(() => submitPaperMultiLegIntent(database, OWNER, mutation("crowded"), routeFamilyPayload(portfolio.id)))
      .toThrow(expect.objectContaining({ code: "MULTI_LEG_INSUFFICIENT_CAPITAL" }));
  });
});

describe("multi-leg restart recovery", () => {
  it("continues a crashed run to the identical terminal state with no duplicate events and one release", () => {
    const { database, portfolio } = fixture();
    const { intentId, plan } = plantStartedIntent(database, portfolio.id, "crash-key", [
      { compensationFillRatioBps: 5_000 },
      { fillRatioBps: 0 }
    ]);

    // Crash simulation: drive only part of the deterministic transition chain.
    const partial = continuePaperMultiLegIntent(database, OWNER, intentId, NOW + 1, 2);
    expect(partial.terminal).toBeUndefined();
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId)).toHaveLength(3);
    expect(getPaperMultiLegIntentFrom(database, OWNER, intentId)).toMatchObject({ status: "running" });

    // A fresh process recovers on startup and finishes the identical run.
    expect(recoverIncompletePaperMultiLegIntents(database, NOW + 60_000)).toBe(1);
    const events = listPaperMultiLegIntentEventsFrom(database, OWNER, intentId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(events.map((event) => paperMultiLegEventIdempotencyKey(intentId, event.sequence))).size).toBe(6);

    // The durable journal equals the pure engine's uninterrupted run exactly.
    expect(events.map(transition)).toEqual(referenceEvents(plan, intentId).map(transition));
    const state = replayPaperMultiLegEvents(events, intentId);
    expect(state.terminal).toMatchObject({ status: "manual-review-required" });
    expect(getPaperMultiLegIntentFrom(database, OWNER, intentId)).toMatchObject({
      status: "terminal",
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000
    });

    // Single release: the reservation is gone, a rerun recovers nothing and
    // appends nothing, and a second terminal flip is impossible.
    expect(sumRunningPaperMultiLegReservedMicrosFrom(database, OWNER, portfolio.id)).toBe(0);
    expect(recoverIncompletePaperMultiLegIntents(database, NOW + 120_000)).toBe(0);
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId)).toHaveLength(6);
    expect(() => finalizePaperMultiLegIntentIn(database, OWNER, {
      intentId,
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000,
      now: NOW + 180_000
    })).toThrow(/already released/i);
  });

  it("resumes a redelivered submit command onto its own crashed intent", () => {
    const { database, portfolio } = fixture();
    const identity = mutation("redelivered");
    const intentId = paperMultiLegIntentIdFor(OWNER, identity.idempotencyKey);
    plantStartedIntent(database, portfolio.id, "redelivered-key");
    continuePaperMultiLegIntent(database, OWNER, intentId, NOW + 1, 1);

    const result = submitPaperMultiLegIntent(database, OWNER, identity, routeFamilyPayload(portfolio.id));
    expect(result).toMatchObject({
      intentId,
      status: "terminal",
      outcome: "completed",
      netPnl: "949.770000",
      fees: "0.230000"
    });
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId)).toHaveLength(4);

    // Exact redelivery after terminal replays the durable receipt untouched.
    const replayed = submitPaperMultiLegIntent(database, OWNER, identity, routeFamilyPayload(portfolio.id));
    expect(replayed).toEqual(result);
    expect(listPaperMultiLegIntentEventsFrom(database, OWNER, intentId)).toHaveLength(4);
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE ownerUserId = ? AND idempotencyKey = ?
    `).get(OWNER, identity.idempotencyKey)).toMatchObject({ value: 1 });

    // The same idempotency key can never hop to another portfolio.
    const other = portfolioIn(database, "portfolio-hop", 100_000_000_000);
    expect(() => submitPaperMultiLegIntent(database, OWNER, identity, routeFamilyPayload(other.id)))
      .toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });
});

describe("multi-leg signed money rendering", () => {
  it("keeps negative research PnL explicit in the canonical six-decimal form", () => {
    expect(formatSignedMultiLegMicros(949_770_000)).toBe("949.770000");
    expect(formatSignedMultiLegMicros(-50_030_000)).toBe("-50.030000");
    expect(formatSignedMultiLegMicros(0)).toBe("0.000000");
  });
});

function fixture(initialCapitalMicros = 100_000_000_000) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => NOW - 1_000_000, { legacyOwnerUserId: OWNER });
  const portfolio = portfolioIn(database, "portfolio-primary", initialCapitalMicros);
  return { database, portfolio };
}

function portfolioIn(database: DatabaseSync, portfolioId: string, initialCapitalMicros: number) {
  sequence += 1;
  return createPaperPortfolioIn(database, OWNER, {
    mutationId: `portfolio-create-${sequence}`,
    idempotencyKey: `portfolio-create-key-${sequence}`,
    requestHash: "b".repeat(64),
    now: NOW - 500_000,
    portfolioId,
    name: `Portfolio ${sequence}`,
    initialCapitalMicros,
    makeDefault: portfolioId === "portfolio-primary"
  });
}

function mutation(label: string) {
  sequence += 1;
  return {
    mutationId: `${label}-mutation-${sequence}`,
    idempotencyKey: `${label}-key`,
    requestHash: "c".repeat(63) + (sequence % 10),
    now: NOW
  };
}

/** Mirrors the exact create-intent transaction the submit pipeline performs before driving. */
function plantStartedIntent(
  database: DatabaseSync,
  portfolioId: string,
  key: string,
  fillScenario?: PaperMultiLegSubmitPayload["fillScenario"]
) {
  const intentId = paperMultiLegIntentIdFor(OWNER, `${key.replace(/-key$/, "")}-key`);
  const source = routeFamilyPayload(portfolioId, fillScenario).source;
  const plan = buildRouteFamilyPlan(intentId, source, fillScenario);
  const planHash = paperMultiLegHash(plan);
  createPaperMultiLegIntentIn(database, OWNER, {
    intentId,
    portfolioId,
    portfolioEpoch: 1,
    plan,
    planHash,
    reservedCapitalMicros: 1_150_460_000,
    now: NOW
  });
  appendPaperMultiLegIntentEventIn(database, OWNER, intentId, createPaperMultiLegInitialEvent(plan, planHash, NOW));
  return { intentId, plan };
}

function plantRunningIntent(database: DatabaseSync, portfolioId: string, key: string, reservedCapitalMicros = 1_000_000) {
  const intentId = paperMultiLegIntentIdFor(OWNER, key);
  const plan = buildRouteFamilyPlan(intentId, routeFamilyPayload(portfolioId).source);
  createPaperMultiLegIntentIn(database, OWNER, {
    intentId,
    portfolioId,
    portfolioEpoch: 1,
    plan,
    planHash: paperMultiLegHash(plan),
    reservedCapitalMicros,
    now: NOW
  });
  return intentId;
}

function buildRouteFamilyPlan(
  runId: string,
  source: PaperMultiLegSubmitPayload["source"],
  scenarios?: PaperMultiLegSubmitPayload["fillScenario"]
) {
  const opportunity = source.opportunity as unknown as PairwiseOpportunity;
  const legs = opportunity.legs.map((leg, index) => ({
    legId: `${opportunity.routeId}:${leg.role}`,
    venue: leg.venue,
    instrumentId: leg.instrumentId,
    side: leg.side,
    quantityUnit: leg.quantityUnit,
    plannedQuantity: leg.nativeQuantity,
    referencePrice: leg.averagePrice,
    feeBps: leg.entryFeeBps,
    paperFillRatioBps: scenarios?.[index]?.fillRatioBps ?? 10_000,
    paperCompensationFillRatioBps: scenarios?.[index]?.compensationFillRatioBps ?? 10_000,
    paperCompensationPrice: scenarios?.[index]?.compensationPrice ?? leg.averagePrice,
    paperCompensationFeeBps: scenarios?.[index]?.compensationFeeBps ?? leg.entryFeeBps,
    evidenceId: `fixture-${index === 0 ? "spot" : "future"}-book`
  }));
  return {
    schemaVersion: "paper-multi-leg-plan-v1" as const,
    runId,
    source: {
      kind: "route-family" as const,
      engine: "route-families-v1" as const,
      family: "spot-dated-future" as const,
      opportunityId: opportunity.id,
      evaluatedAt: opportunity.timestamps.evaluatedAt,
      provenanceHash: paperMultiLegHash(opportunity.provenance)
    },
    createdAt: NOW,
    expiresAt: NOW + 5 * 60_000,
    executionMode: "paper-sequential-legs" as const,
    simulationPolicy: "explicit-deterministic-fill-ratios-v1" as const,
    legs
  };
}

/** Uninterrupted pure-engine reference run for the identical-terminal-state assertion. */
function referenceEvents(plan: ReturnType<typeof buildRouteFamilyPlan>, intentId: string): PaperMultiLegEvent[] {
  const events: PaperMultiLegEvent[] = [createPaperMultiLegInitialEvent(plan, paperMultiLegHash(plan), NOW)];
  for (let step = 0; step < 24; step += 1) {
    const state = replayPaperMultiLegEvents(events, intentId);
    if (state.terminal) break;
    const next = nextPaperMultiLegEvent(state, NOW + 60_000);
    if (!next) break;
    events.push(next);
  }
  return events;
}

function transition(event: PaperMultiLegEvent): string {
  return stableJson({ type: event.type, data: event.data });
}

function routeFamilyPayload(
  portfolioId: string,
  fillScenario?: PaperMultiLegSubmitPayload["fillScenario"]
): PaperMultiLegSubmitPayload {
  return {
    version: 1,
    kind: "paper-multi-leg.submit",
    portfolioId,
    source: {
      type: "route-family",
      family: "spot-dated-future",
      opportunity: routeFamilyOpportunity() as unknown as Record<string, unknown>
    },
    ...(fillScenario ? { fillScenario } : {})
  };
}

function nLegPayload(portfolioId: string): PaperMultiLegSubmitPayload {
  return {
    version: 1,
    kind: "paper-multi-leg.submit",
    portfolioId,
    source: { type: "n-leg", opportunity: nLegOpportunity() as unknown as Record<string, unknown> }
  };
}

function nLegOpportunity(): NLegOpportunity {
  return {
    id: "n-leg-opportunity:fixture",
    strategyKind: "n-leg-cycle",
    edgeKind: "research-simulation",
    executable: false,
    executionModel: "sequential-visible-depth",
    cycleId: "fixture-cycle",
    venue: "fixture",
    legCount: 4,
    start: { venue: "fixture", assetId: "USDT", unitId: "native" },
    startKey: "fixture:USDT:native",
    requestedStartQuantity: 100,
    startQuantity: 100,
    endQuantity: 101,
    netReturnBps: 100,
    capacityUtilizationPct: 100,
    depthLimited: false,
    legs: Array.from({ length: 4 }, (_, index) => ({
      index,
      instrumentId: `fixture-market-${index}`,
      venue: "fixture",
      symbol: `M${index}`,
      side: index % 2 === 0 ? ("buy" as const) : ("sell" as const),
      from: { venue: "fixture", assetId: `A${index}`, unitId: "native" },
      to: { venue: "fixture", assetId: `A${index + 1}`, unitId: "native" },
      fromKey: `fixture:A${index}:native`,
      toKey: `fixture:A${index + 1}:native`,
      inputQuantity: index + 1,
      tradeInputQuantity: index + 1,
      totalInputDebitedQuantity: index + 1,
      inputDustQuantity: 0,
      orderBaseQuantity: index + 1,
      averagePrice: 100 + index,
      worstPrice: 100 + index,
      quoteNotional: (index + 1) * (100 + index),
      grossOutputQuantity: index + 1,
      feeScheduleId: `fee-${index}`,
      feeTierId: "tier-0",
      feeBps: 2,
      feeAsset: { venue: "fixture", assetId: `A${index + 1}`, unitId: "native" },
      feeAssetKey: `fixture:A${index + 1}:native`,
      feeDebit: "output" as const,
      feeQuantity: 0.001,
      outputQuantity: index + 1,
      levelsUsed: 1,
      exchangeTs: NOW - 20,
      receivedAt: NOW - 15,
      sequence: 1
    })),
    residuals: [],
    dustByAssetUnit: {},
    feesByAssetUnit: {},
    timestamps: {
      evaluatedAt: NOW - 10,
      oldestExchangeTs: NOW - 20,
      newestExchangeTs: NOW - 20,
      oldestReceivedAt: NOW - 15,
      newestReceivedAt: NOW - 15,
      quoteAgeMs: 20,
      legSkewMs: 0,
      sequenceVerified: true,
      exchangeTimestampsVerified: true
    },
    provenance: {
      engine: "n-leg-v1",
      canonicalSignature: "fixture-signature",
      instrumentIds: Array.from({ length: 4 }, (_, index) => `fixture-market-${index}`),
      feeScheduleIds: Array.from({ length: 4 }, (_, index) => `fee-${index}`),
      bookSourceIds: Array.from({ length: 4 }, (_, index) => `fixture-book-${index}`)
    }
  };
}

function routeFamilyOpportunity(): PairwiseOpportunity {
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
      exchangeTs: NOW - 20,
      receivedAt: NOW - 15
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
      exchangeTs: NOW - 19,
      receivedAt: NOW - 14
    }
  ];
  return {
    id: "pairwise-opportunity:fixture",
    strategyKind: "spot-dated-future",
    edgeKind: "research-simulation",
    executable: false,
    routeId: "rf:spot-dated-future:fixture",
    legs,
    timestamps: { evaluatedAt: NOW - 10 },
    provenance: { engine: "pairwise-v1", books: [{ sourceId: "fixture-spot-book" }, { sourceId: "fixture-future-book" }] }
  } as unknown as PairwiseOpportunity;
}
