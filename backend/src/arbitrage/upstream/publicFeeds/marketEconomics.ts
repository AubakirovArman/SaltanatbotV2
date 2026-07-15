import type { PairwiseInstrument } from "../../engines/pairwise/index.js";
import type { RouteFamilyCandidate } from "../../routeFamilies/index.js";
import { assessScannerPairTiming, type ScannerPairTiming } from "../../timing/index.js";
import { safeBasisBps, safeDifference, safePositiveAverage, safeSum } from "./marketEconomicsArithmetic.js";
import { marketLeg, minimumReasonsForPair, pairTopQuantity, QuantityFailure, type PairedQuantity } from "./marketEconomicsQuantity.js";
import {
  CONTINUOUS_MARKET_ECONOMICS_ENGINE,
  CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION,
  type ContinuousMarketBlockCode,
  type ContinuousMarketBlockReason,
  type ContinuousMarketEconomicsOptions,
  type ContinuousMarketEconomicsSummary,
  type ContinuousMarketEvaluation,
  type ContinuousMarketEvaluationBase,
  type ContinuousMarketLeg
} from "./marketEconomicsTypes.js";
import type { ContinuousFeedStatus, ContinuousTopBook } from "./types.js";

const HARD_MAX_CONTINUOUS_CANDIDATES = 24 * 23;
const HARD_MAX_PUBLISHED_EVALUATIONS = 500;

export function evaluateContinuousMarketEconomics(
  candidates: readonly RouteFamilyCandidate[],
  instruments: readonly PairwiseInstrument[],
  topBooks: readonly ContinuousTopBook[],
  sourceStates: ReadonlyMap<string, Pick<ContinuousFeedStatus, "state" | "generation">>,
  options: ContinuousMarketEconomicsOptions
): { marketEconomics: ContinuousMarketEconomicsSummary; marketEvaluations: ContinuousMarketEvaluation[] } {
  validateWorkBounds(candidates, options);
  throwIfAborted(options.signal);
  const instrumentMap = uniqueMap(instruments, (value) => value.instrumentId);
  const bookMap = uniqueMap(topBooks, (value) => value.instrumentId);
  const ranked: ContinuousMarketEvaluation[] = [];
  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    ranked.push(evaluateCandidate(candidate, instrumentMap, bookMap, sourceStates, options));
  }
  ranked.sort(marketEvaluationOrder);
  throwIfAborted(options.signal);
  const marketEvaluations = ranked.slice(0, options.maxEvaluations);
  const marketOnlyCandidates = ranked.filter((value) => value.status === "market-only").length;
  const publishedMarketOnlyCandidates = marketEvaluations.filter((value) => value.status === "market-only").length;
  return {
    marketEconomics: {
      engine: CONTINUOUS_MARKET_ECONOMICS_ENGINE,
      readOnly: true,
      researchOnly: true,
      executable: false,
      outcomeClass: "projected",
      evaluatedAt: options.evaluatedAt,
      totalCandidates: options.totalCandidates,
      evaluatedCandidates: ranked.length,
      marketOnlyCandidates,
      blockedCandidates: ranked.length - marketOnlyCandidates,
      publishedEvaluations: marketEvaluations.length,
      publishedMarketOnlyCandidates,
      publishedBlockedCandidates: marketEvaluations.length - publishedMarketOnlyCandidates,
      truncated: options.discoveryTruncated || candidates.length > marketEvaluations.length,
      feePolicy: {
        version: CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION,
        source: "operator-environment",
        liquidity: "taker",
        discountsApplied: false,
        rebatesApplied: false,
        feeAssetVerified: false,
        exposureImpactIncluded: false,
        coverage: "entry-only"
      }
    },
    marketEvaluations
  };
}

/**
 * Useful market rows always precede blocked rows. Within the useful set, rank by
 * fee-adjusted entry value, basis, visible quote capacity and then evidence quality.
 * Route ID is the final stable tie-break, so input order can never affect output.
 */
function marketEvaluationOrder(left: ContinuousMarketEvaluation, right: ContinuousMarketEvaluation) {
  if (left.status !== right.status) return left.status === "market-only" ? -1 : 1;
  if (left.status === "market-only" && right.status === "market-only") {
    return (
      descending(left.edges.netEntryValueDifferenceAfterEstimatedFeesQuote, right.edges.netEntryValueDifferenceAfterEstimatedFeesQuote) ||
      descending(left.edges.netEntryBasisAfterEstimatedFeesBps, right.edges.netEntryBasisAfterEstimatedFeesBps) ||
      descending(left.capacity.referenceNotionalQuote, right.capacity.referenceNotionalQuote) ||
      descending(continuityQuality(left), continuityQuality(right)) ||
      left.freshness.quoteAgeMs - right.freshness.quoteAgeMs ||
      left.freshness.legSkewMs - right.freshness.legSkewMs ||
      left.routeId.localeCompare(right.routeId)
    );
  }
  const leftMarketBlocks = left.blockedReasons.filter(({ stage }) => stage === "market-data").length;
  const rightMarketBlocks = right.blockedReasons.filter(({ stage }) => stage === "market-data").length;
  return leftMarketBlocks - rightMarketBlocks || left.blockedReasons.length - right.blockedReasons.length || left.routeId.localeCompare(right.routeId);
}

function continuityQuality(evaluation: Extract<ContinuousMarketEvaluation, { status: "market-only" }>) {
  return evaluation.legs.reduce((total, leg) => total + (leg.bookEvidence.quality === "checksum-verified" ? 2 : 1), 0);
}

function descending(left: number, right: number) {
  return left === right ? 0 : left > right ? -1 : 1;
}

function validateWorkBounds(candidates: readonly RouteFamilyCandidate[], options: ContinuousMarketEconomicsOptions) {
  if (candidates.length > HARD_MAX_CONTINUOUS_CANDIDATES) {
    throw new Error(`Continuous market economics accepts at most ${HARD_MAX_CONTINUOUS_CANDIDATES} candidates`);
  }
  if (!Number.isSafeInteger(options.maxEvaluations) || options.maxEvaluations < 1 || options.maxEvaluations > HARD_MAX_PUBLISHED_EVALUATIONS) {
    throw new Error(`Continuous market economics publishes between 1 and ${HARD_MAX_PUBLISHED_EVALUATIONS} evaluations`);
  }
  if (!Number.isSafeInteger(options.totalCandidates) || options.totalCandidates < candidates.length) {
    throw new Error("Continuous market economics candidate total is inconsistent");
  }
  if (!options.discoveryTruncated && options.totalCandidates !== candidates.length) {
    throw new Error("Complete continuous market economics requires the full candidate universe");
  }
  const routeIds = new Set<string>();
  const routeKeys = new Set<string>();
  for (const candidate of candidates) {
    if (routeIds.has(candidate.routeId) || routeKeys.has(candidate.routeKey)) throw new Error("Continuous market economics candidates must be unique");
    routeIds.add(candidate.routeId);
    routeKeys.add(candidate.routeKey);
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("Continuous market economics ranking aborted");
  error.name = "AbortError";
  throw error;
}

function evaluateCandidate(candidate: RouteFamilyCandidate, instruments: ReadonlyMap<string, PairwiseInstrument>, books: ReadonlyMap<string, ContinuousTopBook>, sourceStates: ReadonlyMap<string, Pick<ContinuousFeedStatus, "state" | "generation">>, options: ContinuousMarketEconomicsOptions): ContinuousMarketEvaluation {
  const strategyReasons = strategyEvidenceReasons(candidate);
  const long = instruments.get(candidate.longInstrumentId);
  const short = instruments.get(candidate.shortInstrumentId);
  const base = evaluationBase(candidate, options.evaluatedAt, long, short);
  const longBook = books.get(candidate.longInstrumentId);
  const shortBook = books.get(candidate.shortInstrumentId);
  const timing = pairTiming(long, short, longBook, shortBook, options);
  const marketReasons = orderedReasons([...marketDataReasons(candidate, long, short, longBook, shortBook, sourceStates, options), ...timingReasons(candidate, timing)]);
  if (!long || !short || !longBook || !shortBook || marketReasons.length > 0) {
    return { ...base, status: "blocked", blockedReasons: orderedReasons([...marketReasons, ...strategyReasons]) };
  }
  if (!timing || !timing.eligible) throw new Error("Eligible continuous market row is missing timing evidence");

  let paired: PairedQuantity;
  try {
    paired = pairTopQuantity(long, short, longBook, shortBook);
  } catch (error) {
    const code: ContinuousMarketBlockCode = error instanceof QuantityFailure ? error.code : "unsupported-quantity-precision";
    const message = error instanceof Error ? error.message : "Top-book quantity precision is unsupported";
    return {
      ...base,
      status: "blocked",
      blockedReasons: orderedReasons([{ code, stage: "market-data", message }, ...strategyReasons])
    };
  }

  let minimumReasons: ContinuousMarketBlockReason[];
  try {
    minimumReasons = minimumReasonsForPair(long, short, paired);
  } catch (error) {
    return arithmeticBlocked(base, strategyReasons, error);
  }
  if (minimumReasons.length > 0) {
    return { ...base, status: "blocked", blockedReasons: orderedReasons([...minimumReasons, ...strategyReasons]) };
  }

  let longLeg: ContinuousMarketLeg;
  let shortLeg: ContinuousMarketLeg;
  let referenceNotionalQuote: number;
  let grossEntryValueDifferenceQuote: number;
  let publicEntryFeesQuoteEquivalentEstimate: number;
  let netEntryValueDifferenceAfterEstimatedFeesQuote: number;
  let grossEntryBasisBps: number;
  let netEntryBasisAfterEstimatedFeesBps: number;
  try {
    longLeg = marketLeg("long", long, longBook, paired.long);
    shortLeg = marketLeg("short", short, shortBook, paired.short);
    referenceNotionalQuote = safePositiveAverage(longLeg.quoteNotional, shortLeg.quoteNotional, "reference quote notional");
    grossEntryValueDifferenceQuote = safeDifference(shortLeg.quoteNotional, longLeg.quoteNotional, "gross entry value difference");
    publicEntryFeesQuoteEquivalentEstimate = safeSum(longLeg.publicEntryFeeQuoteEquivalentEstimate, shortLeg.publicEntryFeeQuoteEquivalentEstimate, "public entry fee quote-equivalent estimate");
    netEntryValueDifferenceAfterEstimatedFeesQuote = safeDifference(grossEntryValueDifferenceQuote, publicEntryFeesQuoteEquivalentEstimate, "entry value difference after estimated fees");
    grossEntryBasisBps = safeBasisBps(grossEntryValueDifferenceQuote, referenceNotionalQuote, "gross entry basis");
    netEntryBasisAfterEstimatedFeesBps = safeBasisBps(netEntryValueDifferenceAfterEstimatedFeesQuote, referenceNotionalQuote, "entry basis after estimated fees");
  } catch (error) {
    return arithmeticBlocked(base, strategyReasons, error);
  }
  const sourceIds = [longLeg.bookEvidence.sourceId, shortLeg.bookEvidence.sourceId] as const;
  const received = [longBook.receivedAt, shortBook.receivedAt];
  return {
    ...base,
    status: "market-only",
    baseAsset: long.baseAsset,
    quoteAsset: long.quoteAsset,
    blockedReasons: orderedReasons(strategyReasons),
    legs: [longLeg, shortLeg],
    capacity: {
      scope: "maximum-visible-top-book",
      matchedBaseQuantity: paired.commonBaseQuantity,
      commonBaseQuantity: paired.commonBaseQuantity,
      referenceNotionalQuote,
      longAlignedBaseCapacity: paired.long.alignedBaseCapacity,
      shortAlignedBaseCapacity: paired.short.alignedBaseCapacity
    },
    edges: {
      grossEntryValueDifferenceQuote,
      grossEntryBasisBps,
      publicEntryFeesQuoteEquivalentEstimate,
      netEntryValueDifferenceAfterEstimatedFeesQuote,
      netEntryBasisAfterEstimatedFeesBps,
      coverage: "top-book-entry-and-public-taker-fees-only"
    },
    freshness: marketFreshness(timing, received, options),
    evidence: {
      marketDataComplete: true,
      continuityVerified: true,
      requiredStrategyEvidenceComplete: false,
      sourceIds,
      economicIdentities: [identityEvidence(long), identityEvidence(short)]
    }
  };
}

function pairTiming(long: PairwiseInstrument | undefined, short: PairwiseInstrument | undefined, longBook: ContinuousTopBook | undefined, shortBook: ContinuousTopBook | undefined, options: ContinuousMarketEconomicsOptions): ScannerPairTiming | undefined {
  if (!long || !short || !longBook || !shortBook) return undefined;
  if (![longBook.exchangeTs, longBook.receivedAt, shortBook.exchangeTs, shortBook.receivedAt].every((value) => Number.isSafeInteger(value) && value > 0)) return undefined;
  return assessScannerPairTiming(
    options.clockCalibration,
    [
      { sourceId: `${long.venue}:public`, exchangeTs: longBook.exchangeTs, receivedAt: longBook.receivedAt },
      { sourceId: `${short.venue}:public`, exchangeTs: shortBook.exchangeTs, receivedAt: shortBook.receivedAt }
    ],
    options.evaluatedAt,
    {
      maximumAgeMs: options.maxBookAgeMs,
      maximumFutureSkewMs: options.maxFutureClockSkewMs,
      maximumSkewMs: options.maxLegSkewMs,
      requireCalibrated: long.venue !== short.venue
    }
  );
}

function timingReasons(candidate: RouteFamilyCandidate, timing: ScannerPairTiming | undefined): ContinuousMarketBlockReason[] {
  if (!timing || timing.eligible) return [];
  const code = timing.reason === "skew-exceeded" ? "clock-skew-exceeded" : timing.reason;
  return [
    reason(
      code,
      "market-data",
      timing.sourceId ?? candidate.routeId,
      timing.reason === "clock-unavailable"
        ? "Cross-venue clock calibration is unavailable"
        : timing.reason === "clock-not-calibrated"
          ? "Cross-venue clock calibration is degraded or expired"
          : timing.reason === "skew-exceeded"
            ? "Worst-case calibrated event-time interval skew exceeds the configured boundary"
            : `Calibrated venue timestamp is ineligible: ${timing.reason}`
    )
  ];
}

function marketFreshness(timing: Extract<ScannerPairTiming, { eligible: true }>, received: readonly number[], options: ContinuousMarketEconomicsOptions): Extract<ContinuousMarketEvaluation, { status: "market-only" }>["freshness"] {
  const common = {
    status: "fresh" as const,
    maxBookAgeMs: options.maxBookAgeMs,
    maxLegSkewMs: options.maxLegSkewMs,
    oldestReceivedAt: Math.min(...received),
    newestReceivedAt: Math.max(...received)
  };
  if (timing.clockBasis === "local-receipt-fallback") {
    return {
      ...common,
      clockBasis: timing.clockBasis,
      crossVenueComparable: false,
      quoteAgeMs: timing.quoteAgeMs,
      legSkewMs: timing.legSkewMs,
      fallbackReason: timing.fallbackReason
    };
  }
  return {
    ...common,
    clockBasis: timing.clockBasis,
    crossVenueComparable: true,
    quoteAgeMs: Math.max(0, timing.quoteAgeUpperMs),
    legSkewMs: timing.maximumPossibleLegSkewMs,
    quoteAgeLowerMs: timing.quoteAgeLowerMs,
    quoteAgeUpperMs: timing.quoteAgeUpperMs,
    minimumPossibleLegSkewMs: timing.minimumPossibleLegSkewMs,
    maximumPossibleLegSkewMs: timing.maximumPossibleLegSkewMs,
    clockLegs: timing.legs
  };
}

function arithmeticBlocked(base: Omit<ContinuousMarketEvaluationBase, "blockedReasons">, strategyReasons: readonly ContinuousMarketBlockReason[], error: unknown): ContinuousMarketEvaluation {
  const message = error instanceof Error ? error.message : "Derived market arithmetic is invalid";
  return {
    ...base,
    status: "blocked",
    blockedReasons: orderedReasons([reason("derived-arithmetic-invalid", "market-data", base.routeId, message), ...strategyReasons])
  };
}

function evaluationBase(candidate: RouteFamilyCandidate, evaluatedAt: number, long: PairwiseInstrument | undefined, short: PairwiseInstrument | undefined): Omit<ContinuousMarketEvaluationBase, "blockedReasons"> {
  return {
    engine: CONTINUOUS_MARKET_ECONOMICS_ENGINE,
    readOnly: true,
    researchOnly: true,
    executable: false,
    outcomeClass: "projected",
    strategyStatus: "blocked",
    evaluatedAt,
    routeId: candidate.routeId,
    family: candidate.family,
    longInstrumentId: candidate.longInstrumentId,
    shortInstrumentId: candidate.shortInstrumentId,
    economicAssetId: candidate.economicAssetId,
    baseAsset: long?.baseAsset ?? short?.baseAsset ?? null,
    quoteAsset: long?.quoteAsset ?? short?.quoteAsset ?? null,
    executionBoundary: {
      permission: false,
      orders: "not-supported",
      reason: "market-data-and-public-entry-fees-only"
    }
  };
}

function marketDataReasons(
  candidate: RouteFamilyCandidate,
  long: PairwiseInstrument | undefined,
  short: PairwiseInstrument | undefined,
  longBook: ContinuousTopBook | undefined,
  shortBook: ContinuousTopBook | undefined,
  states: ReadonlyMap<string, Pick<ContinuousFeedStatus, "state" | "generation">>,
  options: ContinuousMarketEconomicsOptions
) {
  const reasons: ContinuousMarketBlockReason[] = [];
  for (const [role, instrumentId, instrument, book] of [
    ["long", candidate.longInstrumentId, long, longBook],
    ["short", candidate.shortInstrumentId, short, shortBook]
  ] as const) {
    if (!instrument) reasons.push(reason("missing-instrument", "market-data", instrumentId, `${role} normalized instrument metadata is missing`));
    if (instrument) reasons.push(...economicIdentityReasons(instrument, options.evaluatedAt));
    if (!book) {
      reasons.push(reason("missing-top-book", "market-data", instrumentId, `${role} public top book is missing`));
      continue;
    }
    const sourceStatus = states.get(instrumentId);
    if (sourceStatus?.state !== "live") reasons.push(reason("feed-not-live", "market-data", instrumentId, `${role} public feed is not live`));
    if (sourceStatus && sourceStatus.generation !== book.connectionGeneration) reasons.push(reason("generation-mismatch", "market-data", instrumentId, `${role} top book belongs to a stale connection generation`));
    if (instrument && (book.instrumentId !== instrument.instrumentId || book.venue !== instrument.venue || book.marketType !== instrument.marketType)) {
      reasons.push(reason("invalid-top-book", "market-data", instrumentId, `${role} top-book identity does not match normalized metadata`));
    }
    if (instrument && book.quantityUnit !== instrument.quantityModel.unit) reasons.push(reason("quantity-unit-mismatch", "market-data", instrumentId, `${role} top-book quantity unit does not match normalized metadata`));
    if (instrument?.marketType === "future" && (!Number.isSafeInteger(instrument.expiryTime) || (instrument.expiryTime ?? 0) <= options.evaluatedAt)) {
      reasons.push(reason("expiry-boundary", "market-data", instrumentId, `${role} dated future is at or beyond expiry`));
    }
    if (![book.bid, book.ask, book.bidSize, book.askSize].every((value) => Number.isFinite(value) && value > 0) || book.bid >= book.ask) {
      reasons.push(reason("invalid-top-book", "market-data", instrumentId, `${role} top book is missing positive uncrossed prices and sizes`));
    }
    if (![book.exchangeTs, book.receivedAt, book.connectionGeneration].every((value) => Number.isSafeInteger(value) && value > 0)) {
      reasons.push(reason("invalid-top-book", "market-data", instrumentId, `${role} top-book timestamps or generation are invalid`));
    } else {
      if (book.exchangeTs > options.evaluatedAt + options.maxFutureClockSkewMs || book.receivedAt > options.evaluatedAt + options.maxFutureClockSkewMs) {
        reasons.push(reason("future-top-book", "market-data", instrumentId, `${role} top book exceeds the future-clock boundary`));
      }
      if (options.evaluatedAt - book.receivedAt > options.maxBookAgeMs) reasons.push(reason("stale-top-book", "market-data", instrumentId, `${role} top book exceeds the freshness boundary`));
    }
    if (!verifiedContinuity(book)) reasons.push(reason("unverified-continuity", "market-data", instrumentId, `${role} top book lacks sequence/checksum continuity evidence`));
  }
  if (longBook && shortBook && Number.isSafeInteger(longBook.receivedAt) && Number.isSafeInteger(shortBook.receivedAt) && Math.abs(longBook.receivedAt - shortBook.receivedAt) > options.maxLegSkewMs) {
    reasons.push(reason("skewed-top-books", "market-data", candidate.routeId, "Cross-leg receipt skew exceeds the configured boundary"));
  }
  return orderedReasons(reasons);
}

function strategyEvidenceReasons(candidate: RouteFamilyCandidate): ContinuousMarketBlockReason[] {
  const result: ContinuousMarketBlockReason[] = [];
  const add = (code: ContinuousMarketBlockCode, subject: string, message: string) => result.push(reason(code, "strategy-evidence", subject, message));
  if (candidate.family === "cross-venue-spot-spot") {
    add("account-capital-missing", candidate.longInstrumentId, "Verified quote capital for the spot buy leg is unavailable");
    add("account-inventory-missing", candidate.shortInstrumentId, "Verified base inventory for the spot sell leg is unavailable");
    add("network-rebalance-missing", candidate.routeId, "Exact network availability, fees and rebalance evidence are unavailable");
  } else if (candidate.family === "reverse-cash-and-carry") {
    add("derivative-margin-missing", candidate.longInstrumentId, "Verified derivative margin and collateral evidence are unavailable");
    add("borrow-evidence-missing", candidate.shortInstrumentId, "Verified spot borrow capacity, rate and horizon are unavailable");
    add("funding-horizon-missing", candidate.longInstrumentId, "Verified full-horizon perpetual funding evidence is unavailable");
    add("convergence-evidence-missing", candidate.routeId, "Route-specific convergence and exit-cost evidence are unavailable");
  } else if (candidate.family === "perpetual-perpetual-funding") {
    for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId]) {
      add("derivative-margin-missing", instrumentId, "Verified derivative margin and collateral evidence are unavailable");
      add("funding-horizon-missing", instrumentId, "Verified full-horizon perpetual funding evidence is unavailable");
    }
    add("convergence-evidence-missing", candidate.routeId, "Route-specific convergence and exit-cost evidence are unavailable");
  } else if (candidate.family === "spot-dated-future") {
    add("account-capital-missing", candidate.longInstrumentId, "Verified quote capital for the spot buy leg is unavailable");
    add("derivative-margin-missing", candidate.shortInstrumentId, "Verified derivative margin and collateral evidence are unavailable");
    add("convergence-evidence-missing", candidate.routeId, "Route-specific convergence and exit-cost evidence are unavailable");
    add("expiry-delivery-evidence-missing", candidate.shortInstrumentId, "Verified expiry close/delivery evidence is unavailable");
  } else if (candidate.family === "calendar-spread") {
    for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId]) add("derivative-margin-missing", instrumentId, "Verified derivative margin and collateral evidence are unavailable");
    add("convergence-evidence-missing", candidate.routeId, "Route-specific convergence and exit-cost evidence are unavailable");
    add("expiry-delivery-evidence-missing", candidate.routeId, "Verified near-expiry settlement and roll evidence are unavailable");
  } else {
    for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId]) add("derivative-margin-missing", instrumentId, "Verified derivative margin and collateral evidence are unavailable");
    const perpetualId = candidate.longMarketType === "perpetual" ? candidate.longInstrumentId : candidate.shortInstrumentId;
    const futureId = candidate.longMarketType === "future" ? candidate.longInstrumentId : candidate.shortInstrumentId;
    add("funding-horizon-missing", perpetualId, "Verified full-horizon perpetual funding evidence is unavailable");
    add("convergence-evidence-missing", candidate.routeId, "Route-specific convergence and exit-cost evidence are unavailable");
    add("expiry-delivery-evidence-missing", futureId, "Verified expiry close/delivery evidence is unavailable");
  }
  return orderedReasons(result);
}

function economicIdentityReasons(instrument: PairwiseInstrument, evaluatedAt: number): ContinuousMarketBlockReason[] {
  const review = instrument.economicIdentity;
  if (!review || review.status !== "reviewed" || !boundedIdentityText(review.source, 300) || !boundedIdentityText(review.version, 100) || !Number.isSafeInteger(review.asOf) || review.asOf <= 0 || !Number.isSafeInteger(review.validUntil) || review.validUntil <= review.asOf) {
    return [reason("economic-identity-invalid", "market-data", instrument.instrumentId, "Canonical economic identity review metadata is invalid")];
  }
  if (review.asOf > evaluatedAt) {
    return [reason("economic-identity-not-yet-valid", "market-data", instrument.instrumentId, "Canonical economic identity review is not yet valid at evaluatedAt")];
  }
  if (review.validUntil < evaluatedAt) {
    return [reason("economic-identity-expired", "market-data", instrument.instrumentId, "Canonical economic identity review has expired at evaluatedAt")];
  }
  return [];
}

function identityEvidence(instrument: PairwiseInstrument) {
  return {
    instrumentId: instrument.instrumentId,
    economicAssetId: instrument.economicAssetId,
    status: "reviewed" as const,
    source: instrument.economicIdentity.source,
    version: instrument.economicIdentity.version,
    asOf: instrument.economicIdentity.asOf,
    validUntil: instrument.economicIdentity.validUntil
  };
}

function boundedIdentityText(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function verifiedContinuity(book: ContinuousTopBook) {
  return (book.continuity.kind === "sequence-verified" || book.continuity.kind === "checksum-verified") && Number.isSafeInteger(book.continuity.sequence) && book.continuity.sequence > 0;
}

function reason(code: ContinuousMarketBlockCode, stage: ContinuousMarketBlockReason["stage"], subject: string, message: string): ContinuousMarketBlockReason {
  return { code, stage, subject, message };
}

function orderedReasons(values: readonly ContinuousMarketBlockReason[]) {
  return [...new Map(values.map((value) => [`${value.stage}\u0000${value.code}\u0000${value.subject ?? ""}\u0000${value.message}`, value])).values()].sort((left, right) => left.stage.localeCompare(right.stage) || left.code.localeCompare(right.code) || (left.subject ?? "").localeCompare(right.subject ?? ""));
}

function uniqueMap<T>(values: readonly T[], key: (value: T) => string) {
  const result = new Map<string, T>();
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value);
  return result;
}
