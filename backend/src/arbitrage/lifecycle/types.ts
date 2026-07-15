/** Scanner-agnostic route categories understood by the opportunity lifecycle. */
export type OpportunityLifecycleKind = "basis" | "triangular" | "native-spread" | "pairwise";

export type OpportunityLifecycleStatus = "first-seen" | "confirmed" | "decaying" | "expired";
export type OpportunityEvidenceQuality = "unverified" | "degraded" | "fresh" | "verified";

/** One independently timestamped leg/source contributing to a route candidate. */
export interface OpportunityEvidence {
  sourceId: string;
  observedAt: number;
  quality: OpportunityEvidenceQuality;
  complete: boolean;
}

/** Minimal adapter boundary shared by basis, triangular, native-spread and pairwise scanners. */
export interface OpportunityLifecycleCandidate {
  kind: OpportunityLifecycleKind;
  routeId: string;
  /** Stable identity for one set of market observations; retries must reuse it. */
  observationId: string;
  /** Higher values are better. Units are selected by the caller, normally net basis points. */
  score: number;
  evidence: readonly OpportunityEvidence[];
}

export interface OpportunityUniverseCoverage {
  /** True only when every route and required source was considered. */
  complete: boolean;
  stale: boolean;
  truncated: boolean;
  failedSources: readonly string[];
}

export interface OpportunityLifecycleSnapshot {
  /** Stable scanner/feed boundary; absence is evaluated only inside this universe. */
  universeId: string;
  /** Caller-declared immutable policy version. Reusing it with different values is rejected. */
  policyId: string;
  snapshotId: string;
  evaluatedAt: number;
  coverage: OpportunityUniverseCoverage;
  candidates: readonly OpportunityLifecycleCandidate[];
}

export interface OpportunityLifecyclePolicy {
  enterScore: number;
  /** Must not exceed enterScore; this gap supplies score hysteresis. */
  exitScore: number;
  confirmationObservations: number;
  confirmationMinDurationMs: number;
  minimumEvidenceQuality: OpportunityEvidenceQuality;
  minimumEvidenceSources: number;
  observationFreshForMs: number;
  decayGraceMs: number;
  maxFutureSkewMs: number;
  expiredRetentionMs: number;
  maxRoutes: number;
  maxEvents: number;
  maxCandidatesPerSnapshot: number;
  maxEvidenceSourcesPerCandidate: number;
  maxRecentObservationIds: number;
}

export interface OpportunityLifecycleRoute {
  key: string;
  universeId: string;
  policyId: string;
  kind: OpportunityLifecycleKind;
  routeId: string;
  status: OpportunityLifecycleStatus;
  /** Never treat this as an execution permission; it only means lifecycle policy passed. */
  actionable: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  lastObservationAt: number;
  lastObservationId: string;
  recentObservationIds: string[];
  score: number;
  rawEvidenceQuality: OpportunityEvidenceQuality;
  effectiveEvidenceQuality: OpportunityEvidenceQuality;
  evidenceSourceIds: string[];
  evidenceComplete: boolean;
  confirmationCount: number;
  confirmationStartedAt?: number;
  confirmedAt?: number;
  decayStartedAt?: number;
  expiredAt?: number;
  lastReason: OpportunityLifecycleReason;
}

export interface OpportunityLifecycleUniverse {
  universeId: string;
  lastPolicyId: string;
  lastSnapshotId: string;
  lastSnapshotFingerprint: string;
  lastEvaluatedAt: number;
  coverageComplete: boolean;
  lastCoverageReason: OpportunityLifecycleReason;
}

export type OpportunityLifecycleReason =
  | "candidate-observed"
  | "confirmation-complete"
  | "score-below-entry"
  | "score-below-exit"
  | "evidence-incomplete"
  | "evidence-quality"
  | "evidence-stale"
  | "route-absent"
  | "universe-incomplete"
  | "universe-restored"
  | "policy-changed"
  | "duplicate-route-conflict"
  | "observation-replayed"
  | "observation-out-of-order"
  | "observation-future"
  | "decay-grace-elapsed"
  | "route-capacity-reached";

export type OpportunityLifecycleEventType = "universe" | "transition" | "evidence-rejected";

export interface OpportunityLifecycleEvent {
  id: string;
  sequence: number;
  type: OpportunityLifecycleEventType;
  universeId: string;
  policyId: string;
  kind?: OpportunityLifecycleKind;
  routeId?: string;
  from?: OpportunityLifecycleStatus;
  to?: OpportunityLifecycleStatus;
  reason: OpportunityLifecycleReason;
  effectiveAt: number;
  evaluatedAt: number;
  observationId?: string;
}

/** JSON-compatible state. Callers may persist it atomically without giving the engine I/O. */
export interface OpportunityLifecycleState {
  schemaVersion: 1;
  nextEventSequence: number;
  /** SHA-256 of each immutable declared policy version. */
  policies: Record<string, string>;
  universes: Record<string, OpportunityLifecycleUniverse>;
  routes: Record<string, OpportunityLifecycleRoute>;
  history: OpportunityLifecycleEvent[];
}

export interface OpportunityLifecycleEvaluation {
  state: OpportunityLifecycleState;
  /** False means presence/absence was not a complete view and every route is non-actionable. */
  universeComplete: boolean;
  /** Events produced by this call before bounded history retention is applied. */
  events: OpportunityLifecycleEvent[];
  routes: OpportunityLifecycleRoute[];
  idempotent: boolean;
}
