import type { OpportunityEvidenceQuality, OpportunityLifecyclePolicy } from "./types.js";

export const DEFAULT_OPPORTUNITY_LIFECYCLE_POLICY: Readonly<OpportunityLifecyclePolicy> = Object.freeze({
  enterScore: 0,
  exitScore: 0,
  confirmationObservations: 2,
  confirmationMinDurationMs: 0,
  minimumEvidenceQuality: "fresh",
  minimumEvidenceSources: 1,
  observationFreshForMs: 5_000,
  decayGraceMs: 10_000,
  maxFutureSkewMs: 1_000,
  expiredRetentionMs: 60 * 60_000,
  maxRoutes: 10_000,
  maxEvents: 10_000,
  maxCandidatesPerSnapshot: 10_000,
  maxEvidenceSourcesPerCandidate: 16,
  maxRecentObservationIds: 8
});

const QUALITY_RANK: Readonly<Record<OpportunityEvidenceQuality, number>> = Object.freeze({ unverified: 0, degraded: 1, fresh: 2, verified: 3 });

export function resolveOpportunityLifecyclePolicy(input: Partial<OpportunityLifecyclePolicy> = {}): OpportunityLifecyclePolicy {
  const policy = { ...DEFAULT_OPPORTUNITY_LIFECYCLE_POLICY, ...input };
  finite(policy.enterScore, "enterScore");
  finite(policy.exitScore, "exitScore");
  if (policy.exitScore > policy.enterScore) throw new TypeError("exitScore must not exceed enterScore");
  integer(policy.confirmationObservations, "confirmationObservations", 1, 1_000);
  integer(policy.confirmationMinDurationMs, "confirmationMinDurationMs", 0, 30 * 24 * 60 * 60_000);
  qualityRank(policy.minimumEvidenceQuality);
  integer(policy.minimumEvidenceSources, "minimumEvidenceSources", 1, 128);
  integer(policy.observationFreshForMs, "observationFreshForMs", 1, 24 * 60 * 60_000);
  integer(policy.decayGraceMs, "decayGraceMs", 0, 30 * 24 * 60 * 60_000);
  integer(policy.maxFutureSkewMs, "maxFutureSkewMs", 0, 60_000);
  integer(policy.expiredRetentionMs, "expiredRetentionMs", 0, 365 * 24 * 60 * 60_000);
  integer(policy.maxRoutes, "maxRoutes", 1, 100_000);
  integer(policy.maxEvents, "maxEvents", 1, 100_000);
  integer(policy.maxCandidatesPerSnapshot, "maxCandidatesPerSnapshot", 1, 100_000);
  integer(policy.maxEvidenceSourcesPerCandidate, "maxEvidenceSourcesPerCandidate", 1, 128);
  integer(policy.maxRecentObservationIds, "maxRecentObservationIds", 1, 128);
  if (policy.minimumEvidenceSources > policy.maxEvidenceSourcesPerCandidate) throw new TypeError("minimumEvidenceSources must not exceed maxEvidenceSourcesPerCandidate");
  return policy;
}

export function qualityRank(quality: OpportunityEvidenceQuality) {
  const rank = QUALITY_RANK[quality];
  if (rank === undefined) throw new TypeError(`Unknown evidence quality: ${String(quality)}`);
  return rank;
}

export function worstQuality(qualities: readonly OpportunityEvidenceQuality[]) {
  return qualities.reduce<OpportunityEvidenceQuality>((worst, quality) => (qualityRank(quality) < qualityRank(worst) ? quality : worst), "verified");
}

export function effectiveQuality(raw: OpportunityEvidenceQuality, ageMs: number, freshForMs: number): OpportunityEvidenceQuality {
  if (ageMs <= freshForMs) return raw;
  return qualityRank(raw) > qualityRank("degraded") ? "degraded" : raw;
}

function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function integer(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
}
