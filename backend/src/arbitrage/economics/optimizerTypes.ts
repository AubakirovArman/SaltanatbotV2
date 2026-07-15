import type { ArbitrageOutcomeClass } from "./types.js";

export interface CapitalResource {
  venue: string;
  asset: string;
  amount: number;
}

export interface CapitalAllocationCandidate {
  routeId: string;
  family: string;
  outcomeClass: ArbitrageOutcomeClass;
  eligible: boolean;
  /** Smallest indivisible allocation unit defined by the route simulator. */
  unitLabel: string;
  minimumUnits: number;
  maximumUnits: number;
  conservativeNetProfitPerUnit: number;
  projectedNetProfitPerUnit: number;
  /** Valuation-asset risk capital used for family caps. */
  riskCapitalPerUnit: number;
  capitalPerUnit: readonly CapitalResource[];
}

export interface FamilyCapitalLimit {
  family: string;
  maximumRiskCapital: number;
}

export interface CapitalAllocationRequest {
  modelVersion: "capital-allocation-v1";
  profitMode: "conservative" | "projected";
  budgets: readonly CapitalResource[];
  candidates: readonly CapitalAllocationCandidate[];
  familyLimits?: readonly FamilyCapitalLimit[];
  allowedOutcomeClasses?: readonly ArbitrageOutcomeClass[];
  maximumOpenRoutes: number;
  /** Hard deterministic work bound. A truncated answer is never labelled optimal. */
  maximumSearchNodes: number;
}

export type AllocationRejectionCode =
  | "ineligible"
  | "outcome-class-disabled"
  | "non-positive-profit"
  | "missing-capital-budget"
  | "below-minimum-size"
  | "not-selected";

export interface CapitalAllocation {
  routeId: string;
  family: string;
  outcomeClass: ArbitrageOutcomeClass;
  unitLabel: string;
  units: number;
  riskCapital: number;
  netProfit: number;
  requiredCapital: CapitalResource[];
}

export interface AllocationRejection {
  routeId: string;
  code: AllocationRejectionCode;
  message: string;
}

export interface CapitalAllocationResult {
  modelVersion: "capital-allocation-v1";
  profitMode: "conservative" | "projected";
  optimal: boolean;
  truncated: boolean;
  visitedNodes: number;
  netProfit: number;
  /** Valid but intentionally loose when the bounded search is truncated. */
  upperBoundNetProfit: number;
  absoluteOptimalityGap: number;
  allocations: CapitalAllocation[];
  unusedCapital: CapitalResource[];
  familyRiskCapital: Array<{ family: string; amount: number }>;
  rejections: AllocationRejection[];
}
