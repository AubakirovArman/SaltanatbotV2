import { createHash } from "node:crypto";
import type { PairwiseOpportunity, PairwiseRejectionCode } from "../engines/pairwise/index.js";
import type { TriangularScanResponse } from "../engines/triangular/index.js";
import type { NativeSpreadOpportunity, NativeSpreadScan } from "../nativeSpreads/index.js";
import type { RouteFamilyEvaluationResponse } from "../routeFamilies/index.js";
import type { OpportunityEvidence, OpportunityLifecycleCandidate, OpportunityLifecycleSnapshot, OpportunityUniverseCoverage } from "./types.js";

export interface LifecycleAdapterIdentity {
  universeId: string;
  policyId: string;
}

/**
 * Current public triangular scans use unsequenced REST top-book rows. They are
 * retained as research lifecycle candidates but can never prove a complete universe.
 */
export function triangularScanToLifecycleSnapshot(scan: TriangularScanResponse, identity: LifecycleAdapterIdentity): OpportunityLifecycleSnapshot {
  const evaluatedAt = timestamp(scan.updatedAt, "triangular updatedAt");
  const candidates = [...scan.opportunities]
    .sort((left, right) => left.cycleId.localeCompare(right.cycleId))
    .map(
      (opportunity): OpportunityLifecycleCandidate => ({
        kind: "triangular",
        routeId: opportunity.cycleId,
        observationId: `triangular-observation:${digest({
          id: opportunity.id,
          legs: opportunity.legs.map((leg) => [leg.marketId, leg.receivedAt, leg.averagePrice, leg.outputQuantity])
        }).slice(0, 32)}`,
        score: finite(opportunity.netReturnBps, "triangular net return"),
        evidence: opportunity.legs.map(
          (leg): OpportunityEvidence => ({
            sourceId: leg.marketId,
            observedAt: timestamp(leg.receivedAt, "triangular leg receivedAt"),
            quality: opportunity.sequenceVerified && opportunity.marketDataMode === "sequence-verified-depth" ? "fresh" : "unverified",
            complete: leg.levelsUsed > 0 && leg.outputQuantity > 0
          })
        )
      })
    );
  // The response lacks proof that every graph market had a complete, sequence-
  // continuous book. Absence from this REST research page cannot expire a route.
  const coverage: OpportunityUniverseCoverage = {
    complete: false,
    stale: false,
    truncated: scan.truncated || scan.totalOpportunities > scan.opportunities.length,
    failedSources: ["triangular:rest-unsequenced-universe"]
  };
  return snapshot(identity, evaluatedAt, coverage, candidates, "triangular");
}

export function nativeSpreadScanToLifecycleSnapshot(scan: NativeSpreadScan, identity: LifecycleAdapterIdentity): OpportunityLifecycleSnapshot {
  const evaluatedAt = timestamp(scan.updatedAt, "native spread updatedAt");
  const failures = scan.sourceErrors.map((_, index) => `native-spread:source-error:${index + 1}`);
  if (scan.scannedInstruments !== scan.eligibleInstruments) failures.push("native-spread:partial-candidate-set");
  if (scan.healthyBooks !== scan.scannedInstruments) failures.push("native-spread:incomplete-books");
  const truncated = scan.truncated || scan.candidateTruncated || scan.totalOpportunities > scan.opportunities.length;
  const coverage: OpportunityUniverseCoverage = {
    complete: !truncated && failures.length === 0,
    stale: false,
    truncated,
    failedSources: failures
  };
  const candidates = [...scan.opportunities].sort((left, right) => left.id.localeCompare(right.id)).map(nativeSpreadCandidate);
  return snapshot(identity, evaluatedAt, coverage, candidates, "native-spread");
}

export function routeFamilyEvaluationToLifecycleSnapshot(response: RouteFamilyEvaluationResponse, identity: LifecycleAdapterIdentity): OpportunityLifecycleSnapshot {
  const evaluatedAt = timestamp(response.evaluatedAt, "route-family evaluatedAt");
  const failures: string[] = [];
  if (response.evaluatedRoutes !== response.candidates.length) failures.push("pairwise:unevaluated-candidates");
  if (response.rejectedInstruments.length > 0) failures.push("pairwise:rejected-instruments");
  for (const code of new Set(response.rejections.map((rejection) => rejection.code).filter(incompletePairwiseRejection))) failures.push(`pairwise:${code}`);
  const truncated = response.truncated || response.totalCompatibleCandidates > response.candidates.length;
  const coverage: OpportunityUniverseCoverage = {
    complete: !truncated && failures.length === 0,
    stale: false,
    truncated,
    failedSources: failures.sort()
  };
  const candidates = [...response.opportunities].sort((left, right) => left.routeId.localeCompare(right.routeId)).map(pairwiseOpportunityCandidate);
  return snapshot(identity, evaluatedAt, coverage, candidates, "pairwise");
}

export function pairwiseOpportunityCandidate(opportunity: PairwiseOpportunity): OpportunityLifecycleCandidate {
  const evidence = opportunity.provenance.books.map(
    (book): OpportunityEvidence => ({
      sourceId: `${book.source}:${book.sourceId}:${book.instrumentId}`,
      // Keep cross-venue exchange clocks as provenance. Local receipt time is the
      // only directly comparable age/order clock available to this coordinator.
      observedAt: timestamp(book.receivedAt, "pairwise book receivedAt"),
      quality: book.source === "websocket" && Number.isSafeInteger(book.sequence) && (book.sequence ?? 0) > 0 ? "fresh" : "unverified",
      complete: true
    })
  );
  return {
    kind: "pairwise",
    routeId: opportunity.routeId,
    observationId: `pairwise-observation:${digest({
      routeId: opportunity.routeId,
      books: opportunity.provenance.books,
      legs: opportunity.legs.map((leg) => [leg.instrumentId, leg.averagePrice, leg.baseEquivalentQuantity])
    }).slice(0, 32)}`,
    score: finite(opportunity.netReturnBps, "pairwise net return"),
    evidence
  };
}

function nativeSpreadCandidate(opportunity: NativeSpreadOpportunity): OpportunityLifecycleCandidate {
  const observedAt = timestamp(opportunity.receivedAt, "native spread receivedAt");
  const relativeWidth = opportunity.relativeBookWidthBps;
  // Higher lifecycle score remains better; tight books therefore use negative width.
  const score = relativeWidth === undefined ? -1_000_000_000 : -Math.abs(finite(relativeWidth, "native spread relative width"));
  return {
    kind: "native-spread",
    routeId: opportunity.id,
    observationId: `native-spread-observation:${digest({
      id: opportunity.id,
      sequence: opportunity.sequence,
      receivedAt: observedAt,
      bid: opportunity.bidPrice,
      ask: opportunity.askPrice,
      quantity: opportunity.executableQuantity
    }).slice(0, 32)}`,
    score,
    evidence: [
      {
        sourceId: `${opportunity.venue}:native-spread:${opportunity.symbol}`,
        observedAt,
        // A fresh snapshot sequence is not snapshot/delta continuity, so this is
        // fresh rather than verified.
        quality: "fresh",
        complete: Number.isSafeInteger(opportunity.sequence) && opportunity.sequence > 0 && opportunity.executableQuantity > 0
      }
    ]
  };
}

function incompletePairwiseRejection(code: PairwiseRejectionCode) {
  return (["unknown-instrument", "economic-identity-invalid", "economic-identity-mismatch", "invalid-route", "settlement-conversion-required", "missing-book", "invalid-book", "incomplete-book", "stale-book", "skewed-books", "missing-assumption", "stale-assumption"] as PairwiseRejectionCode[]).includes(code);
}

function snapshot(identity: LifecycleAdapterIdentity, evaluatedAt: number, coverage: OpportunityUniverseCoverage, candidates: OpportunityLifecycleCandidate[], prefix: string): OpportunityLifecycleSnapshot {
  const body = { ...identity, evaluatedAt, coverage, candidates };
  return { ...body, snapshotId: `${prefix}:${evaluatedAt}:${digest(body).slice(0, 24)}` };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function timestamp(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
