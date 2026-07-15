import { convertAsset, evaluateRouteEconomics, validateEvidence } from "../economics/index.js";
import { researchAlertDedupKey, researchAlertSnapshotFingerprint } from "./canonical.js";
import { researchAlertLifecycleKind } from "./lifecycleAdapter.js";
import type { ResearchAlertAssessment, ResearchAlertCandidate, ResearchAlertEconomicLegIdentity, ResearchAlertEvaluationResult, ResearchAlertFamily, ResearchAlertOutboxIntent, ResearchAlertPersistedState, ResearchAlertPolicy, ResearchAlertQuality, ResearchAlertRejection, ResearchAlertSnapshot } from "./types.js";

const BPS = 10_000;
const MAX_SNAPSHOT_FINGERPRINTS = 1_000;
const QUALITY_RANK: Record<ResearchAlertQuality, number> = { unverified: 0, degraded: 1, fresh: 2, verified: 3 };

interface AssessedCandidate {
  assessment: ResearchAlertAssessment;
  candidate: ResearchAlertCandidate;
}

export function createResearchAlertState(): ResearchAlertPersistedState {
  return { version: 1, policies: [], pairs: {}, initializedPolicies: {}, snapshotFingerprints: {}, deliveries: [] };
}

/** Pure fail-closed candidate evaluation. It never returns an execution permission. */
export function assessResearchAlertCandidate(candidate: ResearchAlertCandidate, policy: ResearchAlertPolicy, now: number): ResearchAlertAssessment {
  const rejections: ResearchAlertRejection[] = [];
  const dedupKey = researchAlertDedupKey(candidate.economicIdentity);
  if (!policy.families.includes(candidate.family) || (policy.economicAssetIds.length > 0 && !policy.economicAssetIds.includes(candidate.economicIdentity.economicAssetId))) {
    reject(rejections, "policy-filter", "Candidate is outside the policy family or economic-asset scope");
  }
  validateIdentity(candidate, policy, now, rejections);
  validateLifecycle(candidate, policy, now, rejections);

  const economics = evaluateRouteEconomics(candidate.economicsRequest);
  validateEconomicInputUniqueness(candidate, rejections);
  if (!economics.eligible || economics.failures.length > 0) reject(rejections, "economics-ineligible", "Route economics or account-capital evidence is not eligible");
  if (candidate.economicsRequest.routeId !== candidate.routeId || candidate.economicsRequest.evaluatedAt > now + candidate.economicsRequest.maximumFutureClockSkewMs || now - candidate.economicsRequest.evaluatedAt > policy.maximumEconomicsAgeMs) {
    reject(rejections, "economics-stale", "Route economics identity or evaluation time is outside policy");
  }
  if (validateEvidence(candidate.routeEvidence, now, policy.maximumEconomicsAgeMs, candidate.economicsRequest.maximumFutureClockSkewMs, now).length > 0) {
    reject(rejections, "route-evidence-invalid", "Gross-profit/capacity evidence is stale, future-dated or does not cover evaluation time");
  }

  const riskCapital = riskCapitalValuation(candidate, economics.requiredCapital, rejections);
  if (policy.maximumRiskCapitalValuation !== undefined && riskCapital > policy.maximumRiskCapitalValuation) {
    reject(rejections, "capital-threshold", "Required risk capital exceeds the policy maximum");
  }
  if (candidate.capacityValuation < policy.minimumCapacityValuation) reject(rejections, "capacity-threshold", "Account-constrained route capacity is below policy");
  const conservativeNetProfit = candidate.grossProfitValuation - economics.costs.totalConservative;
  const netEdgeBps = riskCapital > 0 ? (conservativeNetProfit / riskCapital) * BPS : Number.NEGATIVE_INFINITY;
  if (conservativeNetProfit < policy.minimumConservativeNetProfit) reject(rejections, "profit-threshold", "Conservative net profit is below policy");
  if (netEdgeBps < policy.minimumNetEdgeBps) reject(rejections, "edge-threshold", "Conservative net edge is below policy");

  return {
    policyId: policy.id,
    routeId: candidate.routeId,
    family: candidate.family,
    dedupKey,
    eligible: rejections.length === 0,
    conservativeNetProfit,
    netEdgeBps,
    riskCapitalValuation: riskCapital,
    economics,
    rejections
  };
}

/**
 * Transactional reducer over durable policy/cooldown state. The first snapshot
 * arms a policy without producing a startup notification, matching legacy alerts.
 */
export function evaluateResearchAlertSnapshot(previous: ResearchAlertPersistedState, snapshot: ResearchAlertSnapshot, now: number): { state: ResearchAlertPersistedState; result: ResearchAlertEvaluationResult } {
  const state = structuredClone(previous);
  validateState(state);
  validateSnapshot(snapshot, now);
  const fingerprint = researchAlertSnapshotFingerprint(snapshot);
  const retained = state.snapshotFingerprints[snapshot.snapshotId];
  if (retained) {
    if (retained.fingerprint !== fingerprint) throw new TypeError("Research alert snapshot identity was reused with different content");
    return { state, result: result(snapshot, completeCoverage(snapshot), [], [], [], true) };
  }
  if (state.lastEvaluatedAt !== undefined && snapshot.evaluatedAt < state.lastEvaluatedAt) throw new TypeError("Research alert snapshot is older than durable state");

  const coverageComplete = completeCoverage(snapshot);
  const allAssessments: ResearchAlertAssessment[] = [];
  const selected: ResearchAlertAssessment[] = [];
  const intents: ResearchAlertOutboxIntent[] = [];
  for (const policy of state.policies) {
    if (!policy.enabled) continue;
    const assessed = snapshot.candidates.map((candidate): AssessedCandidate => ({ assessment: assessResearchAlertCandidate(candidate, policy, now), candidate })).filter(({ assessment }) => !assessment.rejections.some((item) => item.code === "policy-filter"));
    allAssessments.push(...assessed.map(({ assessment }) => assessment));
    const groups = groupByDedupKey(assessed);
    const seen = new Set<string>();
    for (const [dedupKey, values] of groups) {
      seen.add(dedupKey);
      const winner = [...values].sort(compareAssessed)[0]!;
      selected.push(winner.assessment);
      const key = pairKey(policy.id, dedupKey);
      const prior = state.pairs[key];
      const observationId = winner.candidate.lifecycle.observationId;
      const crossed = state.initializedPolicies[policy.id] === true && !(prior?.eligible ?? false) && winner.assessment.eligible && prior?.lastObservationId !== observationId;
      const coolingDown = prior?.lastTriggeredAt !== undefined && now - prior.lastTriggeredAt < policy.cooldownSeconds * 1_000;
      const next = {
        policyId: policy.id,
        dedupKey,
        eligible: winner.assessment.eligible,
        updatedAt: now,
        lastObservationId: observationId,
        lastTriggeredAt: prior?.lastTriggeredAt,
        lastDeliveryId: prior?.lastDeliveryId
      };
      if (crossed && !coolingDown) {
        const intent = outboxIntent(policy, winner, now);
        intents.push(intent);
        next.lastTriggeredAt = now;
        policy.lastTriggeredAt = now;
        policy.updatedAt = now;
      }
      state.pairs[key] = next;
    }
    if (coverageComplete) {
      for (const [key, pair] of Object.entries(state.pairs)) {
        if (pair.policyId === policy.id && !seen.has(pair.dedupKey) && pair.eligible) state.pairs[key] = { ...pair, eligible: false, updatedAt: now };
      }
    }
    state.initializedPolicies[policy.id] = true;
  }
  state.snapshotFingerprints[snapshot.snapshotId] = { fingerprint, evaluatedAt: snapshot.evaluatedAt };
  state.lastEvaluatedAt = Math.max(state.lastEvaluatedAt ?? 0, snapshot.evaluatedAt);
  pruneFingerprints(state);
  prunePairs(state, now);
  return { state, result: result(snapshot, coverageComplete, allAssessments.sort(compareAssessment), selected.sort(compareAssessment), intents, false) };
}

function validateIdentity(candidate: ResearchAlertCandidate, policy: ResearchAlertPolicy, now: number, rejections: ResearchAlertRejection[]) {
  const identity = candidate.economicIdentity;
  const futureSkew = candidate.economicsRequest.maximumFutureClockSkewMs;
  if (identity.status !== "reviewed" || identity.validUntil < identity.asOf || identity.asOf > now + futureSkew || identity.validUntil < now) reject(rejections, "identity-invalid", "Reviewed economic identity is invalid, future-dated or expired");
  if (now - identity.asOf > policy.maximumIdentityAgeMs) reject(rejections, "identity-stale", "Economic identity review is older than policy");
  const unique = new Set(identity.legs.map(canonicalLeg));
  if (unique.size !== identity.legs.length) reject(rejections, "identity-invalid", "Economic identity contains duplicate legs");
  const economicsLegs = candidate.economicsRequest.legs.map(({ venue, instrumentId, marketType, side }) => ({ venue, instrumentId, marketType, side }));
  if (identity.legs.length !== economicsLegs.length || identity.legs.some((leg, index) => canonicalLeg(leg) !== canonicalLeg(economicsLegs[index]!))) {
    reject(rejections, "identity-mismatch", "Economic identity must preserve exact economics leg order, venue, instrument, market and side");
  }
}

function validateLifecycle(candidate: ResearchAlertCandidate, policy: ResearchAlertPolicy, now: number, rejections: ResearchAlertRejection[]) {
  const lifecycle = candidate.lifecycle;
  const expectedKind = researchAlertLifecycleKind(candidate.family);
  const uniqueSources = new Set(lifecycle.evidenceSourceIds);
  if (lifecycle.routeId !== candidate.routeId || lifecycle.kind !== expectedKind || lifecycle.status !== "confirmed" || lifecycle.actionable !== true || lifecycle.evidenceComplete !== true || uniqueSources.size !== lifecycle.evidenceSourceIds.length) {
    reject(rejections, "lifecycle-invalid", "Route lifecycle is not an exact, complete confirmed observation");
  }
  if (QUALITY_RANK[lifecycle.effectiveEvidenceQuality] < QUALITY_RANK[policy.minimumEvidenceQuality]) reject(rejections, "lifecycle-invalid", "Lifecycle evidence quality is below policy");
  if (lifecycle.lastObservationAt > now + candidate.economicsRequest.maximumFutureClockSkewMs || now - lifecycle.lastObservationAt > policy.maximumObservationAgeMs) {
    reject(rejections, "observation-stale", "Lifecycle observation is stale or future-dated");
  }
}

function validateEconomicInputUniqueness(candidate: ResearchAlertCandidate, rejections: ResearchAlertRejection[]) {
  const request = candidate.economicsRequest;
  if (hasDuplicate(request.capital ?? [], (row) => `${row.venue}\u0000${row.asset}`)) reject(rejections, "economics-ineligible", "Account capital evidence contains duplicate venue/asset rows");
  if (hasDuplicate(request.margin ?? [], (row) => `${row.venue}\u0000${row.instrumentId}`)) reject(rejections, "economics-ineligible", "Margin evidence contains duplicate venue/instrument rows");
  if (hasDuplicate(request.fxRates, (row) => `${row.baseAsset}\u0000${row.quoteAsset}`)) reject(rejections, "economics-ineligible", "FX evidence contains duplicate directed asset pairs");
  if (hasDuplicate(request.legs, (row) => row.legId)) reject(rejections, "economics-ineligible", "Economics legs contain duplicate legId values");
}

function riskCapitalValuation(candidate: ResearchAlertCandidate, required: readonly { asset: string; required: number }[], rejections: ResearchAlertRejection[]) {
  let total = 0;
  for (const row of required) {
    const converted = convertAsset(row.required, row.asset, candidate.economicsRequest.valuationAsset, candidate.economicsRequest.fxRates, "cost");
    if (converted === undefined || !Number.isFinite(converted)) {
      reject(rejections, "capital-unpriced", "Required capital has no conservative valuation FX rate");
      continue;
    }
    total += converted;
  }
  if (!(total > 0) || !Number.isFinite(total)) reject(rejections, "capital-unpriced", "Route has no positive, conservatively valued risk-capital requirement");
  return total;
}

function outboxIntent(policy: ResearchAlertPolicy, winner: AssessedCandidate, now: number): ResearchAlertOutboxIntent {
  const { assessment, candidate } = winner;
  const valuation = candidate.economicsRequest.valuationAsset;
  return {
    policyId: policy.id,
    dedupKey: assessment.dedupKey,
    routeId: candidate.routeId,
    family: candidate.family,
    economicAssetId: candidate.economicIdentity.economicAssetId,
    observationId: candidate.lifecycle.observationId,
    conservativeNetProfit: assessment.conservativeNetProfit,
    netEdgeBps: assessment.netEdgeBps,
    riskCapitalValuation: assessment.riskCapitalValuation,
    capacityValuation: candidate.capacityValuation,
    createdAt: now,
    researchOnly: true,
    executionPermission: false,
    payload: {
      event: "signal",
      bot: "Research arbitrage alert",
      symbol: candidate.economicIdentity.economicAssetId,
      text: `${candidate.family} · conservative net ${assessment.conservativeNetProfit.toFixed(2)} ${valuation} · edge ${(assessment.netEdgeBps / 100).toFixed(3)}% · notification only, no execution permission`
    }
  };
}

function groupByDedupKey(values: readonly AssessedCandidate[]) {
  const groups = new Map<string, AssessedCandidate[]>();
  for (const value of values) groups.set(value.assessment.dedupKey, [...(groups.get(value.assessment.dedupKey) ?? []), value]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function compareAssessed(left: AssessedCandidate, right: AssessedCandidate) {
  return (
    Number(right.assessment.eligible) - Number(left.assessment.eligible) ||
    right.assessment.netEdgeBps - left.assessment.netEdgeBps ||
    right.assessment.conservativeNetProfit - left.assessment.conservativeNetProfit ||
    QUALITY_RANK[right.candidate.lifecycle.effectiveEvidenceQuality] - QUALITY_RANK[left.candidate.lifecycle.effectiveEvidenceQuality] ||
    left.assessment.family.localeCompare(right.assessment.family) ||
    left.assessment.routeId.localeCompare(right.assessment.routeId)
  );
}

function compareAssessment(left: ResearchAlertAssessment, right: ResearchAlertAssessment) {
  return left.policyId.localeCompare(right.policyId) || left.dedupKey.localeCompare(right.dedupKey) || left.family.localeCompare(right.family) || left.routeId.localeCompare(right.routeId);
}

function completeCoverage(snapshot: ResearchAlertSnapshot) {
  return snapshot.coverage.complete && !snapshot.coverage.stale && !snapshot.coverage.truncated && snapshot.coverage.failedSources.length === 0;
}

function validateSnapshot(snapshot: ResearchAlertSnapshot, now: number) {
  if (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.evaluatedAt) || snapshot.evaluatedAt <= 0 || snapshot.evaluatedAt > now + 1_000) throw new TypeError("Research alert snapshot time or schema is invalid");
  const routeIds = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (routeIds.has(candidate.routeId)) throw new TypeError("Research alert snapshot contains duplicate routeId");
    routeIds.add(candidate.routeId);
  }
}

function validateState(state: ResearchAlertPersistedState) {
  if (state.version !== 1 || !Array.isArray(state.policies) || !Array.isArray(state.deliveries) || (state.lastEvaluatedAt !== undefined && (!Number.isSafeInteger(state.lastEvaluatedAt) || state.lastEvaluatedAt <= 0))) throw new TypeError("Research alert state is invalid");
}

function pruneFingerprints(state: ResearchAlertPersistedState) {
  const keep = Object.entries(state.snapshotFingerprints)
    .sort(([, left], [, right]) => right.evaluatedAt - left.evaluatedAt)
    .slice(0, MAX_SNAPSHOT_FINGERPRINTS);
  state.snapshotFingerprints = Object.fromEntries(keep);
}

function prunePairs(state: ResearchAlertPersistedState, now: number) {
  const policies = new Set(state.policies.map((policy) => policy.id));
  for (const [key, pair] of Object.entries(state.pairs)) if (!policies.has(pair.policyId) || (!pair.eligible && now - pair.updatedAt > 7 * 86_400_000)) delete state.pairs[key];
}

function canonicalLeg(leg: ResearchAlertEconomicLegIdentity) {
  return `${leg.venue}\u0000${leg.instrumentId}\u0000${leg.marketType}\u0000${leg.side}`;
}

function pairKey(policyId: string, dedupKey: string) {
  return `${policyId}\u001f${dedupKey}`;
}

function hasDuplicate<T>(values: readonly T[], key: (value: T) => string) {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) return true;
    seen.add(identity);
  }
  return false;
}

function reject(target: ResearchAlertRejection[], code: ResearchAlertRejection["code"], message: string) {
  if (!target.some((item) => item.code === code && item.message === message)) target.push({ code, message });
}

function result(snapshot: ResearchAlertSnapshot, coverageComplete: boolean, assessments: ResearchAlertAssessment[], selected: ResearchAlertAssessment[], intents: ResearchAlertOutboxIntent[], idempotent: boolean): ResearchAlertEvaluationResult {
  return { schemaVersion: 1, researchOnly: true, executionPermission: false, snapshotId: snapshot.snapshotId, idempotent, coverageComplete, assessments, selected, intents };
}
