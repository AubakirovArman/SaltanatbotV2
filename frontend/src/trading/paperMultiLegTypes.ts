export type PaperMultiLegStatus = "executing" | "awaiting-compensation-decision" | "compensating" | "completed" | "compensated" | "aborted-no-exposure" | "manual-review-required";

export type PaperMultiLegTerminalStatus = Extract<PaperMultiLegStatus, "completed" | "compensated" | "aborted-no-exposure" | "manual-review-required">;

export interface PaperMultiLegSafety {
  executionMode: "paper-only";
  liveOrders: false;
  privateRequests: false;
  credentialsAccepted: false;
}

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

export type PaperMultiLegPlanSource =
  | {
      kind: "n-leg";
      engine: "n-leg-v1";
      opportunityId: string;
      evaluatedAt: number;
      provenanceHash: string;
    }
  | {
      kind: "route-family";
      engine: "route-families-v1";
      family: "cross-venue-spot-spot" | "reverse-cash-and-carry" | "perpetual-perpetual-funding" | "spot-dated-future" | "calendar-spread" | "perpetual-future";
      opportunityId: string;
      evaluatedAt: number;
      provenanceHash: string;
    };

export interface PaperMultiLegPlan {
  schemaVersion: "paper-multi-leg-plan-v1";
  runId: string;
  source: PaperMultiLegPlanSource;
  createdAt: number;
  expiresAt: number;
  executionMode: "paper-sequential-legs";
  simulationPolicy: "explicit-deterministic-fill-ratios-v1";
  legs: PaperMultiLegPlanLeg[];
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

export interface PaperMultiLegDecision {
  action: "reverse-filled-legs" | "none-no-exposure";
  reason: "original-leg-incomplete";
  targetLegIds: string[];
  expectedFullCompensation: boolean;
}

export interface PaperMultiLegTerminal {
  status: PaperMultiLegTerminalStatus;
  reason: "all-paper-legs-filled" | "all-paper-exposure-reversed" | "no-paper-exposure-created" | "paper-compensation-incomplete";
  unresolvedExposure: Array<{
    legId: string;
    instrumentId: string;
    quantityUnit: PaperMultiLegPlanLeg["quantityUnit"];
    quantity: number;
  }>;
}

export type PaperMultiLegEvent = {
  eventId: string;
  runId: string;
  sequence: number;
  ts: number;
} & (
  | { type: "run-created"; data: { plan: PaperMultiLegPlan; planHash: string; safety: PaperMultiLegSafety } }
  | { type: "original-fill" | "compensation-fill"; data: { fill: PaperMultiLegFill } }
  | { type: "compensation-decision"; data: { decision: PaperMultiLegDecision } }
  | { type: "run-terminal"; data: { terminal: PaperMultiLegTerminal } }
);

export interface PaperMultiLegRunState {
  runId: string;
  planHash: string;
  plan: PaperMultiLegPlan;
  status: PaperMultiLegStatus;
  originalFills: PaperMultiLegFill[];
  compensationDecision?: PaperMultiLegDecision;
  compensationFills: PaperMultiLegFill[];
  terminal?: PaperMultiLegTerminal;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaperMultiLegRunView {
  state: PaperMultiLegRunState;
  events: PaperMultiLegEvent[];
}

export interface PaperMultiLegRunSummary {
  runId: string;
  sourceKind: PaperMultiLegPlanSource["kind"];
  opportunityId: string;
  status: PaperMultiLegStatus;
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
