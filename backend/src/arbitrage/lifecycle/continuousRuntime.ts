import { createHash } from "node:crypto";
import type { ContinuousRouteDiscoverySnapshot } from "../upstream/publicFeeds/index.js";
import type { OpportunityLifecycleCoordinator } from "./coordinator.js";
import type { OpportunityLifecycleCandidate, OpportunityLifecyclePolicy, OpportunityLifecycleSnapshot } from "./types.js";

export const CONTINUOUS_ROUTE_LIFECYCLE_UNIVERSE_ID = "continuous-route-families:v1";
export const CONTINUOUS_ROUTE_LIFECYCLE_POLICY_ID = "continuous-route-families:policy-v1";
export const CONTINUOUS_ROUTE_LIFECYCLE_POLICY_V1: Readonly<Partial<OpportunityLifecyclePolicy>> = Object.freeze({
  enterScore: 0,
  exitScore: -5,
  confirmationObservations: 2,
  confirmationMinDurationMs: 250,
  minimumEvidenceQuality: "fresh",
  minimumEvidenceSources: 2,
  observationFreshForMs: 10_000,
  decayGraceMs: 10_000,
  maxFutureSkewMs: 1_000,
  expiredRetentionMs: 60_000,
  maxRoutes: 500,
  maxEvents: 5_000,
  maxCandidatesPerSnapshot: 500,
  maxEvidenceSourcesPerCandidate: 2
});

export interface ContinuousLifecycleSource {
  subscribe(listener: (snapshot: ContinuousRouteDiscoverySnapshot) => void): { close(): void };
  snapshot(): ContinuousRouteDiscoverySnapshot;
}

/**
 * Adapts bounded market-only economics into lifecycle observations. Strategy
 * evidence is intentionally incomplete, so no continuous route can become
 * actionable merely because two public top books are fresh.
 */
export function continuousRouteDiscoveryToLifecycleSnapshot(discovery: ContinuousRouteDiscoverySnapshot): OpportunityLifecycleSnapshot {
  const evaluatedAt = timestamp(discovery.capturedAt, "continuous discovery capturedAt");
  const topBooks = new Map(discovery.topBooks.map((book) => [book.instrumentId, book]));
  const marketEvaluations = new Map(discovery.marketEvaluations.map((value) => [value.routeId, value]));
  const failures = new Set<string>();
  let stale = !discovery.runtimeCoverage.current;
  if (!discovery.runtimeCoverage.complete) failures.add(`continuous-runtime:${discovery.runtimeCoverage.reason}`);
  for (const source of discovery.sources) {
    if (source.status.state === "live") continue;
    failures.add(`${source.instrument.instrumentId}:feed-not-live:${source.status.state}`);
    stale = true;
  }
  for (const excluded of discovery.excludedBooks) failures.add(`${excluded.instrumentId}:excluded-book`);
  for (const rejected of discovery.rejectedInstruments) failures.add(`${rejected.instrumentId ?? "unknown"}:rejected-instrument`);

  const candidates: OpportunityLifecycleCandidate[] = [];
  for (const candidate of [...discovery.candidates].sort((left, right) => left.routeId.localeCompare(right.routeId))) {
    const marketEvaluation = marketEvaluations.get(candidate.routeId);
    if (!marketEvaluation) {
      failures.add(`${candidate.routeId}:missing-market-evaluation`);
      continue;
    }
    for (const blocked of marketEvaluation.blockedReasons) {
      failures.add(`${candidate.routeId}:${blocked.code}${blocked.subject ? `:${blocked.subject}` : ""}`);
      if (blocked.stage === "market-data" && STALE_MARKET_BLOCK_CODES.has(blocked.code)) stale = true;
    }
    // Market-data failures are coverage failures, not synthetic low-score routes.
    // Skipping them preserves valid rows and prevents one zero-evidence row from
    // making the lifecycle reducer reject the entire snapshot.
    if (marketEvaluation.status !== "market-only" || marketEvaluation.blockedReasons.some(({ stage }) => stage === "market-data")) continue;
    const long = topBooks.get(candidate.longInstrumentId);
    const short = topBooks.get(candidate.shortInstrumentId);
    if (!long) failures.add(`${candidate.longInstrumentId}:missing-top-book`);
    if (!short) failures.add(`${candidate.shortInstrumentId}:missing-top-book`);
    const books = [long, short].filter((book): book is NonNullable<typeof book> => Boolean(book));
    if (books.length !== 2) {
      failures.add(`${candidate.routeId}:insufficient-market-evidence`);
      continue;
    }
    const score = marketEvaluation.edges.netEntryBasisAfterEstimatedFeesBps;
    candidates.push({
      kind: "pairwise",
      routeId: candidate.routeId,
      observationId: `continuous-route-observation:${digest({
        routeId: candidate.routeId,
        marketEvaluation: [score, marketEvaluation.capacity.matchedBaseQuantity],
        books: books.map((book) => [book.instrumentId, book.receivedAt, book.bid, book.ask, book.continuity])
      }).slice(0, 32)}`,
      score: finite(score, "continuous route score"),
      evidence: books.map((book) => ({
        sourceId: `${book.venue}:public-websocket:${book.instrumentId}:${book.continuity.kind}`,
        observedAt: timestamp(book.receivedAt, "continuous top book receivedAt"),
        quality: book.continuity.kind === "sequence-verified" || book.continuity.kind === "checksum-verified" ? "fresh" : "unverified",
        // Fresh public books prove a market signal, never capital, inventory,
        // borrow, margin, funding horizon or delivery feasibility.
        complete: false
      }))
    });
  }
  const truncated = discovery.truncated || discovery.marketEconomics.truncated || discovery.totalCompatibleCandidates > discovery.candidates.length;
  const coverage = {
    complete: discovery.runtimeCoverage.complete && !truncated && failures.size === 0,
    stale,
    truncated,
    failedSources: [...failures].map(boundedFailureSourceId).sort()
  };
  const body = {
    universeId: CONTINUOUS_ROUTE_LIFECYCLE_UNIVERSE_ID,
    policyId: CONTINUOUS_ROUTE_LIFECYCLE_POLICY_ID,
    evaluatedAt,
    coverage,
    candidates
  };
  return { ...body, snapshotId: `continuous-route:${evaluatedAt}:${digest(body).slice(0, 24)}` };
}

const STALE_MARKET_BLOCK_CODES = new Set([
  "stale-top-book",
  "future-top-book",
  "generation-mismatch",
  "feed-not-live",
  "unverified-continuity",
  "skewed-top-books",
  "clock-unavailable",
  "clock-not-calibrated",
  "timestamp-definitely-future",
  "timestamp-may-be-future",
  "timestamp-stale",
  "clock-skew-exceeded"
]);

/** Subscribe-before-current closes the startup race; duplicate snapshots are reducer-idempotent. */
export function attachContinuousRouteOpportunityLifecycle(source: ContinuousLifecycleSource, coordinator: OpportunityLifecycleCoordinator, policy: Partial<OpportunityLifecyclePolicy> = CONTINUOUS_ROUTE_LIFECYCLE_POLICY_V1) {
  let lastSnapshotId: string | undefined;
  const consume = (discovery: ContinuousRouteDiscoverySnapshot) => {
    let snapshot: OpportunityLifecycleSnapshot;
    try {
      snapshot = continuousRouteDiscoveryToLifecycleSnapshot(discovery);
    } catch (error) {
      coordinator.recordRejectedSnapshot(discovery.capturedAt, error);
      return;
    }
    if (snapshot.snapshotId === lastSnapshotId) return;
    try {
      coordinator.ingestRuntime(snapshot, policy);
      lastSnapshotId = snapshot.snapshotId;
    } catch {
      // Reducer failures are already recorded transactionally by the coordinator
      // and must not tear down public market-data feeds.
    }
  };
  const subscription = source.subscribe(consume);
  consume(source.snapshot());
  return () => subscription.close();
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const MAX_FAILURE_SOURCE_ID_LENGTH = 256;

function boundedFailureSourceId(value: string) {
  const normalized = value.replaceAll(/[^A-Za-z0-9:._/@#|+=>-]/g, "_");
  const identified = /^[A-Za-z0-9]/.test(normalized) ? normalized : `source:${normalized}`;
  if (identified.length <= MAX_FAILURE_SOURCE_ID_LENGTH) return identified;
  const marker = `:sha256-${digest(identified).slice(0, 16)}:`;
  const tail = identified.slice(-32);
  return `${identified.slice(0, MAX_FAILURE_SOURCE_ID_LENGTH - marker.length - tail.length)}${marker}${tail}`;
}

function timestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}
