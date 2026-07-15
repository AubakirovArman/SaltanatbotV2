import { createHash } from "node:crypto";
import type { ArbitrageIdentityCoverage, ArbitrageOpportunity, ArbitrageScanResponse, ArbitrageSourceStatus } from "../types.js";
import type { OpportunityEvidenceQuality, OpportunityLifecycleCandidate, OpportunityLifecycleSnapshot, OpportunityUniverseCoverage } from "./types.js";

export const BASIS_LIFECYCLE_UNIVERSE_ID = "basis:binance-bybit:spot-perpetual:v1";
export const BASIS_LIFECYCLE_POLICY_ID = "basis-stream-policy:v1";

const EXPECTED_BASIS_SOURCES = ["binance:spot", "binance:perpetual", "bybit:spot", "bybit:perpetual"] as const;

export interface BasisLifecycleAdapterOptions {
  universeId?: string;
  policyId?: string;
  expectedSources?: readonly string[];
}

/** Provenance supplied by the scanner only after every identity source was checked. */
export type BasisIdentityCoverageProof = ArbitrageIdentityCoverage;

export type BasisLifecycleScan = ArbitrageScanResponse & { identityCoverage?: BasisIdentityCoverageProof };

/** Maps the unpaginated internal basis scan to deterministic lifecycle evidence. */
export function basisScanToLifecycleSnapshot(scan: BasisLifecycleScan, options: BasisLifecycleAdapterOptions = {}): OpportunityLifecycleSnapshot {
  const evaluatedAt = requiredTimestamp(scan.updatedAt, "basis scan updatedAt");
  const expectedSources = [...new Set(options.expectedSources ?? EXPECTED_BASIS_SOURCES)].sort();
  const { coverage: initialCoverage, invalidOpportunityIds } = basisCoverage(scan, expectedSources);
  const candidates: OpportunityLifecycleCandidate[] = [];
  for (const opportunity of [...scan.opportunities].sort((left, right) => left.id.localeCompare(right.id))) {
    try {
      candidates.push(basisOpportunityCandidate(opportunity));
    } catch {
      invalidOpportunityIds.push(`invalid-opportunity:${digest(opportunity.id).slice(0, 16)}`);
    }
  }
  const coverage: OpportunityUniverseCoverage = {
    ...initialCoverage,
    complete: initialCoverage.complete && invalidOpportunityIds.length === 0,
    failedSources: [...new Set([...initialCoverage.failedSources, ...invalidOpportunityIds])].sort()
  };
  const universeId = options.universeId ?? BASIS_LIFECYCLE_UNIVERSE_ID;
  const policyId = options.policyId ?? BASIS_LIFECYCLE_POLICY_ID;
  const snapshotBody = { universeId, policyId, evaluatedAt, coverage, candidates };
  return { ...snapshotBody, snapshotId: `basis:${evaluatedAt}:${digest(snapshotBody).slice(0, 24)}` };
}

export function basisOpportunityCandidate(opportunity: ArbitrageOpportunity): OpportunityLifecycleCandidate {
  const spotObservedAt = requiredTimestamp(opportunity.spotReceivedAt, "spot receivedAt");
  const futuresObservedAt = requiredTimestamp(opportunity.futuresReceivedAt, "futures receivedAt");
  const structurallyComplete = validPositive(opportunity.spotAsk) && validPositive(opportunity.spotAskSize) && validPositive(opportunity.futuresBid) && validPositive(opportunity.futuresBidSize);
  if (!opportunity.id || !Number.isFinite(opportunity.netEdgeBps)) throw new TypeError("basis opportunity identity or score is invalid");
  const quality = basisQuality(opportunity);
  const observation = {
    routeId: opportunity.id,
    spotInstrumentId: opportunity.spotInstrumentId,
    futuresInstrumentId: opportunity.futuresInstrumentId,
    spotObservedAt,
    futuresObservedAt,
    spotAsk: opportunity.spotAsk,
    spotAskSize: opportunity.spotAskSize,
    futuresBid: opportunity.futuresBid,
    futuresBidSize: opportunity.futuresBidSize,
    fundingRate: opportunity.fundingRate
  };
  return {
    kind: "basis",
    routeId: opportunity.id,
    observationId: `basis-observation:${digest(observation).slice(0, 32)}`,
    score: opportunity.netEdgeBps,
    evidence: [
      {
        sourceId: `${opportunity.spotExchange}:spot:${opportunity.spotInstrumentId}`,
        // Local receipt time is comparable across legs in this process. Raw cross-venue
        // exchange clocks are provenance only and are not treated as clock-corrected.
        observedAt: spotObservedAt,
        quality,
        complete: structurallyComplete && Boolean(opportunity.spotInstrumentId)
      },
      {
        sourceId: `${opportunity.futuresExchange}:perpetual:${opportunity.futuresInstrumentId}`,
        observedAt: futuresObservedAt,
        quality,
        complete: structurallyComplete && Boolean(opportunity.futuresInstrumentId)
      }
    ]
  };
}

function basisCoverage(scan: ArbitrageScanResponse, expectedSources: readonly string[]) {
  const sourceGroups = new Map<string, ArbitrageSourceStatus[]>();
  for (const source of scan.sources) {
    const key = `${source.exchange}:${source.market}`;
    const rows = sourceGroups.get(key) ?? [];
    rows.push(source);
    sourceGroups.set(key, rows);
  }
  const failedSources: string[] = [];
  for (const expected of expectedSources) {
    const statuses = sourceGroups.get(expected) ?? [];
    if (statuses.length === 0) failedSources.push(`missing:${expected}`);
    else if (statuses.length > 1) failedSources.push(`duplicate:${expected}`);
    else if (!statuses[0]!.ok) failedSources.push(expected);
  }
  for (const [key, statuses] of sourceGroups) if (statuses.some((status) => !status.ok) && !failedSources.includes(key)) failedSources.push(key);
  const identityCoverage = (scan as BasisLifecycleScan).identityCoverage;
  if (!identityCoverage) failedSources.push("identity-registry:coverage-unproven");
  else {
    for (const source of identityCoverage.failedSources) failedSources.push(`identity-registry:${source}`);
    if (!identityCoverage.complete && identityCoverage.failedSources.length === 0) failedSources.push("identity-registry:incomplete");
  }
  const truncated = scan.truncated || scan.totalOpportunities > scan.opportunities.length;
  const coverage: OpportunityUniverseCoverage = {
    complete: !scan.stale && !truncated && identityCoverage?.complete === true && failedSources.length === 0,
    stale: scan.stale || identityCoverage?.stale === true,
    truncated,
    failedSources: failedSources.sort()
  };
  return { coverage, invalidOpportunityIds: [] as string[] };
}

function basisQuality(opportunity: ArbitrageOpportunity): OpportunityEvidenceQuality {
  if (opportunity.dataQuality === "fresh" && opportunity.clockCorrection?.skewEligible && opportunity.clockCorrection.spot.quality === "verified" && opportunity.clockCorrection.futures.quality === "verified") return "verified";
  if (opportunity.dataQuality === "fresh") return "fresh";
  if (opportunity.dataQuality === "stale" || opportunity.dataQuality === "skewed") return "degraded";
  return "unverified";
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function requiredTimestamp(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function validPositive(value: number) {
  return Number.isFinite(value) && value > 0;
}
