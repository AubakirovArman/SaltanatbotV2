import { assertMarketOpportunityEnvelope, MARKET_OPPORTUNITY_SCHEMA_VERSION, NATIVE_SPREAD_OPPORTUNITY_MAX_AGE_MS, normalizeBasisOpportunity, normalizeContinuousMarketOpportunity, normalizeNativeSpreadOpportunity, type ContinuousMarketEvaluation, type MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import type { ArbitrageOpportunity } from "./client";
import type { BasisDisplayedScenario } from "./fees";
import type { NativeSpreadOpportunity } from "./nativeSpreadClient";
import type { TriangularOpportunity } from "./triangularClient";

const LIVE_RESEARCH_BOUNDARY = "Live multi-leg execution is not supported by the market-opportunity-v1 research handoff.";
const TRIANGULAR_PAPER_BOUNDARY = "The REST top-book candidate is not sequence-verified and does not contain a paper-multi-leg-plan-v1 artifact.";

/** Adapt the exact displayed basis scenario without promoting it to an executable plan. */
export function adaptBasisOpportunity(row: ArbitrageOpportunity, scenario?: BasisDisplayedScenario): MarketOpportunityEnvelope {
  const baseline = normalizeBasisOpportunity(row);
  if (!scenario) return assertAutomationOpportunityBoundary(baseline, false);
  const executableBaseQuantity = scenario.basisScenario.executableNotionalUsd > 0 ? scenario.basisScenario.executableNotionalUsd / row.spotAsk : undefined;
  const envelope: MarketOpportunityEnvelope = {
    ...baseline,
    legs: baseline.legs.map((leg) => ({ ...leg, quantity: executableBaseQuantity })),
    economics: {
      ...baseline.economics,
      netEdgeBps: scenario.netEdgeBps,
      expectedNetProfit: { value: scenario.projectedNetProfitUsd, currency: "USD" },
      aggregateEstimatedCostBps: scenario.basisScenario.costBreakdownBps.total,
      funding: scenario.basisScenario.costBreakdownBps.fundingScheduleVerified ? "included" : "unknown",
      borrow: "included",
      slippage: "estimate",
      basisScenario: scenario.basisScenario
    },
    capacity: {
      ...baseline.capacity,
      quantity: executableBaseQuantity,
      quantityUnit: "base",
      notional: { value: scenario.basisScenario.executableNotionalUsd, currency: "USD" },
      depthLimited: scenario.basisScenario.executableNotionalUsd < scenario.basisScenario.requestedNotionalUsd
    },
    evidence: {
      ...baseline.evidence,
      provenanceIds: [...baseline.evidence.provenanceIds, scenario.basisScenario.model]
    }
  };
  return assertAutomationOpportunityBoundary(envelope, false);
}

/** Preserve the continuous engine's verified public-book evidence without promoting missing account/strategy evidence. */
export function adaptContinuousMarketOpportunity(row: ContinuousMarketEvaluation, context: { now?: number; sourceCurrent?: boolean } = {}): MarketOpportunityEnvelope {
  if (row.status !== "market-only") throw new Error("A blocked continuous route has no complete market opportunity to hand off");
  return assertAutomationOpportunityBoundary(normalizeContinuousMarketOpportunity(row, context), false);
}

export function isContinuousMarketOpportunityFresh(row: ContinuousMarketEvaluation, now: number, sourceCurrent: boolean): boolean {
  return row.status === "market-only" && sourceCurrent && row.freshness.quoteAgeMs + Math.max(0, now - row.evaluatedAt) <= row.freshness.maxBookAgeMs;
}

/** Adapt an unsequenced REST triangular candidate. It is deliberately research-only. */
export function adaptTriangularOpportunity(row: TriangularOpportunity): MarketOpportunityEnvelope {
  const envelope: MarketOpportunityEnvelope = {
    schemaVersion: MARKET_OPPORTUNITY_SCHEMA_VERSION,
    id: row.id,
    family: "n-leg-cycle",
    kind: "cycle",
    source: {
      engine: "triangular-rest-top-book-v1",
      opportunityId: row.id,
      evaluatedAt: row.timestamps.evaluatedAt
    },
    legs: row.legs.map((leg) => ({
      id: `${row.id}:${leg.index}`,
      venue: row.venue,
      instrumentId: `${row.venue}:spot:${leg.symbol}`,
      symbol: leg.symbol,
      marketType: "spot",
      side: leg.side,
      role: "cycle",
      identityScope: "canonical-instrument",
      quantityUnit: leg.side === "buy" ? "quote" : "base",
      referencePrice: leg.averagePrice,
      evidenceId: `${row.venue}:rest-top-book:${leg.symbol}`
    })),
    economics: {
      outcome: "research-simulation",
      grossEdgeBps: row.grossReturnBps,
      netEdgeBps: row.netReturnBps,
      costCoverage: "aggregate-estimate",
      aggregateEstimatedCostBps: row.grossReturnBps - row.netReturnBps,
      funding: "excluded",
      borrow: "excluded",
      slippage: "excluded"
    },
    capacity: {
      quantity: row.limitingCapacity.executableStartQuantity,
      quantityUnit: "native",
      depthLimited: false
    },
    evidence: {
      evaluatedAt: row.timestamps.evaluatedAt,
      quoteAgeMs: row.timestamps.quoteAgeMs,
      legSkewMs: row.timestamps.legSkewMs,
      sequenceContinuity: "unverified",
      exchangeTimestamps: row.timestamps.exchangeTimestampsVerified ? "verified" : "unverified",
      dataQuality: "unverified",
      sourceIds: row.legs.map((leg) => `${row.venue}:rest-top-book:${leg.symbol}`),
      provenanceIds: [`${row.venue}:rest-snapshot`, ...row.riskFlags]
    },
    execution: {
      research: "available",
      paperPlan: "blocked",
      live: "blocked",
      atomicity: "none",
      paperBlockers: [TRIANGULAR_PAPER_BOUNDARY],
      liveBlockers: [LIVE_RESEARCH_BOUNDARY]
    },
    blockers: [
      {
        code: "unsequenced-rest-top-book",
        stage: "paper-execution",
        message: TRIANGULAR_PAPER_BOUNDARY
      },
      ...row.riskFlags.map((code) => ({
        code,
        stage: "market-data" as const,
        message: `Triangular candidate boundary: ${code}`
      }))
    ]
  };

  return assertAutomationOpportunityBoundary(envelope, false);
}

/** Adapt a Bybit combination book while preserving derived component sides and its read-only boundary. */
export function adaptNativeSpreadOpportunity(row: NativeSpreadOpportunity, context: { evaluatedAt?: number; now?: number } = {}): MarketOpportunityEnvelope {
  return assertAutomationOpportunityBoundary(normalizeNativeSpreadOpportunity(row, context), false);
}

export function currentNativeSpreadQuoteAgeMs(row: NativeSpreadOpportunity, evaluatedAt: number, now: number): number {
  return Math.max(0, evaluatedAt - row.exchangeTs) + Math.max(0, now - evaluatedAt);
}

export function isNativeSpreadOpportunityFresh(row: NativeSpreadOpportunity, evaluatedAt: number, now: number): boolean {
  return currentNativeSpreadQuoteAgeMs(row, evaluatedAt, now) <= NATIVE_SPREAD_OPPORTUNITY_MAX_AGE_MS;
}

/**
 * The browser handoff is not an execution API. The only artifact allowed to
 * advertise a ready paper plan is the SDK's sequence-verified n-leg result.
 */
export function assertAutomationOpportunityBoundary(envelope: MarketOpportunityEnvelope, allowVerifiedNLeg = true): MarketOpportunityEnvelope {
  const safe = assertMarketOpportunityEnvelope(envelope);
  if (safe.execution.live !== "blocked") throw new Error("Automation opportunity handoff cannot enable live execution");
  if (safe.execution.paperPlan === "ready") {
    const verifiedNLeg = allowVerifiedNLeg && safe.family === "n-leg-cycle" && safe.kind === "cycle" && safe.source.engine === "n-leg-v1" && safe.evidence.sequenceContinuity === "verified" && safe.evidence.exchangeTimestamps === "verified" && safe.legs.every((leg) => leg.side !== "derived");
    if (!verifiedNLeg) throw new Error("Only a verified n-leg-v1 opportunity may expose a ready paper plan");
  }
  return safe;
}
