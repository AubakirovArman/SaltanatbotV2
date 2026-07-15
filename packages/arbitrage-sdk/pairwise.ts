import type { PairwiseBookProvenance, PairwiseCostBreakdown, PairwiseEvaluationRequest, PairwiseEvaluationResponse, PairwiseLegSimulation, PairwiseOpportunity, PairwiseProvenance, PairwiseRejection, PairwiseRiskFlag, PairwiseTimestamps } from "./types.js";
import { array, bool, exact, finite, integer, nonNegative, optionalText, positive, record, text } from "./validation.js";

const PAIRWISE_STRATEGIES = ["spot-spot", "perpetual-perpetual", "reverse-cash-and-carry", "spot-dated-future", "perpetual-future", "calendar-spread", "dated-futures-spread"] as const;
const PAIRWISE_RISK_FLAGS = [
  "simultaneous-execution-not-guaranteed",
  "caller-supplied-identity-review",
  "prefunded-quote-capital",
  "prefunded-spot-inventory",
  "cross-venue-rebalance",
  "explicit-borrow-assumption",
  "funding-estimate",
  "manual-funding-stress",
  "convergence-assumption",
  "delivery-assumption",
  "derivative-margin-not-modeled",
  "inverse-or-quote-valued-contract",
  "depth-limited",
  "capital-limited",
  "inventory-limited",
  "rounding-dust",
  "residual-base-delta",
  "near-minimum-notional",
  "top-book-only",
  "rest-snapshot"
] as const satisfies readonly PairwiseRiskFlag[];
const PAIRWISE_REJECTION_CODES = [
  "unknown-instrument",
  "economic-identity-invalid",
  "economic-identity-mismatch",
  "invalid-route",
  "settlement-conversion-required",
  "missing-book",
  "invalid-book",
  "incomplete-book",
  "stale-book",
  "skewed-books",
  "missing-assumption",
  "stale-assumption",
  "capital-unavailable",
  "borrow-unavailable",
  "minimum-quantity",
  "minimum-notional",
  "insufficient-depth",
  "residual-delta",
  "expiry-boundary",
  "non-profitable"
] as const;

const ECONOMIC_ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/;

/** Runtime preflight for the caller-supplied pairwise economic-identity contract. */
export function assertPairwiseRequestEconomicIdentity(value: unknown): asserts value is PairwiseEvaluationRequest {
  const request = record(value, "pairwise request");
  const instruments = array(request.instruments, "pairwise request.instruments", 2);
  if (instruments.length !== 2) throw new Error("pairwise request requires exactly two instruments");
  const parsed = instruments.map((instrument, index) => {
    const row = record(instrument, `pairwise instrument[${index}]`);
    const review = parseEconomicIdentityReview(row.economicIdentity, `pairwise instrument[${index}].economicIdentity`);
    return { economicAssetId: parseEconomicAssetId(row.economicAssetId, `pairwise instrument[${index}].economicAssetId`), review };
  });
  if (parsed[0]!.economicAssetId !== parsed[1]!.economicAssetId) {
    throw new Error("pairwise instruments must have an exact canonical economicAssetId match");
  }
}

/** Strict parser for the credential-free pairwise research evaluator response. */
export function parsePairwiseEvaluation(value: unknown): PairwiseEvaluationResponse {
  const row = record(value, "pairwise evaluation");
  const envelope = {
    engine: exact(row.engine, ["pairwise-v1"] as const, "engine"),
    executable: exactFalse(row.executable, "executable"),
    evaluatedAt: positiveSafeInteger(row.evaluatedAt, "evaluatedAt")
  };
  const hasOpportunity = row.opportunity !== undefined;
  const hasRejection = row.rejection !== undefined;
  if (hasOpportunity === hasRejection) throw new Error("pairwise evaluation must contain exactly one opportunity or rejection");
  if (hasOpportunity) {
    const opportunity = parsePairwiseOpportunity(row.opportunity, envelope.evaluatedAt);
    if (opportunity.timestamps.evaluatedAt !== envelope.evaluatedAt) throw new Error("pairwise evaluatedAt must match opportunity timestamps");
    return { ...envelope, opportunity };
  }
  return { ...envelope, rejection: parsePairwiseRejection(row.rejection) };
}

function parsePairwiseOpportunity(value: unknown, evaluatedAt: number): PairwiseOpportunity {
  const row = record(value, "pairwise opportunity");
  const rawLegs = array(row.legs, "pairwise opportunity.legs", 2);
  if (rawLegs.length !== 2) throw new Error("pairwise opportunity.legs must contain exactly two legs");
  const legs = [parsePairwiseLeg(rawLegs[0], "long"), parsePairwiseLeg(rawLegs[1], "short")] as const;
  const routeId = text(row.routeId, "routeId");
  const provenance = parsePairwiseProvenance(row.provenance, evaluatedAt);
  if (provenance.routeId !== routeId) throw new Error("pairwise provenance.routeId must match opportunity.routeId");
  if (provenance.metadataIds[0] !== legs[0].instrumentId || provenance.metadataIds[1] !== legs[1].instrumentId) {
    throw new Error("pairwise provenance.metadataIds must preserve long/short leg order");
  }
  if (provenance.books[0].instrumentId !== legs[0].instrumentId || provenance.books[1].instrumentId !== legs[1].instrumentId) {
    throw new Error("pairwise provenance.books must preserve long/short leg order");
  }
  if (provenance.economicIdentity.legs[0].instrumentId !== legs[0].instrumentId || provenance.economicIdentity.legs[1].instrumentId !== legs[1].instrumentId) {
    throw new Error("pairwise provenance economic identity must preserve long/short leg order");
  }
  const economicAssetId = parseEconomicAssetId(row.economicAssetId, "economicAssetId");
  if (economicAssetId !== provenance.economicIdentity.economicAssetId) {
    throw new Error("pairwise opportunity economicAssetId must match provenance");
  }
  const id = text(row.id, "id");
  if (id !== `pairwise:${routeId}`) throw new Error("pairwise opportunity id must match routeId");
  const requestedBaseQuantity = positive(row.requestedBaseQuantity, "requestedBaseQuantity");
  const executableBaseQuantity = nonNegative(row.executableBaseQuantity, "executableBaseQuantity");
  const longBaseQuantity = nonNegative(row.longBaseQuantity, "longBaseQuantity");
  const shortBaseQuantity = nonNegative(row.shortBaseQuantity, "shortBaseQuantity");
  const residualBaseQuantity = finite(row.residualBaseQuantity, "residualBaseQuantity");
  const unfilledBaseQuantity = nonNegative(row.unfilledBaseQuantity, "unfilledBaseQuantity");
  const capacityShortfallBaseQuantity = nonNegative(row.capacityShortfallBaseQuantity, "capacityShortfallBaseQuantity");
  const baseDustQuantity = nonNegative(row.baseDustQuantity, "baseDustQuantity");
  const grossEntryPnlQuote = finite(row.grossEntryPnlQuote, "grossEntryPnlQuote");
  const grossExpectedPnlQuote = finite(row.grossExpectedPnlQuote, "grossExpectedPnlQuote");
  const netExpectedPnlQuote = finite(row.netExpectedPnlQuote, "netExpectedPnlQuote");
  const entryBasisBps = finite(row.entryBasisBps, "entryBasisBps");
  const expectedExitBasisBps = finite(row.expectedExitBasisBps, "expectedExitBasisBps");
  const netReturnBps = finite(row.netReturnBps, "netReturnBps");
  const referenceNotionalQuote = positive(row.referenceNotionalQuote, "referenceNotionalQuote");
  const costs = parsePairwiseCosts(row.costs);
  const timestamps = parsePairwiseTimestamps(row.timestamps);
  validatePairwiseTimestampSemantics(legs, provenance, timestamps, evaluatedAt);
  validatePairwiseEconomicSemantics({
    legs,
    requestedBaseQuantity,
    executableBaseQuantity,
    longBaseQuantity,
    shortBaseQuantity,
    residualBaseQuantity,
    unfilledBaseQuantity,
    capacityShortfallBaseQuantity,
    baseDustQuantity,
    grossEntryPnlQuote,
    grossExpectedPnlQuote,
    netExpectedPnlQuote,
    entryBasisBps,
    expectedExitBasisBps,
    netReturnBps,
    referenceNotionalQuote,
    costs
  });
  return {
    id,
    strategyKind: exact(row.strategyKind, PAIRWISE_STRATEGIES, "strategyKind"),
    edgeKind: exact(row.edgeKind, ["research-simulation"] as const, "edgeKind"),
    executable: exactFalse(row.executable, "opportunity.executable"),
    routeId,
    baseAsset: text(row.baseAsset, "baseAsset"),
    economicAssetId,
    quoteAsset: text(row.quoteAsset, "quoteAsset"),
    requestedBaseQuantity,
    executableBaseQuantity,
    longBaseQuantity,
    shortBaseQuantity,
    residualBaseQuantity,
    unfilledBaseQuantity,
    capacityShortfallBaseQuantity,
    baseDustQuantity,
    grossEntryPnlQuote,
    grossExpectedPnlQuote,
    netExpectedPnlQuote,
    entryBasisBps,
    expectedExitBasisBps,
    netReturnBps,
    referenceNotionalQuote,
    legs,
    costs,
    timestamps,
    provenance,
    riskFlags: array(row.riskFlags, "riskFlags", 30).map((flag) => exact(flag, PAIRWISE_RISK_FLAGS, "riskFlag"))
  };
}

function parsePairwiseLeg(value: unknown, expectedRole: "long" | "short"): PairwiseLegSimulation {
  const row = record(value, `${expectedRole} pairwise leg`);
  const role = exact(row.role, ["long", "short"] as const, "role");
  if (role !== expectedRole) throw new Error("pairwise legs must preserve long/short order");
  const side = exact(row.side, ["buy", "sell"] as const, "side");
  const bookSide = exact(row.bookSide, ["asks", "bids"] as const, "bookSide");
  if ((role === "long" && (side !== "buy" || bookSide !== "asks")) || (role === "short" && (side !== "sell" || bookSide !== "bids"))) {
    throw new Error(`${role} pairwise leg has inconsistent side`);
  }
  return {
    role,
    instrumentId: text(row.instrumentId, "instrumentId"),
    venue: text(row.venue, "venue"),
    symbol: text(row.symbol, "symbol"),
    marketType: exact(row.marketType, ["spot", "perpetual", "future"] as const, "marketType"),
    side,
    bookSide,
    nativeQuantity: nonNegative(row.nativeQuantity, "nativeQuantity"),
    quantityUnit: exact(row.quantityUnit, ["base", "quote", "contract"] as const, "quantityUnit"),
    baseEquivalentQuantity: nonNegative(row.baseEquivalentQuantity, "baseEquivalentQuantity"),
    averagePrice: positive(row.averagePrice, "averagePrice"),
    worstPrice: positive(row.worstPrice, "worstPrice"),
    quoteNotional: nonNegative(row.quoteNotional, "quoteNotional"),
    entryFeeBps: nonNegative(row.entryFeeBps, "entryFeeBps"),
    entryFeeQuote: nonNegative(row.entryFeeQuote, "entryFeeQuote"),
    levelsUsed: integer(row.levelsUsed, "levelsUsed"),
    depthLimited: bool(row.depthLimited, "depthLimited"),
    exchangeTs: positiveSafeInteger(row.exchangeTs, "exchangeTs"),
    receivedAt: positiveSafeInteger(row.receivedAt, "receivedAt")
  };
}

function parsePairwiseCosts(value: unknown): PairwiseCostBreakdown {
  const row = record(value, "pairwise costs");
  return {
    entryFeesQuote: nonNegative(row.entryFeesQuote, "entryFeesQuote"),
    exitFeesQuote: nonNegative(row.exitFeesQuote, "exitFeesQuote"),
    borrowCostQuote: nonNegative(row.borrowCostQuote, "borrowCostQuote"),
    fundingNetQuote: finite(row.fundingNetQuote, "fundingNetQuote"),
    deliveryFeesQuote: nonNegative(row.deliveryFeesQuote, "deliveryFeesQuote"),
    rebalanceCostQuote: nonNegative(row.rebalanceCostQuote, "rebalanceCostQuote")
  };
}

function parsePairwiseTimestamps(value: unknown): PairwiseTimestamps {
  const row = record(value, "pairwise timestamps");
  const horizonExitAt = row.horizonExitAt === undefined ? undefined : positiveSafeInteger(row.horizonExitAt, "horizonExitAt");
  return {
    evaluatedAt: positiveSafeInteger(row.evaluatedAt, "evaluatedAt"),
    oldestExchangeTs: positiveSafeInteger(row.oldestExchangeTs, "oldestExchangeTs"),
    newestExchangeTs: positiveSafeInteger(row.newestExchangeTs, "newestExchangeTs"),
    oldestReceivedAt: positiveSafeInteger(row.oldestReceivedAt, "oldestReceivedAt"),
    newestReceivedAt: positiveSafeInteger(row.newestReceivedAt, "newestReceivedAt"),
    quoteAgeMs: safeInteger(row.quoteAgeMs, "quoteAgeMs"),
    legSkewMs: safeInteger(row.legSkewMs, "legSkewMs"),
    oldestAssumptionAsOf: positiveSafeInteger(row.oldestAssumptionAsOf, "oldestAssumptionAsOf"),
    assumptionAgeMs: safeInteger(row.assumptionAgeMs, "assumptionAgeMs"),
    ...(horizonExitAt === undefined ? {} : { horizonExitAt })
  };
}

function validatePairwiseTimestampSemantics(legs: readonly [PairwiseLegSimulation, PairwiseLegSimulation], provenance: PairwiseProvenance, timestamps: PairwiseTimestamps, evaluatedAt: number) {
  for (const index of [0, 1] as const) {
    const leg = legs[index];
    const book = provenance.books[index];
    if (leg.exchangeTs !== book.exchangeTs || leg.receivedAt !== book.receivedAt) {
      throw new Error("pairwise leg timestamps must match ordered book provenance");
    }
  }
  const exchangeTimes = provenance.books.map((book) => book.exchangeTs);
  const receivedTimes = provenance.books.map((book) => book.receivedAt);
  const oldestExchangeTs = Math.min(...exchangeTimes);
  const newestExchangeTs = Math.max(...exchangeTimes);
  const oldestReceivedAt = Math.min(...receivedTimes);
  const newestReceivedAt = Math.max(...receivedTimes);
  const quoteAgeMs = Math.max(0, evaluatedAt - oldestExchangeTs, evaluatedAt - oldestReceivedAt);
  const legSkewMs = Math.max(newestExchangeTs - oldestExchangeTs, newestReceivedAt - oldestReceivedAt);
  if (
    timestamps.evaluatedAt !== evaluatedAt ||
    timestamps.oldestExchangeTs !== oldestExchangeTs ||
    timestamps.newestExchangeTs !== newestExchangeTs ||
    timestamps.oldestReceivedAt !== oldestReceivedAt ||
    timestamps.newestReceivedAt !== newestReceivedAt ||
    timestamps.quoteAgeMs !== quoteAgeMs ||
    timestamps.legSkewMs !== legSkewMs
  ) {
    throw new Error("pairwise timestamp aggregates are inconsistent with book provenance");
  }
  if (provenance.assumptions.length === 0) throw new Error("pairwise provenance requires timestamped assumptions");
  const oldestAssumptionAsOf = Math.min(...provenance.assumptions.map((assumption) => assumption.asOf));
  if (timestamps.oldestAssumptionAsOf !== oldestAssumptionAsOf || timestamps.assumptionAgeMs !== Math.max(0, evaluatedAt - oldestAssumptionAsOf)) {
    throw new Error("pairwise assumption timestamp aggregates are inconsistent with provenance");
  }
}

function validatePairwiseEconomicSemantics(value: {
  legs: readonly [PairwiseLegSimulation, PairwiseLegSimulation];
  requestedBaseQuantity: number;
  executableBaseQuantity: number;
  longBaseQuantity: number;
  shortBaseQuantity: number;
  residualBaseQuantity: number;
  unfilledBaseQuantity: number;
  grossEntryPnlQuote: number;
  grossExpectedPnlQuote: number;
  netExpectedPnlQuote: number;
  entryBasisBps: number;
  expectedExitBasisBps: number;
  netReturnBps: number;
  referenceNotionalQuote: number;
  costs: PairwiseCostBreakdown;
  capacityShortfallBaseQuantity: number;
  baseDustQuantity: number;
}) {
  const [long, short] = value.legs;
  assertApproximately(value.longBaseQuantity, long.baseEquivalentQuantity, "longBaseQuantity");
  assertApproximately(value.shortBaseQuantity, short.baseEquivalentQuantity, "shortBaseQuantity");
  assertApproximately(value.executableBaseQuantity, Math.min(value.longBaseQuantity, value.shortBaseQuantity), "executableBaseQuantity");
  assertApproximately(value.residualBaseQuantity, value.longBaseQuantity - value.shortBaseQuantity, "residualBaseQuantity");
  assertApproximately(value.unfilledBaseQuantity, Math.max(0, value.requestedBaseQuantity - value.executableBaseQuantity), "unfilledBaseQuantity");
  assertApproximately(value.unfilledBaseQuantity, value.capacityShortfallBaseQuantity + value.baseDustQuantity, "capacity shortfall and dust");
  assertApproximately(long.quoteNotional, long.averagePrice * long.baseEquivalentQuantity, "long quoteNotional");
  assertApproximately(short.quoteNotional, short.averagePrice * short.baseEquivalentQuantity, "short quoteNotional");
  const longPriceTolerance = 1e-8 * Math.max(1, Math.abs(long.averagePrice));
  const shortPriceTolerance = 1e-8 * Math.max(1, Math.abs(short.averagePrice));
  if (long.worstPrice + longPriceTolerance < long.averagePrice || short.worstPrice - shortPriceTolerance > short.averagePrice) {
    throw new Error("pairwise average/worst prices are inconsistent with leg sides");
  }
  assertApproximately(long.entryFeeQuote, (long.quoteNotional * long.entryFeeBps) / 10_000, "long entryFeeQuote");
  assertApproximately(short.entryFeeQuote, (short.quoteNotional * short.entryFeeBps) / 10_000, "short entryFeeQuote");
  assertApproximately(value.costs.entryFeesQuote, long.entryFeeQuote + short.entryFeeQuote, "entryFeesQuote");
  const referenceNotionalQuote = (long.quoteNotional + short.quoteNotional) / 2;
  const grossEntryPnlQuote = short.quoteNotional - long.quoteNotional;
  const grossExpectedPnlQuote = grossEntryPnlQuote - (referenceNotionalQuote * value.expectedExitBasisBps) / 10_000;
  const netExpectedPnlQuote = grossExpectedPnlQuote - value.costs.entryFeesQuote - value.costs.exitFeesQuote - value.costs.borrowCostQuote - value.costs.deliveryFeesQuote - value.costs.rebalanceCostQuote + value.costs.fundingNetQuote;
  assertApproximately(value.referenceNotionalQuote, referenceNotionalQuote, "referenceNotionalQuote");
  assertApproximately(value.grossEntryPnlQuote, grossEntryPnlQuote, "grossEntryPnlQuote");
  assertApproximately(value.grossExpectedPnlQuote, grossExpectedPnlQuote, "grossExpectedPnlQuote");
  assertApproximately(value.netExpectedPnlQuote, netExpectedPnlQuote, "netExpectedPnlQuote");
  assertApproximately(value.entryBasisBps, (grossEntryPnlQuote / referenceNotionalQuote) * 10_000, "entryBasisBps");
  assertApproximately(value.netReturnBps, (netExpectedPnlQuote / referenceNotionalQuote) * 10_000, "netReturnBps");
}

function assertApproximately(actual: number, expected: number, label: string) {
  const tolerance = 1e-8 * Math.max(1, Math.abs(expected));
  if (Math.abs(actual - expected) > tolerance) throw new Error(`pairwise ${label} is inconsistent`);
}

function parsePairwiseProvenance(value: unknown, evaluatedAt: number): PairwiseProvenance {
  const row = record(value, "pairwise provenance");
  const rawMetadataIds = array(row.metadataIds, "metadataIds", 2);
  const rawBooks = array(row.books, "provenance.books", 2);
  if (rawMetadataIds.length !== 2 || rawBooks.length !== 2) throw new Error("pairwise provenance requires exactly two metadata and book records");
  return {
    engine: exact(row.engine, ["pairwise-v1"] as const, "provenance.engine"),
    routeId: text(row.routeId, "provenance.routeId"),
    metadataIds: [text(rawMetadataIds[0], "metadataIds[0]"), text(rawMetadataIds[1], "metadataIds[1]")],
    economicIdentity: parseEconomicIdentityProvenance(row.economicIdentity, evaluatedAt),
    books: [parsePairwiseBookProvenance(rawBooks[0]), parsePairwiseBookProvenance(rawBooks[1])],
    assumptions: array(row.assumptions, "provenance.assumptions", 20).map((value) => {
      const assumption = record(value, "provenance assumption");
      return { kind: text(assumption.kind, "assumption.kind"), source: text(assumption.source, "assumption.source"), asOf: positiveSafeInteger(assumption.asOf, "assumption.asOf") };
    })
  };
}

function parseEconomicIdentityProvenance(value: unknown, evaluatedAt: number): PairwiseProvenance["economicIdentity"] {
  const row = record(value, "pairwise economic identity provenance");
  const rawLegs = array(row.legs, "economicIdentity.legs", 2);
  if (rawLegs.length !== 2) throw new Error("pairwise economic identity provenance requires exactly two legs");
  const maxAgeMs = positiveSafeInteger(row.maxAgeMs, "economicIdentity.maxAgeMs");
  const maxFutureClockSkewMs = safeInteger(row.maxFutureClockSkewMs, "economicIdentity.maxFutureClockSkewMs");
  const parsedLegs = rawLegs.map((value, index) => {
    const identity = record(value, `economicIdentity.legs[${index}]`);
    const review = parseEconomicIdentityReview(identity, `economicIdentity.legs[${index}]`);
    const effectiveValidUntil = positiveSafeInteger(identity.effectiveValidUntil, `economicIdentity.legs[${index}].effectiveValidUntil`);
    const expectedBoundary = Math.min(review.validUntil, review.asOf + maxAgeMs);
    if (effectiveValidUntil !== expectedBoundary) throw new Error("pairwise economic identity effective validity boundary is inconsistent");
    if (review.asOf > evaluatedAt + maxFutureClockSkewMs) throw new Error("pairwise economic identity asOf exceeds its future-clock boundary");
    if (evaluatedAt > effectiveValidUntil) throw new Error("pairwise economic identity provenance is stale or expired");
    return { instrumentId: nonBlankText(identity.instrumentId, `economicIdentity.legs[${index}].instrumentId`), ...review, effectiveValidUntil };
  });
  return {
    economicAssetId: parseEconomicAssetId(row.economicAssetId, "economicIdentity.economicAssetId"),
    matchPolicy: exact(row.matchPolicy, ["exact"] as const, "economicIdentity.matchPolicy"),
    authority: exact(row.authority, ["caller-supplied"] as const, "economicIdentity.authority"),
    maxAgeMs,
    maxFutureClockSkewMs,
    legs: [parsedLegs[0]!, parsedLegs[1]!]
  };
}

function parseEconomicIdentityReview(value: unknown, label: string) {
  const row = record(value, label);
  const asOf = positiveSafeInteger(row.asOf, `${label}.asOf`);
  const validUntil = positiveSafeInteger(row.validUntil, `${label}.validUntil`);
  if (validUntil < asOf) throw new Error(`${label}.validUntil must be at or after asOf`);
  return {
    status: exact(row.status, ["reviewed"] as const, `${label}.status`),
    source: nonBlankText(row.source, `${label}.source`),
    version: nonBlankText(row.version, `${label}.version`),
    asOf,
    validUntil
  };
}

function parseEconomicAssetId(value: unknown, label: string) {
  const parsed = nonBlankText(value, label);
  if (!ECONOMIC_ASSET_ID.test(parsed)) throw new Error(`${label} must use the lowercase namespace:value format`);
  return parsed;
}

function nonBlankText(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!parsed.trim()) throw new Error(`${label} must be non-empty`);
  return parsed;
}

function safeInteger(value: unknown, label: string) {
  const parsed = integer(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function positiveSafeInteger(value: unknown, label: string) {
  const parsed = safeInteger(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function parsePairwiseBookProvenance(value: unknown): PairwiseBookProvenance {
  const row = record(value, "pairwise book provenance");
  const sequence = row.sequence === undefined ? undefined : integer(row.sequence, "sequence");
  return {
    instrumentId: text(row.instrumentId, "instrumentId"),
    source: exact(row.source, ["websocket", "rest", "fixture"] as const, "source"),
    sourceId: text(row.sourceId, "sourceId"),
    ...(sequence === undefined ? {} : { sequence }),
    exchangeTs: positiveSafeInteger(row.exchangeTs, "exchangeTs"),
    receivedAt: positiveSafeInteger(row.receivedAt, "receivedAt")
  };
}

function parsePairwiseRejection(value: unknown): PairwiseRejection {
  const row = record(value, "pairwise rejection");
  const routeId = optionalText(row.routeId, "routeId");
  const instrumentId = optionalText(row.instrumentId, "instrumentId");
  return {
    ...(routeId === undefined ? {} : { routeId }),
    ...(instrumentId === undefined ? {} : { instrumentId }),
    code: exact(row.code, PAIRWISE_REJECTION_CODES, "rejection.code"),
    message: text(row.message, "rejection.message")
  };
}

function exactFalse(value: unknown, label: string): false {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
}
