import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { performance } from "node:perf_hooks";
import { validatePairwiseBook, type PairwiseBookSnapshot, type PairwiseInstrument, type PairwiseRejection } from "../../engines/pairwise/index.js";
import { discoverCompleteRouteFamilyCandidateUniverse, pairwiseInstrumentFromRegistry, type RouteFamilyCandidate } from "../../routeFamilies/index.js";
import type { PairwiseRegistryOverlay } from "../../routeFamilies/normalized.js";
import type { VenueClockAssessmentProvider } from "../../timing/index.js";
import type { ContinuousFeedListener, ContinuousPublicFeedHub } from "./hub.js";
import { evaluateContinuousMarketEconomics } from "./marketEconomics.js";
import type { ContinuousMarketEconomicsSummary, ContinuousMarketEvaluation } from "./marketEconomicsTypes.js";
import type { ContinuousFeedSnapshot, ContinuousFundingObservation, ContinuousPublicBook, ContinuousTopBook } from "./types.js";
import { continuousFeedInstrument } from "./types.js";

const HARD_MAX_SUBSCRIPTIONS = 24;
const HARD_MAX_PUBLISHED_CANDIDATES = 500;
const DEFAULT_EMIT_INTERVAL_MS = 1_000;
const URGENT_EMIT_INTERVAL_MS = 250;
const MIN_EMIT_INTERVAL_MS = 10;
const MAX_EMIT_INTERVAL_MS = 5_000;

export interface ContinuousDiscoveryInstrument {
  instrument: RegistryInstrument;
  overlay: PairwiseRegistryOverlay;
}

export type ContinuousDiscoveryRuntimeCoverageReason = "complete" | "configuration-disabled" | "configuration-invalid" | "refresh-pending" | "refresh-failed" | "partial-instruments";

/** Runtime authority mirrored into discovery so lifecycle consumers cannot mistake retained/empty data for complete coverage. */
export interface ContinuousDiscoveryRuntimeCoverage {
  complete: boolean;
  current: boolean;
  retainedPriorDiscovery: boolean;
  reason: ContinuousDiscoveryRuntimeCoverageReason;
}

export interface ContinuousRouteDiscoverySnapshot {
  engine: "continuous-route-discovery-v1";
  executionStatus: "research-only";
  executable: false;
  capturedAt: number;
  runtimeCoverage: ContinuousDiscoveryRuntimeCoverage;
  totalCompatibleCandidates: number;
  truncated: boolean;
  candidates: RouteFamilyCandidate[];
  marketEconomics: ContinuousMarketEconomicsSummary;
  marketEvaluations: ContinuousMarketEvaluation[];
  instruments: PairwiseInstrument[];
  routeReadyBooks: PairwiseBookSnapshot[];
  topBooks: ContinuousTopBook[];
  fundingObservations: ContinuousFundingObservation[];
  excludedBooks: Array<{ instrumentId: string; reason: string }>;
  rejectedInstruments: PairwiseRejection[];
  sources: ContinuousFeedSnapshot[];
}

export interface ContinuousRouteDiscoveryOptions {
  maxSubscriptions?: number;
  maxCandidates?: number;
  maxMarketEvaluations?: number;
  maxBookAgeMs?: number;
  maxLegSkewMs?: number;
  maxFutureClockSkewMs?: number;
  /**
   * Minimum interval between listener snapshots. Feed state itself is updated
   * immediately in the hub; this only coalesces expensive O(N^2) discovery and
   * lifecycle work onto a bounded macrotask cadence.
   */
  emitIntervalMs?: number;
  clockCalibration?: VenueClockAssessmentProvider;
  now?: () => number;
  /** Injectable monotonic clock used only for relative scheduling. */
  monotonicNow?: () => number;
}

/**
 * Live bridge into route-family candidate discovery. It intentionally stops before
 * evaluation: capital, inventory, borrow, convergence and full-horizon funding
 * assumptions remain explicit inputs to the existing research engine.
 */
export class ContinuousRouteFamilyDiscovery {
  private readonly listeners = new Set<(snapshot: ContinuousRouteDiscoverySnapshot) => void>();
  private readonly subscriptions: Array<{ close(): void }> = [];
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly maxSubscriptions: number;
  private readonly maxCandidates: number;
  private readonly maxMarketEvaluations: number;
  private readonly maxBookAgeMs: number;
  private readonly maxLegSkewMs: number;
  private readonly maxFutureClockSkewMs: number;
  private readonly emitIntervalMs: number;
  private readonly clockCalibration: VenueClockAssessmentProvider | undefined;
  private emitTimer?: NodeJS.Timeout;
  private emitTimerDueAt?: number;
  private lastEmittedAt?: number;
  private emitDirty = false;
  private configured: ContinuousDiscoveryInstrument[] = [];
  private configuredIds = new Set<string>();
  private runtimeCoverage: ContinuousDiscoveryRuntimeCoverage = {
    complete: true,
    current: true,
    retainedPriorDiscovery: false,
    reason: "complete"
  };

  constructor(
    private readonly hub: ContinuousPublicFeedHub,
    options: ContinuousRouteDiscoveryOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maxSubscriptions = bounded(options.maxSubscriptions ?? 24, 1, HARD_MAX_SUBSCRIPTIONS, "maxSubscriptions");
    this.maxCandidates = bounded(options.maxCandidates ?? 200, 1, 500, "maxCandidates");
    this.maxMarketEvaluations = bounded(options.maxMarketEvaluations ?? this.maxCandidates, 1, 500, "maxMarketEvaluations");
    this.maxBookAgeMs = bounded(options.maxBookAgeMs ?? 10_000, 1, 60_000, "maxBookAgeMs");
    this.maxLegSkewMs = bounded(options.maxLegSkewMs ?? 1_000, 0, 60_000, "maxLegSkewMs");
    this.maxFutureClockSkewMs = bounded(options.maxFutureClockSkewMs ?? 1_000, 0, 60_000, "maxFutureClockSkewMs");
    this.emitIntervalMs = bounded(options.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS, MIN_EMIT_INTERVAL_MS, MAX_EMIT_INTERVAL_MS, "emitIntervalMs");
    this.clockCalibration = options.clockCalibration;
  }

  configure(values: readonly ContinuousDiscoveryInstrument[]) {
    if (values.length > this.maxSubscriptions) throw new Error(`Continuous route discovery accepts at most ${this.maxSubscriptions} instruments`);
    const sorted = [...values].sort((left, right) => left.instrument.id.localeCompare(right.instrument.id));
    const ids = new Set<string>();
    for (const value of sorted) {
      if (ids.has(value.instrument.id)) throw new Error(`Duplicate continuous discovery instrument ${value.instrument.id}`);
      ids.add(value.instrument.id);
      if (!continuousFeedInstrument(value.instrument)) throw new Error(`Instrument ${value.instrument.id} is not supported by the continuous public feed`);
    }
    this.stopSubscriptions();
    this.configured = sorted.map((value) => ({ instrument: structuredClone(value.instrument), overlay: structuredClone(value.overlay) }));
    this.configuredIds = ids;
    const listener: ContinuousFeedListener = {
      // A public book callback is immediately followed by its top-book callback.
      // Both mark one pending rebuild, never two synchronous O(N^2) evaluations.
      onBook: () => this.scheduleEmit(false),
      onTopBook: () => this.scheduleEmit(false),
      onFunding: () => this.scheduleEmit(false),
      // Withdrawal of a generation and non-live states preempt the normal cadence,
      // but remain hard-rate-limited so a reconnect storm cannot starve HTTP I/O.
      onInvalidate: () => this.scheduleEmit(true),
      onStatus: (status) => this.scheduleEmit(status.state !== "live")
    };
    for (const value of this.configured) this.subscriptions.push(this.hub.subscribe(continuousFeedInstrument(value.instrument)!, listener));
    this.scheduleEmit(true);
  }

  setRuntimeCoverage(value: ContinuousDiscoveryRuntimeCoverage) {
    validateRuntimeCoverage(value);
    if (JSON.stringify(value) === JSON.stringify(this.runtimeCoverage)) return;
    this.runtimeCoverage = { ...value };
    this.scheduleEmit(true);
  }

  snapshot(): ContinuousRouteDiscoverySnapshot {
    const sources = this.hub.snapshots().filter((value) => this.configuredIds.has(value.instrument.instrumentId));
    return buildContinuousRouteDiscovery(this.configured, sources, {
      capturedAt: this.now(),
      maxCandidates: this.maxCandidates,
      maxMarketEvaluations: this.maxMarketEvaluations,
      maxBookAgeMs: this.maxBookAgeMs,
      maxLegSkewMs: this.maxLegSkewMs,
      maxFutureClockSkewMs: this.maxFutureClockSkewMs,
      clockCalibration: this.clockCalibration,
      runtimeCoverage: this.runtimeCoverage
    });
  }

  subscribe(listener: (snapshot: ContinuousRouteDiscoverySnapshot) => void) {
    this.listeners.add(listener);
    this.notifyListener(listener, this.snapshot());
    return { close: () => this.listeners.delete(listener) };
  }

  close() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.emitTimerDueAt = undefined;
    this.emitDirty = false;
    this.lastEmittedAt = undefined;
    this.stopSubscriptions();
    this.listeners.clear();
    this.configured = [];
    this.configuredIds.clear();
  }

  private scheduleEmit(urgent: boolean) {
    if (this.listeners.size === 0) return;
    this.emitDirty = true;
    const now = this.monotonicNow();
    const intervalMs = urgent ? Math.min(this.emitIntervalMs, URGENT_EMIT_INTERVAL_MS) : this.emitIntervalMs;
    const dueAt = this.lastEmittedAt === undefined ? now : Math.max(now, this.lastEmittedAt + intervalMs);
    if (this.emitTimer && this.emitTimerDueAt !== undefined && this.emitTimerDueAt <= dueAt) return;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimerDueAt = dueAt;
    this.emitTimer = setTimeout(() => this.flushScheduledEmit(), Math.max(0, dueAt - now));
    this.emitTimer.unref?.();
  }

  private flushScheduledEmit() {
    this.emitTimer = undefined;
    this.emitTimerDueAt = undefined;
    if (!this.emitDirty || this.listeners.size === 0) return;
    this.emitDirty = false;
    const snapshot = this.snapshot();
    this.lastEmittedAt = this.monotonicNow();
    for (const listener of this.listeners) this.notifyListener(listener, snapshot);
  }

  private notifyListener(listener: (snapshot: ContinuousRouteDiscoverySnapshot) => void, snapshot: ContinuousRouteDiscoverySnapshot) {
    try {
      listener(structuredClone(snapshot));
    } catch {
      // One observational consumer cannot corrupt a sibling snapshot or tear down
      // the public feed scheduler. Consumers own their own failure reporting.
    }
  }

  private stopSubscriptions() {
    for (const subscription of this.subscriptions.splice(0)) subscription.close();
  }
}

export function buildContinuousRouteDiscovery(
  values: readonly ContinuousDiscoveryInstrument[],
  sources: readonly ContinuousFeedSnapshot[],
  options: {
    capturedAt: number;
    maxCandidates?: number;
    maxMarketEvaluations?: number;
    maxBookAgeMs?: number;
    maxLegSkewMs?: number;
    maxFutureClockSkewMs?: number;
    clockCalibration?: VenueClockAssessmentProvider;
    runtimeCoverage?: ContinuousDiscoveryRuntimeCoverage;
    signal?: AbortSignal;
  }
): ContinuousRouteDiscoverySnapshot {
  throwIfAborted(options.signal);
  if (values.length > HARD_MAX_SUBSCRIPTIONS) throw new Error(`Continuous route discovery accepts at most ${HARD_MAX_SUBSCRIPTIONS} instruments`);
  if (sources.length > HARD_MAX_SUBSCRIPTIONS) throw new Error(`Continuous route discovery accepts at most ${HARD_MAX_SUBSCRIPTIONS} source snapshots`);
  const maxCandidates = bounded(options.maxCandidates ?? 200, 1, HARD_MAX_PUBLISHED_CANDIDATES, "maxCandidates");
  const maxMarketEvaluations = bounded(options.maxMarketEvaluations ?? maxCandidates, 1, HARD_MAX_PUBLISHED_CANDIDATES, "maxMarketEvaluations");
  const publicationLimit = Math.min(maxCandidates, maxMarketEvaluations);
  const instruments: PairwiseInstrument[] = [];
  const rejectedInstruments: PairwiseRejection[] = [];
  for (const value of values) {
    throwIfAborted(options.signal);
    try {
      instruments.push(pairwiseInstrumentFromRegistry(value.instrument, value.overlay));
    } catch (error) {
      rejectedInstruments.push({ instrumentId: value.instrument.id, code: "invalid-route", message: error instanceof Error ? error.message : "Instrument is not route-family ready" });
    }
  }
  instruments.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
  const byId = new Map(instruments.map((value) => [value.instrumentId, value]));
  const routeReadyBooks: PairwiseBookSnapshot[] = [];
  const excludedBooks: ContinuousRouteDiscoverySnapshot["excludedBooks"] = [];
  const topBooks: ContinuousTopBook[] = [];
  const fundingObservations: ContinuousFundingObservation[] = [];
  const maxAge = options.maxBookAgeMs ?? 10_000;
  const futureSkew = options.maxFutureClockSkewMs ?? 1_000;
  for (const source of [...sources].sort((left, right) => left.instrument.instrumentId.localeCompare(right.instrument.instrumentId))) {
    throwIfAborted(options.signal);
    if (source.topBook) topBooks.push(structuredClone(source.topBook));
    if (source.funding) fundingObservations.push({ ...source.funding });
    if (!source.book) continue;
    const instrument = byId.get(source.book.instrumentId);
    if (!instrument) {
      excludedBooks.push({ instrumentId: source.book.instrumentId, reason: "Validated pairwise metadata is unavailable" });
      continue;
    }
    const converted = pairwiseBookFromContinuous(source.book, options.capturedAt, maxAge);
    if (typeof converted === "string") {
      excludedBooks.push({ instrumentId: source.book.instrumentId, reason: converted });
      continue;
    }
    const problem = validatePairwiseBook(converted, instrument, options.capturedAt, futureSkew);
    if (problem) excludedBooks.push({ instrumentId: source.book.instrumentId, reason: problem });
    else routeReadyBooks.push(converted);
  }
  const discovery = discoverCompleteRouteFamilyCandidateUniverse(instruments, { signal: options.signal });
  const market = evaluateContinuousMarketEconomics(discovery.candidates, instruments, topBooks, new Map(sources.map((source) => [source.instrument.instrumentId, { state: source.status.state, generation: source.status.generation }])), {
    evaluatedAt: options.capturedAt,
    totalCandidates: discovery.totalCompatibleCandidates,
    discoveryTruncated: false,
    maxEvaluations: publicationLimit,
    maxBookAgeMs: maxAge,
    maxLegSkewMs: options.maxLegSkewMs ?? 1_000,
    maxFutureClockSkewMs: futureSkew,
    clockCalibration: options.clockCalibration,
    signal: options.signal
  });
  const candidatesByRouteId = new Map(discovery.candidates.map((candidate) => [candidate.routeId, candidate]));
  const publishedCandidates = market.marketEvaluations.map((evaluation) => {
    const candidate = candidatesByRouteId.get(evaluation.routeId);
    if (!candidate) throw new Error(`Continuous market evaluation references unknown route ${evaluation.routeId}`);
    return candidate;
  });
  const truncated = discovery.totalCompatibleCandidates > publishedCandidates.length;
  rejectedInstruments.push(...discovery.rejectedInstruments);
  rejectedInstruments.sort((left, right) => (left.instrumentId ?? "").localeCompare(right.instrumentId ?? ""));
  return {
    engine: "continuous-route-discovery-v1",
    executionStatus: "research-only",
    executable: false,
    capturedAt: options.capturedAt,
    runtimeCoverage: options.runtimeCoverage ? { ...options.runtimeCoverage } : { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" },
    totalCompatibleCandidates: discovery.totalCompatibleCandidates,
    truncated,
    candidates: publishedCandidates,
    marketEconomics: market.marketEconomics,
    marketEvaluations: market.marketEvaluations,
    instruments,
    routeReadyBooks,
    topBooks,
    fundingObservations,
    excludedBooks,
    rejectedInstruments,
    sources: sources.map((value) => structuredClone(value))
  };
}

function validateRuntimeCoverage(value: ContinuousDiscoveryRuntimeCoverage) {
  const valid =
    (value.reason === "complete" && value.complete && value.current && !value.retainedPriorDiscovery) ||
    (value.reason === "partial-instruments" && !value.complete && value.current && !value.retainedPriorDiscovery) ||
    ((value.reason === "configuration-disabled" || value.reason === "configuration-invalid") && !value.complete && !value.current && !value.retainedPriorDiscovery) ||
    ((value.reason === "refresh-pending" || value.reason === "refresh-failed") && !value.complete && !value.current);
  if (!valid) throw new Error("Continuous discovery runtime coverage is inconsistent");
}

export function pairwiseBookFromContinuous(book: ContinuousPublicBook, now: number, maxAgeMs: number): PairwiseBookSnapshot | string {
  if (book.continuity.kind === "atomic-snapshot") return "Venue publishes atomic snapshots without an integrity or protocol-sequence proof; kept as a research signal only";
  if (book.continuity.kind === "sequence-observed") {
    return book.continuity.protocol === "dydx-indexer-message-id" ? "dYdX Indexer message continuity does not make its off-chain book the current proposer mempool; kept as a non-canonical research signal only" : "Venue sequence is monotonic but not documented as contiguous per product; kept as a research signal only";
  }
  if (!Number.isSafeInteger(book.continuity.sequence) || book.continuity.sequence <= 0) return "Protocol sequence is not a positive safe integer";
  if (now - book.receivedAt > maxAgeMs) return `Continuous public book is older than ${maxAgeMs} ms`;
  return {
    instrumentId: book.instrumentId,
    quantityUnit: book.quantityUnit,
    bids: book.bids.map(([price, quantity]) => [price, quantity] as const),
    asks: book.asks.map(([price, quantity]) => [price, quantity] as const),
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt,
    complete: true,
    sequence: book.continuity.sequence,
    source: "websocket",
    sourceId: `${book.venue}:public-websocket:${book.continuity.protocol}:generation-${book.connectionGeneration}`
  };
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("Continuous route discovery aborted");
  error.name = "AbortError";
  throw error;
}
