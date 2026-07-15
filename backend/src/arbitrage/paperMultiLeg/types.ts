import type { RouteFamily } from "../routeFamilies/index.js";

export const PAPER_MULTI_LEG_MAX_LEGS = 8;
export const PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN = 24;
export const PAPER_MULTI_LEG_MAX_PLAN_LIFETIME_MS = 5 * 60_000;
export const PAPER_MULTI_LEG_MAX_SOURCE_AGE_MS = 60_000;

export type PaperMultiLegTerminalStatus = "completed" | "compensated" | "aborted-no-exposure" | "manual-review-required";

export type PaperMultiLegRunStatus = "executing" | "awaiting-compensation-decision" | "compensating" | PaperMultiLegTerminalStatus;

export type PaperMultiLegSource =
  | {
      kind: "route-family";
      engine: "route-families-v1";
      family: RouteFamily;
      opportunityId: string;
      evaluatedAt: number;
      provenanceHash: string;
    }
  | {
      kind: "n-leg";
      engine: "n-leg-v1";
      opportunityId: string;
      evaluatedAt: number;
      provenanceHash: string;
    };

/**
 * Explicit paper assumptions. Ratios are not exchange fill predictions: they
 * are deterministic failure-injection inputs captured in the journal.
 */
export interface PaperMultiLegPlanLeg {
  legId: string;
  venue: string;
  instrumentId: string;
  side: "buy" | "sell";
  quantityUnit: "base" | "quote" | "contract" | "native";
  plannedQuantity: number;
  referencePrice: number;
  feeBps: number;
  paperFillRatioBps: number;
  paperCompensationFillRatioBps: number;
  paperCompensationPrice: number;
  paperCompensationFeeBps: number;
  evidenceId: string;
}

export interface PaperMultiLegPlan {
  schemaVersion: "paper-multi-leg-plan-v1";
  runId: string;
  source: PaperMultiLegSource;
  createdAt: number;
  expiresAt: number;
  executionMode: "paper-sequential-legs";
  simulationPolicy: "explicit-deterministic-fill-ratios-v1";
  legs: readonly PaperMultiLegPlanLeg[];
}

export interface PaperMultiLegFill {
  kind: "original" | "compensation";
  legIndex: number;
  legId: string;
  venue: string;
  instrumentId: string;
  side: "buy" | "sell";
  quantityUnit: PaperMultiLegPlanLeg["quantityUnit"];
  requestedQuantity: number;
  filledQuantity: number;
  unfilledQuantity: number;
  fillRatioBps: number;
  status: "filled" | "partially-filled" | "unfilled";
  averagePrice: number;
  estimatedFee: number;
  evidenceId: string;
}

export interface PaperMultiLegCompensationDecision {
  action: "reverse-filled-legs" | "none-no-exposure";
  reason: "original-leg-incomplete";
  targetLegIds: string[];
  expectedFullCompensation: boolean;
}

export interface PaperMultiLegUnresolvedExposure {
  legId: string;
  instrumentId: string;
  quantityUnit: PaperMultiLegPlanLeg["quantityUnit"];
  quantity: number;
}

export interface PaperMultiLegTerminal {
  status: PaperMultiLegTerminalStatus;
  reason: "all-paper-legs-filled" | "all-paper-exposure-reversed" | "no-paper-exposure-created" | "paper-compensation-incomplete";
  unresolvedExposure: PaperMultiLegUnresolvedExposure[];
}

export type PaperMultiLegEventDraft =
  | {
      type: "run-created";
      data: {
        plan: PaperMultiLegPlan;
        planHash: string;
        safety: typeof PAPER_MULTI_LEG_SAFETY;
      };
    }
  | { type: "original-fill"; data: { fill: PaperMultiLegFill } }
  | {
      type: "compensation-decision";
      data: { decision: PaperMultiLegCompensationDecision };
    }
  | { type: "compensation-fill"; data: { fill: PaperMultiLegFill } }
  | { type: "run-terminal"; data: { terminal: PaperMultiLegTerminal } };

export type PaperMultiLegEvent = PaperMultiLegEventDraft & {
  eventId: string;
  runId: string;
  sequence: number;
  ts: number;
};

export interface PaperMultiLegState {
  runId: string;
  idempotencyKey: string;
  planHash: string;
  plan: PaperMultiLegPlan;
  status: PaperMultiLegRunStatus;
  originalFills: PaperMultiLegFill[];
  compensationDecision?: PaperMultiLegCompensationDecision;
  compensationFills: PaperMultiLegFill[];
  terminal?: PaperMultiLegTerminal;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaperMultiLegRunSummary {
  runId: string;
  sourceKind: PaperMultiLegSource["kind"];
  opportunityId: string;
  status: PaperMultiLegRunStatus;
  legCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaperMultiLegRecoveryStatus {
  status: "not-run" | "running" | "ready" | "failed";
  recoveredRuns: number;
  startedAt?: number;
  completedAt?: number;
  error?: "recovery-failed";
}

export const PAPER_MULTI_LEG_SAFETY = Object.freeze({
  executionMode: "paper-only" as const,
  liveOrders: false as const,
  privateRequests: false as const,
  credentialsAccepted: false as const
});
