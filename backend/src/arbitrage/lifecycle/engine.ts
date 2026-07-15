import { createHash } from "node:crypto";
import { effectiveQuality, qualityRank, resolveOpportunityLifecyclePolicy, worstQuality } from "./policy.js";
import type {
  OpportunityEvidenceQuality,
  OpportunityLifecycleCandidate,
  OpportunityLifecycleEvaluation,
  OpportunityLifecycleEvent,
  OpportunityLifecycleEventType,
  OpportunityLifecycleKind,
  OpportunityLifecyclePolicy,
  OpportunityLifecycleReason,
  OpportunityLifecycleRoute,
  OpportunityLifecycleSnapshot,
  OpportunityLifecycleState,
  OpportunityLifecycleStatus
} from "./types.js";

interface AssessedCandidate {
  candidate: OpportunityLifecycleCandidate;
  routeKey: string;
  oldestObservedAt: number;
  rawQuality: OpportunityEvidenceQuality;
  effectiveQuality: OpportunityEvidenceQuality;
  complete: boolean;
  stale: boolean;
  future: boolean;
  sourceIds: string[];
}

interface EventFields {
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

export function createOpportunityLifecycleState(): OpportunityLifecycleState {
  return { schemaVersion: 1, nextEventSequence: 1, policies: {}, universes: {}, routes: {}, history: [] };
}

/**
 * Pure lifecycle reduction. It has no clock, persistence, notification or trading side effects.
 * The caller must treat `actionable` as lifecycle readiness only, never order permission.
 */
export function evaluateOpportunityLifecycle(previous: OpportunityLifecycleState, snapshot: OpportunityLifecycleSnapshot, policyInput: Partial<OpportunityLifecyclePolicy> = {}): OpportunityLifecycleEvaluation {
  assertState(previous);
  const policy = resolveOpportunityLifecyclePolicy(policyInput);
  validateSnapshot(snapshot, policy);
  const state = cloneState(previous);
  const resolvedPolicyFingerprint = policyFingerprint(policy);
  const registeredPolicy = state.policies[snapshot.policyId];
  if (registeredPolicy !== undefined && registeredPolicy !== resolvedPolicyFingerprint) throw new TypeError("A policyId cannot be reused with different lifecycle policy values");
  if (registeredPolicy === undefined && Object.keys(state.policies).length >= ABSOLUTE_MAX_POLICY_VERSIONS) throw new TypeError("Opportunity lifecycle policy registry capacity reached");
  state.policies[snapshot.policyId] = resolvedPolicyFingerprint;
  pruneExpiredRoutes(state, snapshot.evaluatedAt, policy.expiredRetentionMs);
  const fingerprint = snapshotFingerprint(snapshot, resolvedPolicyFingerprint);
  const previousUniverse = state.universes[snapshot.universeId];
  if (!previousUniverse && Object.keys(state.universes).length >= ABSOLUTE_MAX_UNIVERSES) throw new TypeError("Opportunity lifecycle universe capacity reached");
  if (previousUniverse && snapshot.evaluatedAt < previousUniverse.lastEvaluatedAt) throw new TypeError("Lifecycle snapshots must be monotonic within a universe");
  if (previousUniverse?.lastSnapshotId === snapshot.snapshotId) {
    if (previousUniverse.lastSnapshotFingerprint !== fingerprint) throw new TypeError("A snapshotId cannot be reused with different content");
    return result(state, snapshot.universeId, previousUniverse.coverageComplete, [], true);
  }

  const events: OpportunityLifecycleEvent[] = [];
  const candidateLimitExceeded = snapshot.candidates.length > policy.maxCandidatesPerSnapshot;
  const normalized = candidateLimitExceeded ? [] : normalizeCandidates(snapshot.candidates, snapshot.universeId);
  const conflictingKeys = new Set(normalized.filter((row) => row.conflict).map((row) => row.routeKey));
  const coverageComplete = snapshot.coverage.complete && !snapshot.coverage.stale && !snapshot.coverage.truncated && snapshot.coverage.failedSources.length === 0 && !candidateLimitExceeded && conflictingKeys.size === 0;
  const coverageReason: OpportunityLifecycleReason = candidateLimitExceeded ? "route-capacity-reached" : conflictingKeys.size ? "duplicate-route-conflict" : coverageComplete ? "universe-restored" : "universe-incomplete";
  const policyChanged = previousUniverse !== undefined && previousUniverse.lastPolicyId !== snapshot.policyId;

  if (policyChanged) {
    appendEvent(state, events, {
      type: "universe",
      universeId: snapshot.universeId,
      policyId: snapshot.policyId,
      reason: "policy-changed",
      effectiveAt: snapshot.evaluatedAt,
      evaluatedAt: snapshot.evaluatedAt
    });
  }
  if (!previousUniverse || previousUniverse.coverageComplete !== coverageComplete || coverageReason === "duplicate-route-conflict" || candidateLimitExceeded) {
    appendEvent(state, events, {
      type: "universe",
      universeId: snapshot.universeId,
      policyId: snapshot.policyId,
      reason: coverageReason,
      effectiveAt: snapshot.evaluatedAt,
      evaluatedAt: snapshot.evaluatedAt
    });
  }
  state.universes[snapshot.universeId] = {
    universeId: snapshot.universeId,
    lastPolicyId: snapshot.policyId,
    lastSnapshotId: snapshot.snapshotId,
    lastSnapshotFingerprint: fingerprint,
    lastEvaluatedAt: snapshot.evaluatedAt,
    coverageComplete,
    lastCoverageReason: coverageReason
  };
  for (const route of Object.values(state.routes)) if (route.universeId === snapshot.universeId) route.policyId = snapshot.policyId;

  const observations = new Map<string, AssessedCandidate>();
  if (!candidateLimitExceeded) {
    for (const row of normalized) {
      if (row.conflict) continue;
      observations.set(row.routeKey, assessCandidate(row.candidate, row.routeKey, snapshot.evaluatedAt, policy));
    }
  }
  const keys = new Set<string>([...universeRouteKeys(state, snapshot.universeId), ...observations.keys(), ...conflictingKeys]);
  const normalizedByKey = new Map(normalized.map((row) => [row.routeKey, row]));
  const capacity = { routeCount: Object.keys(state.routes).length };
  for (const key of [...keys].sort()) {
    const observation = observations.get(key);
    let route: OpportunityLifecycleRoute | undefined = state.routes[key];
    if (policyChanged && route && route.status !== "expired" && route.status !== "decaying") startDecay(state, events, route, "policy-changed", snapshot.evaluatedAt, snapshot.evaluatedAt);
    if (conflictingKeys.has(key)) {
      if (route) route.actionable = false;
      appendRejected(state, events, snapshot, route, normalizedByKey.get(key)?.candidate, "duplicate-route-conflict");
      if (route) ageOrDecayRoute(state, events, route, snapshot.evaluatedAt, policy, false, "duplicate-route-conflict");
      continue;
    }
    if (observation) route = reduceObservedRoute(state, events, route, observation, snapshot, policy, coverageComplete, capacity);
    else if (route) reduceAbsentRoute(state, events, route, snapshot.evaluatedAt, policy, coverageComplete);
    if (route) expireIfDue(state, events, route, snapshot.evaluatedAt, policy);
  }
  state.history = [...state.history, ...events].slice(-policy.maxEvents);
  return result(state, snapshot.universeId, coverageComplete, events, false);
}

function reduceObservedRoute(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], existing: OpportunityLifecycleRoute | undefined, assessment: AssessedCandidate, snapshot: OpportunityLifecycleSnapshot, policy: OpportunityLifecyclePolicy, coverageComplete: boolean, capacity: { routeCount: number }) {
  const { candidate } = assessment;
  if (assessment.future) {
    if (existing) existing.actionable = false;
    appendRejected(state, events, snapshot, existing, candidate, "observation-future");
    if (existing) ageOrDecayRoute(state, events, existing, snapshot.evaluatedAt, policy, false, "observation-future");
    return existing;
  }
  if (!existing && capacity.routeCount >= policy.maxRoutes) {
    appendRejected(state, events, snapshot, undefined, candidate, "route-capacity-reached");
    return undefined;
  }
  let route = existing ?? createRoute(assessment, snapshot.evaluatedAt, snapshot.policyId);
  if (!existing) {
    state.routes[route.key] = route;
    capacity.routeCount += 1;
    transition(state, events, route, undefined, "first-seen", "candidate-observed", Math.min(assessment.oldestObservedAt, snapshot.evaluatedAt), snapshot.evaluatedAt, candidate.observationId);
  }
  const replayed = route.recentObservationIds.includes(candidate.observationId);
  const outOfOrder = existing !== undefined && assessment.oldestObservedAt <= route.lastObservationAt;
  if (replayed || outOfOrder) {
    const reason: OpportunityLifecycleReason = replayed ? "observation-replayed" : "observation-out-of-order";
    appendRejected(state, events, snapshot, route, candidate, reason);
    route.actionable = replayed && coverageComplete && route.status === "confirmed" && storedEvidenceQualified(route, snapshot.evaluatedAt, policy) && route.score >= policy.exitScore;
    ageOrDecayRoute(state, events, route, snapshot.evaluatedAt, policy, true, reason);
    return route;
  }

  updateEvidence(route, assessment, snapshot.evaluatedAt, policy.maxRecentObservationIds);
  route.actionable = false;
  if (!coverageComplete) {
    route.lastReason = "universe-incomplete";
    ageOrDecayRoute(state, events, route, snapshot.evaluatedAt, policy, true, "universe-incomplete");
    return route;
  }
  const evidenceReason = evidenceFailureReason(assessment, policy);
  if (evidenceReason) {
    const effectiveAt = evidenceReason === "evidence-stale" ? assessment.oldestObservedAt + policy.observationFreshForMs : snapshot.evaluatedAt;
    startDecay(state, events, route, evidenceReason, effectiveAt, snapshot.evaluatedAt, candidate.observationId);
    return route;
  }
  if (route.status === "confirmed") {
    if (candidate.score < policy.exitScore) startDecay(state, events, route, "score-below-exit", snapshot.evaluatedAt, snapshot.evaluatedAt, candidate.observationId);
    else {
      route.actionable = true;
      route.lastReason = "confirmation-complete";
    }
    return route;
  }
  if (candidate.score < policy.enterScore) {
    startDecay(state, events, route, "score-below-entry", snapshot.evaluatedAt, snapshot.evaluatedAt, candidate.observationId);
    return route;
  }
  if (route.status === "decaying" || route.status === "expired") {
    transition(state, events, route, route.status, "first-seen", "candidate-observed", snapshot.evaluatedAt, snapshot.evaluatedAt, candidate.observationId);
    route.firstSeenAt = snapshot.evaluatedAt;
    route.confirmationCount = 0;
    route.confirmationStartedAt = undefined;
    route.confirmedAt = undefined;
    route.decayStartedAt = undefined;
    route.expiredAt = undefined;
  }
  route.confirmationStartedAt ??= snapshot.evaluatedAt;
  route.confirmationCount += 1;
  if (route.confirmationCount >= policy.confirmationObservations && snapshot.evaluatedAt - route.confirmationStartedAt >= policy.confirmationMinDurationMs) {
    transition(state, events, route, route.status, "confirmed", "confirmation-complete", snapshot.evaluatedAt, snapshot.evaluatedAt, candidate.observationId);
    route.confirmedAt = snapshot.evaluatedAt;
    route.actionable = true;
  }
  return route;
}

function reduceAbsentRoute(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], route: OpportunityLifecycleRoute, evaluatedAt: number, policy: OpportunityLifecyclePolicy, coverageComplete: boolean) {
  route.actionable = false;
  route.effectiveEvidenceQuality = effectiveQuality(route.rawEvidenceQuality, Math.max(0, evaluatedAt - route.lastObservationAt), policy.observationFreshForMs);
  if (route.status === "expired") return;
  if (coverageComplete) startDecay(state, events, route, "route-absent", evaluatedAt, evaluatedAt);
  else ageOrDecayRoute(state, events, route, evaluatedAt, policy, false, "universe-incomplete");
}

function ageOrDecayRoute(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], route: OpportunityLifecycleRoute, evaluatedAt: number, policy: OpportunityLifecyclePolicy, observedInSnapshot: boolean, fallbackReason: OpportunityLifecycleReason) {
  route.effectiveEvidenceQuality = effectiveQuality(route.rawEvidenceQuality, Math.max(0, evaluatedAt - route.lastObservationAt), policy.observationFreshForMs);
  if (route.status === "expired" || route.status === "decaying") return;
  const staleAt = route.lastObservationAt + policy.observationFreshForMs;
  if (evaluatedAt > staleAt) startDecay(state, events, route, "evidence-stale", staleAt, evaluatedAt);
  else if (!observedInSnapshot) route.lastReason = fallbackReason;
}

function expireIfDue(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], route: OpportunityLifecycleRoute, evaluatedAt: number, policy: OpportunityLifecyclePolicy) {
  if (route.status !== "decaying" || route.decayStartedAt === undefined) return;
  const expiresAt = route.decayStartedAt + policy.decayGraceMs;
  if (evaluatedAt < expiresAt) return;
  transition(state, events, route, "decaying", "expired", "decay-grace-elapsed", expiresAt, evaluatedAt);
  route.expiredAt = expiresAt;
  route.actionable = false;
  route.confirmationCount = 0;
  route.confirmationStartedAt = undefined;
}

function startDecay(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], route: OpportunityLifecycleRoute, reason: OpportunityLifecycleReason, effectiveAt: number, evaluatedAt: number, observationId?: string) {
  route.actionable = false;
  route.lastReason = reason;
  if (route.status === "decaying" || route.status === "expired") return;
  transition(state, events, route, route.status, "decaying", reason, effectiveAt, evaluatedAt, observationId);
  route.decayStartedAt = effectiveAt;
  route.confirmationCount = 0;
  route.confirmationStartedAt = undefined;
}

function transition(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], route: OpportunityLifecycleRoute, from: OpportunityLifecycleStatus | undefined, to: OpportunityLifecycleStatus, reason: OpportunityLifecycleReason, effectiveAt: number, evaluatedAt: number, observationId?: string) {
  route.status = to;
  route.lastReason = reason;
  appendEvent(state, events, { type: "transition", universeId: route.universeId, policyId: route.policyId, kind: route.kind, routeId: route.routeId, from, to, reason, effectiveAt, evaluatedAt, observationId });
}

function createRoute(assessment: AssessedCandidate, evaluatedAt: number, policyId: string): OpportunityLifecycleRoute {
  const { candidate } = assessment;
  return {
    key: assessment.routeKey,
    universeId: routeUniverse(assessment.routeKey),
    policyId,
    kind: candidate.kind,
    routeId: candidate.routeId,
    status: "first-seen",
    actionable: false,
    firstSeenAt: Math.min(assessment.oldestObservedAt, evaluatedAt),
    lastSeenAt: evaluatedAt,
    lastObservationAt: assessment.oldestObservedAt,
    lastObservationId: candidate.observationId,
    recentObservationIds: [],
    score: candidate.score,
    rawEvidenceQuality: assessment.rawQuality,
    effectiveEvidenceQuality: assessment.effectiveQuality,
    evidenceSourceIds: assessment.sourceIds,
    evidenceComplete: assessment.complete,
    confirmationCount: 0,
    lastReason: "candidate-observed"
  };
}

function updateEvidence(route: OpportunityLifecycleRoute, assessment: AssessedCandidate, evaluatedAt: number, observationLimit: number) {
  route.lastSeenAt = evaluatedAt;
  route.lastObservationAt = assessment.oldestObservedAt;
  route.lastObservationId = assessment.candidate.observationId;
  route.recentObservationIds = [...route.recentObservationIds, assessment.candidate.observationId].slice(-observationLimit);
  route.score = assessment.candidate.score;
  route.rawEvidenceQuality = assessment.rawQuality;
  route.effectiveEvidenceQuality = assessment.effectiveQuality;
  route.evidenceSourceIds = assessment.sourceIds;
  route.evidenceComplete = assessment.complete;
}

function evidenceFailureReason(assessment: AssessedCandidate, policy: OpportunityLifecyclePolicy): OpportunityLifecycleReason | undefined {
  if (!assessment.complete) return "evidence-incomplete";
  if (assessment.stale) return "evidence-stale";
  if (qualityRank(assessment.effectiveQuality) < qualityRank(policy.minimumEvidenceQuality)) return "evidence-quality";
  return undefined;
}

function storedEvidenceQualified(route: OpportunityLifecycleRoute, evaluatedAt: number, policy: OpportunityLifecyclePolicy) {
  const quality = effectiveQuality(route.rawEvidenceQuality, Math.max(0, evaluatedAt - route.lastObservationAt), policy.observationFreshForMs);
  return route.evidenceComplete && evaluatedAt - route.lastObservationAt <= policy.observationFreshForMs && qualityRank(quality) >= qualityRank(policy.minimumEvidenceQuality);
}

function assessCandidate(candidate: OpportunityLifecycleCandidate, candidateRouteKey: string, evaluatedAt: number, policy: OpportunityLifecyclePolicy): AssessedCandidate {
  const sourceIds = candidate.evidence.map(({ sourceId }) => sourceId).sort();
  const oldestObservedAt = Math.min(...candidate.evidence.map(({ observedAt }) => observedAt));
  const ageMs = evaluatedAt - oldestObservedAt;
  const rawQuality = worstQuality(candidate.evidence.map(({ quality }) => quality));
  return {
    candidate,
    routeKey: candidateRouteKey,
    oldestObservedAt,
    rawQuality,
    effectiveQuality: effectiveQuality(rawQuality, Math.max(0, ageMs), policy.observationFreshForMs),
    complete: candidate.evidence.length >= policy.minimumEvidenceSources && candidate.evidence.every(({ complete }) => complete),
    stale: ageMs > policy.observationFreshForMs,
    future: ageMs < -policy.maxFutureSkewMs,
    sourceIds
  };
}

function normalizeCandidates(candidates: readonly OpportunityLifecycleCandidate[], universeId: string) {
  const grouped = new Map<string, Array<{ candidate: OpportunityLifecycleCandidate; canonical: string }>>();
  for (const candidate of candidates) {
    const key = routeKey(universeId, candidate.kind, candidate.routeId);
    const canonical = canonicalCandidate(candidate);
    const group = grouped.get(key) ?? [];
    group.push({ candidate, canonical });
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([localKey, rows]) => ({
      routeKey: localKey,
      candidate: rows.slice().sort((left, right) => left.canonical.localeCompare(right.canonical))[0]!.candidate,
      conflict: new Set(rows.map(({ canonical }) => canonical)).size > 1
    }));
}

function appendRejected(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], snapshot: OpportunityLifecycleSnapshot, route: OpportunityLifecycleRoute | undefined, candidate: OpportunityLifecycleCandidate | undefined, reason: OpportunityLifecycleReason) {
  appendEvent(state, events, {
    type: "evidence-rejected",
    universeId: snapshot.universeId,
    policyId: snapshot.policyId,
    kind: route?.kind ?? candidate?.kind,
    routeId: route?.routeId ?? candidate?.routeId,
    reason,
    effectiveAt: snapshot.evaluatedAt,
    evaluatedAt: snapshot.evaluatedAt,
    observationId: candidate?.observationId
  });
}

function appendEvent(state: OpportunityLifecycleState, events: OpportunityLifecycleEvent[], fields: EventFields) {
  const sequence = state.nextEventSequence;
  state.nextEventSequence += 1;
  events.push({ id: `opportunity-lifecycle:${sequence}`, sequence, ...fields });
}

function result(state: OpportunityLifecycleState, universeId: string, universeComplete: boolean, events: OpportunityLifecycleEvent[], idempotent: boolean): OpportunityLifecycleEvaluation {
  return {
    state,
    universeComplete,
    events,
    routes: universeRouteKeys(state, universeId)
      .map((key) => state.routes[key]!)
      .sort((left, right) => left.key.localeCompare(right.key)),
    idempotent
  };
}

function snapshotFingerprint(snapshot: OpportunityLifecycleSnapshot, resolvedPolicyFingerprint: string) {
  const normalized = {
    universeId: snapshot.universeId,
    policyId: snapshot.policyId,
    resolvedPolicyFingerprint,
    snapshotId: snapshot.snapshotId,
    evaluatedAt: snapshot.evaluatedAt,
    coverage: {
      complete: snapshot.coverage.complete,
      stale: snapshot.coverage.stale,
      truncated: snapshot.coverage.truncated,
      failedSources: [...snapshot.coverage.failedSources].sort()
    },
    candidates: snapshot.candidates.map(canonicalCandidate).sort()
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function canonicalCandidate(candidate: OpportunityLifecycleCandidate) {
  return JSON.stringify({
    kind: candidate.kind,
    routeId: candidate.routeId,
    observationId: candidate.observationId,
    score: candidate.score,
    evidence: [...candidate.evidence].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.observedAt - right.observedAt).map(({ sourceId, observedAt, quality, complete }) => ({ sourceId, observedAt, quality, complete }))
  });
}

function validateSnapshot(snapshot: OpportunityLifecycleSnapshot, policy: OpportunityLifecyclePolicy) {
  dictionaryIdentifier(snapshot.universeId, "universeId");
  dictionaryIdentifier(snapshot.policyId, "policyId");
  identifier(snapshot.snapshotId, "snapshotId");
  timestamp(snapshot.evaluatedAt, "evaluatedAt");
  if (!snapshot.coverage || typeof snapshot.coverage.complete !== "boolean" || typeof snapshot.coverage.stale !== "boolean" || typeof snapshot.coverage.truncated !== "boolean" || !Array.isArray(snapshot.coverage.failedSources)) throw new TypeError("coverage is invalid");
  const failed = new Set<string>();
  for (const source of snapshot.coverage.failedSources) {
    identifier(source, "failed source");
    if (failed.has(source)) throw new TypeError("failedSources must be unique");
    failed.add(source);
  }
  if (!Array.isArray(snapshot.candidates)) throw new TypeError("candidates must be an array");
  if (snapshot.candidates.length > ABSOLUTE_MAX_CANDIDATES) throw new TypeError(`candidates exceeds the absolute bound of ${ABSOLUTE_MAX_CANDIDATES}`);
  for (const candidate of snapshot.candidates) validateCandidate(candidate, policy);
}

function validateCandidate(candidate: OpportunityLifecycleCandidate, policy: OpportunityLifecyclePolicy) {
  if (!(["basis", "triangular", "native-spread", "pairwise"] as const).includes(candidate.kind)) throw new TypeError("candidate kind is invalid");
  identifier(candidate.routeId, "routeId");
  identifier(candidate.observationId, "observationId");
  if (!Number.isFinite(candidate.score)) throw new TypeError("candidate score must be finite");
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > policy.maxEvidenceSourcesPerCandidate) throw new TypeError("candidate evidence count is outside policy bounds");
  const sources = new Set<string>();
  for (const evidence of candidate.evidence) {
    identifier(evidence.sourceId, "evidence sourceId");
    timestamp(evidence.observedAt, "evidence observedAt");
    qualityRank(evidence.quality);
    if (typeof evidence.complete !== "boolean") throw new TypeError("evidence complete must be boolean");
    if (sources.has(evidence.sourceId)) throw new TypeError("candidate evidence sourceIds must be unique");
    sources.add(evidence.sourceId);
  }
}

function assertState(state: OpportunityLifecycleState) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.nextEventSequence) || state.nextEventSequence < 1 || !state.policies || !state.universes || !state.routes || !Array.isArray(state.history)) throw new TypeError("Invalid opportunity lifecycle state");
}

function cloneState(state: OpportunityLifecycleState): OpportunityLifecycleState {
  return {
    schemaVersion: 1,
    nextEventSequence: state.nextEventSequence,
    policies: { ...state.policies },
    universes: Object.fromEntries(Object.entries(state.universes).map(([key, value]) => [key, { ...value }])),
    routes: Object.fromEntries(Object.entries(state.routes).map(([key, value]) => [key, { ...value, recentObservationIds: [...value.recentObservationIds], evidenceSourceIds: [...value.evidenceSourceIds] }])),
    history: state.history.map((event) => ({ ...event }))
  };
}

function pruneExpiredRoutes(state: OpportunityLifecycleState, evaluatedAt: number, retentionMs: number) {
  for (const [key, route] of Object.entries(state.routes)) if (route.status === "expired" && route.expiredAt !== undefined && evaluatedAt - route.expiredAt > retentionMs) delete state.routes[key];
}

function universeRouteKeys(state: OpportunityLifecycleState, universeId: string) {
  return Object.keys(state.routes).filter((key) => state.routes[key]?.universeId === universeId);
}

function routeKey(universeId: string, kind: OpportunityLifecycleKind, routeId: string) {
  return `${universeId}\u001f${kind}\u001f${routeId}`;
}

function routeUniverse(key: string) {
  return key.split("\u001f", 1)[0] ?? "";
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]{0,255}$/.test(value)) throw new TypeError(`${name} is invalid`);
}

function dictionaryIdentifier(value: unknown, name: string) {
  identifier(value, name);
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(Object.prototype, value)) throw new TypeError(`${name} is reserved`);
}

function policyFingerprint(policy: OpportunityLifecyclePolicy) {
  const canonical = {
    enterScore: policy.enterScore,
    exitScore: policy.exitScore,
    confirmationObservations: policy.confirmationObservations,
    confirmationMinDurationMs: policy.confirmationMinDurationMs,
    minimumEvidenceQuality: policy.minimumEvidenceQuality,
    minimumEvidenceSources: policy.minimumEvidenceSources,
    observationFreshForMs: policy.observationFreshForMs,
    decayGraceMs: policy.decayGraceMs,
    maxFutureSkewMs: policy.maxFutureSkewMs,
    expiredRetentionMs: policy.expiredRetentionMs,
    maxRoutes: policy.maxRoutes,
    maxEvents: policy.maxEvents,
    maxCandidatesPerSnapshot: policy.maxCandidatesPerSnapshot,
    maxEvidenceSourcesPerCandidate: policy.maxEvidenceSourcesPerCandidate,
    maxRecentObservationIds: policy.maxRecentObservationIds
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const ABSOLUTE_MAX_CANDIDATES = 100_000;
const ABSOLUTE_MAX_POLICY_VERSIONS = 1_024;
const ABSOLUTE_MAX_UNIVERSES = 256;

function timestamp(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}
