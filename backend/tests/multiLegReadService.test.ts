import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PairwiseOpportunity } from "../src/arbitrage/engines/pairwise/index.js";
import { paperMultiLegHash } from "../src/arbitrage/paperMultiLeg/canonical.js";
import {
  setPaperMultiLegKillSwitch,
  submitPaperMultiLegIntent,
  type PaperMultiLegSubmitPayload
} from "../src/trading/multiLeg/intentService.js";
import { createPaperMultiLegIntentIn, paperMultiLegIntentIdFor } from "../src/trading/multiLeg/intentStore.js";
import { PaperPortfolioReadService } from "../src/trading/paperPortfolioReadService.js";
import { createPaperPortfolioIn } from "../src/trading/paperPortfolioStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";

const NOW = 2_000_000_000_000;
const OWNER = "multi-leg-reads-owner";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("multi-leg read model additions", () => {
  it("exposes the exact browser-shaped multiLeg section for a terminal intent", () => {
    const { database, portfolio } = fixture();
    submitPaperMultiLegIntent(database, OWNER, mutation("terminal-view"), submitPayload(portfolio.id, [
      { compensationFillRatioBps: 5_000 },
      { fillRatioBps: 0 }
    ]));

    const detail = service(database).detail(OWNER, portfolio.id, NOW + 1_000);

    expect(detail.multiLeg.killSwitchEnabled).toBe(false);
    expect(detail.multiLeg.intents).toEqual([{
      intentId: paperMultiLegIntentIdFor(OWNER, "terminal-view-key"),
      status: "terminal",
      outcome: "manual-review-required",
      sourceEngine: "route-families-v1",
      sourceOpportunityId: "pairwise-opportunity:fixture",
      legCount: 2,
      reservedCapital: "1150.460000",
      netPnl: "-50.030000",
      fees: "0.030000",
      createdAt: NOW,
      legs: [
        {
          venue: "fixture-a",
          instrumentId: "fixture-spot",
          side: "buy",
          plannedQuantity: 1,
          filledQuantity: 1,
          averagePrice: 100,
          fee: 0.03,
          compensated: true
        },
        {
          venue: "fixture-b",
          instrumentId: "fixture-future",
          side: "sell",
          plannedQuantity: 10,
          filledQuantity: 0,
          averagePrice: 105,
          fee: 0,
          compensated: false
        }
      ],
      residualExposure: [{
        legId: "rf:spot-dated-future:fixture:long",
        instrumentId: "fixture-spot",
        quantityUnit: "base",
        quantity: 0.5
      }]
    }]);
    // The terminal flip released the reservation, so nothing is subtracted.
    expect(detail.snapshot.aggregates.availableCapital).toBe("2000.000000");
  });

  it("subtracts running multi-leg reservations from availableCapital and lists the running intent", () => {
    const { database, portfolio } = fixture();
    const intentId = plantRunningIntent(database, portfolio.id, "running-view-key", 150_000_000);

    const detail = service(database).detail(OWNER, portfolio.id, NOW + 1_000);

    expect(detail.snapshot.aggregates.availableCapital).toBe("1850.000000");
    // The durable epoch cash itself is never mutated by a running intent.
    expect(detail.snapshot.aggregates.cashBalance).toBe("2000.000000");
    expect(detail.multiLeg.intents).toHaveLength(1);
    expect(detail.multiLeg.intents[0]).toMatchObject({
      intentId,
      status: "running",
      outcome: null,
      netPnl: null,
      fees: null,
      reservedCapital: "150.000000",
      legCount: 2
    });
    // No durable journal yet: legs degrade to plan-only rows, never zeroed money.
    expect(detail.multiLeg.intents[0]?.legs[0]).toEqual({
      venue: "fixture-a",
      instrumentId: "fixture-spot",
      side: "buy",
      plannedQuantity: 1,
      filledQuantity: 0,
      averagePrice: 100,
      fee: 0,
      compensated: false
    });
    expect(detail.multiLeg.intents[0]?.residualExposure).toEqual([]);
  });

  it("never renders negative available capital and reflects the owner kill switch", () => {
    const { database, portfolio } = fixture();
    plantRunningIntent(database, portfolio.id, "oversized-key", 3_000_000_000);
    setPaperMultiLegKillSwitch(database, OWNER, mutation("kill-switch"), {
      version: 1,
      kind: "paper-multi-leg.kill-switch",
      enabled: true
    });

    const detail = service(database).detail(OWNER, portfolio.id, NOW + 1_000);

    expect(detail.snapshot.aggregates.availableCapital).toBe("0.000000");
    expect(detail.multiLeg.killSwitchEnabled).toBe(true);
  });

  it("scopes the multiLeg section to the requested portfolio", () => {
    const { database, portfolio } = fixture();
    const other = createPaperPortfolioIn(database, OWNER, {
      mutationId: "other-create",
      idempotencyKey: "other-create-key",
      requestHash: "b".repeat(64),
      now: NOW - 400_000,
      portfolioId: "portfolio-other",
      name: "Other",
      initialCapitalMicros: 2_000_000_000,
      makeDefault: false
    });
    plantRunningIntent(database, portfolio.id, "scoped-key", 100_000_000);

    const view = service(database).detail(OWNER, other.id, NOW + 1_000);
    expect(view.multiLeg.intents).toEqual([]);
    expect(view.snapshot.aggregates.availableCapital).toBe("2000.000000");
  });
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => NOW - 1_000_000, { legacyOwnerUserId: OWNER });
  const portfolio = createPaperPortfolioIn(database, OWNER, {
    mutationId: "reads-create",
    idempotencyKey: "reads-create-key",
    requestHash: "b".repeat(64),
    now: NOW - 500_000,
    portfolioId: "portfolio-reads",
    name: "Reads portfolio",
    initialCapitalMicros: 2_000_000_000,
    makeDefault: true
  });
  return { database, portfolio };
}

function service(database: DatabaseSync): PaperPortfolioReadService {
  return new PaperPortfolioReadService(database, { isRunning: () => false, isPaused: () => false });
}

let sequence = 0;

function mutation(label: string) {
  sequence += 1;
  return {
    mutationId: `${label}-mutation-${sequence}`,
    idempotencyKey: `${label}-key`,
    requestHash: "c".repeat(63) + (sequence % 10),
    now: NOW
  };
}

function plantRunningIntent(database: DatabaseSync, portfolioId: string, key: string, reservedCapitalMicros: number): string {
  const intentId = paperMultiLegIntentIdFor(OWNER, key);
  const opportunity = routeFamilyOpportunity();
  const plan = {
    schemaVersion: "paper-multi-leg-plan-v1" as const,
    runId: intentId,
    source: {
      kind: "route-family" as const,
      engine: "route-families-v1" as const,
      family: "spot-dated-future" as const,
      opportunityId: opportunity.id,
      evaluatedAt: NOW - 10,
      provenanceHash: paperMultiLegHash(opportunity.provenance)
    },
    createdAt: NOW,
    expiresAt: NOW + 5 * 60_000,
    executionMode: "paper-sequential-legs" as const,
    simulationPolicy: "explicit-deterministic-fill-ratios-v1" as const,
    legs: opportunity.legs.map((leg, index) => ({
      legId: `${opportunity.routeId}:${leg.role}`,
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      side: leg.side,
      quantityUnit: leg.quantityUnit,
      plannedQuantity: leg.nativeQuantity,
      referencePrice: leg.averagePrice,
      feeBps: leg.entryFeeBps,
      paperFillRatioBps: 10_000,
      paperCompensationFillRatioBps: 10_000,
      paperCompensationPrice: leg.averagePrice,
      paperCompensationFeeBps: leg.entryFeeBps,
      evidenceId: `fixture-${index === 0 ? "spot" : "future"}-book`
    }))
  };
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

function submitPayload(
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
