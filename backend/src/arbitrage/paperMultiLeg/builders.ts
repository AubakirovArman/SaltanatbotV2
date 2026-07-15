import type { NLegOpportunity } from "../engines/nLeg/index.js";
import type { PairwiseOpportunity } from "../engines/pairwise/index.js";
import type { RouteFamily } from "../routeFamilies/index.js";
import { paperMultiLegHash } from "./canonical.js";
import { parsePaperMultiLegPlan } from "./schema.js";
import type { PaperMultiLegPlan, PaperMultiLegPlanLeg } from "./types.js";

export interface PaperMultiLegFillScenario {
  fillRatioBps?: number;
  compensationFillRatioBps?: number;
  compensationPrice?: number;
  compensationFeeBps?: number;
}

interface BuilderBase {
  runId: string;
  createdAt: number;
  expiresAt: number;
  scenarios?: readonly PaperMultiLegFillScenario[];
}

export function paperMultiLegPlanFromNLeg(opportunity: NLegOpportunity, input: BuilderBase): PaperMultiLegPlan {
  if (
    opportunity.executable !== false ||
    opportunity.edgeKind !== "research-simulation" ||
    opportunity.strategyKind !== "n-leg-cycle" ||
    opportunity.provenance.engine !== "n-leg-v1" ||
    opportunity.legCount !== opportunity.legs.length ||
    opportunity.legs.length < 4 ||
    opportunity.legs.length > 8 ||
    opportunity.provenance.bookSourceIds.length !== opportunity.legs.length
  ) {
    throw new Error("N-leg paper plan requires an exact non-executable n-leg-v1 opportunity");
  }
  validateScenarioCount(input.scenarios, opportunity.legs.length);
  const plan: PaperMultiLegPlan = {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId: input.runId,
    source: {
      kind: "n-leg",
      engine: "n-leg-v1",
      opportunityId: opportunity.id,
      evaluatedAt: opportunity.timestamps.evaluatedAt,
      provenanceHash: paperMultiLegHash(opportunity.provenance)
    },
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: opportunity.legs.map((leg, index) =>
      planLeg(
        {
          legId: `nleg:${index}:${paperMultiLegHash(opportunity.cycleId).slice(0, 20)}`,
          venue: leg.venue,
          instrumentId: leg.instrumentId,
          side: leg.side,
          quantityUnit: "base",
          plannedQuantity: leg.orderBaseQuantity,
          referencePrice: leg.averagePrice,
          feeBps: leg.feeBps,
          evidenceId: requiredEvidence(opportunity.provenance.bookSourceIds[index], index)
        },
        input.scenarios?.[index]
      )
    )
  };
  return parsePaperMultiLegPlan(plan);
}

export function paperMultiLegPlanFromRouteFamily(opportunity: PairwiseOpportunity, family: RouteFamily, input: BuilderBase): PaperMultiLegPlan {
  if (opportunity.executable !== false || opportunity.edgeKind !== "research-simulation" || opportunity.provenance.engine !== "pairwise-v1" || opportunity.legs.length !== 2 || opportunity.strategyKind !== pairwiseKindForFamily(family) || opportunity.provenance.books.length !== opportunity.legs.length) {
    throw new Error("Route-family paper plan requires an exact non-executable pairwise-v1 opportunity");
  }
  validateScenarioCount(input.scenarios, opportunity.legs.length);
  const plan: PaperMultiLegPlan = {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId: input.runId,
    source: {
      kind: "route-family",
      engine: "route-families-v1",
      family,
      opportunityId: opportunity.id,
      evaluatedAt: opportunity.timestamps.evaluatedAt,
      provenanceHash: paperMultiLegHash(opportunity.provenance)
    },
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: opportunity.legs.map((leg, index) =>
      planLeg(
        {
          legId: `${opportunity.routeId}:${leg.role}`,
          venue: leg.venue,
          instrumentId: leg.instrumentId,
          side: leg.side,
          quantityUnit: leg.quantityUnit,
          plannedQuantity: leg.nativeQuantity,
          referencePrice: leg.averagePrice,
          feeBps: leg.entryFeeBps,
          evidenceId: requiredEvidence(opportunity.provenance.books[index]?.sourceId, index)
        },
        input.scenarios?.[index]
      )
    )
  };
  return parsePaperMultiLegPlan(plan);
}

function planLeg(input: Omit<PaperMultiLegPlanLeg, "paperFillRatioBps" | "paperCompensationFillRatioBps" | "paperCompensationPrice" | "paperCompensationFeeBps">, scenario: PaperMultiLegFillScenario | undefined): PaperMultiLegPlanLeg {
  return {
    ...input,
    paperFillRatioBps: scenario?.fillRatioBps ?? 10_000,
    paperCompensationFillRatioBps: scenario?.compensationFillRatioBps ?? 10_000,
    paperCompensationPrice: scenario?.compensationPrice ?? input.referencePrice,
    paperCompensationFeeBps: scenario?.compensationFeeBps ?? input.feeBps
  };
}

function requiredEvidence(value: string | undefined, index: number): string {
  if (!value?.trim()) throw new Error(`Paper multi-leg leg ${index} has no source evidence ID`);
  return value;
}

function validateScenarioCount(scenarios: readonly PaperMultiLegFillScenario[] | undefined, legCount: number): void {
  if (scenarios && scenarios.length > legCount) throw new Error("Paper fill scenario count exceeds the source leg count");
}

function pairwiseKindForFamily(family: RouteFamily): PairwiseOpportunity["strategyKind"] {
  switch (family) {
    case "cross-venue-spot-spot":
      return "spot-spot";
    case "perpetual-perpetual-funding":
      return "perpetual-perpetual";
    case "reverse-cash-and-carry":
    case "spot-dated-future":
    case "calendar-spread":
    case "perpetual-future":
      return family;
  }
}
