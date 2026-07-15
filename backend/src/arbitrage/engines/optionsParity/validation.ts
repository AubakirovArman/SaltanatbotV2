import type {
  OptionsParityAssumptions,
  OptionsParityBook,
  OptionsParityEvaluationLimits,
  OptionsParityEvaluationRequest,
  OptionsParityFeeAssumption,
  OptionsParityInstrument,
  OptionsParityLegSimulation,
  OptionsParityRejection,
  OptionsParitySeriesSnapshot,
  OptionsParityUnderlyingInstrument
} from "./types.js";

const DEFAULTS = {
  maxQuoteAgeMs: 2_000,
  maxLegSkewMs: 250,
  maxFutureClockSkewMs: 1_000,
  maxAssumptionAgeMs: 86_400_000,
  minimumNetEdgeValue: 0,
  pairingIterations: 20
};

export interface OptionsParityPair {
  seriesId: string;
  call: { instrument: OptionsParityInstrument; book: OptionsParityBook };
  put: { instrument: OptionsParityInstrument; book: OptionsParityBook };
}

export function resolvePair(
  snapshot: OptionsParitySeriesSnapshot,
  evaluatedAt: number
): { pair: OptionsParityPair } | { rejection: OptionsParityRejection } {
  if (!snapshot.seriesId?.trim()) return { rejection: rejection("missing-leg", "seriesId is required") };
  if (!snapshot.call?.instrument || !snapshot.call.book || !snapshot.put?.instrument || !snapshot.put.book) {
    return { rejection: { seriesId: snapshot.seriesId, code: "missing-leg", message: "Series requires call/put metadata and both complete book snapshots" } };
  }
  const call = snapshot.call.instrument;
  const put = snapshot.put.instrument;
  if (snapshot.call.book.instrumentId !== call.instrumentId || snapshot.put.book.instrumentId !== put.instrumentId) {
    return { rejection: { seriesId: snapshot.seriesId, code: "identity-mismatch", message: "Book instrument ids must match call/put metadata" } };
  }
  const callProblem = instrumentProblem(call, "call", evaluatedAt);
  if (callProblem) return { rejection: { seriesId: snapshot.seriesId, instrumentId: call.instrumentId, ...callProblem } };
  const putProblem = instrumentProblem(put, "put", evaluatedAt);
  if (putProblem) return { rejection: { seriesId: snapshot.seriesId, instrumentId: put.instrumentId, ...putProblem } };
  const identityProblem = pairIdentityProblem(call, put);
  if (identityProblem) return { rejection: { seriesId: snapshot.seriesId, code: "identity-mismatch", message: identityProblem } };
  return { pair: { seriesId: snapshot.seriesId, call: { instrument: call, book: snapshot.call.book }, put: { instrument: put, book: snapshot.put.book } } };
}

export function resolveUnderlying(
  request: OptionsParityEvaluationRequest,
  pair: OptionsParityPair
):
  | { value: { instrument: OptionsParityUnderlyingInstrument; book: OptionsParityBook } }
  | { rejection: OptionsParityRejection } {
  const instrument = request.underlying?.instrument;
  const book = request.underlying?.book;
  if (!instrument || !book) return { rejection: rejection("missing-leg", "Underlying metadata and executable book are required") };
  if (book.instrumentId !== instrument.instrumentId) return { rejection: rejection("identity-mismatch", "Underlying book instrument id does not match metadata") };
  if (instrument.baseAsset !== pair.call.instrument.underlyingAsset || instrument.quoteAsset !== request.assumptions.valuationAsset) {
    return { rejection: rejection("identity-mismatch", "Underlying base/quote assets do not match the option series and valuation asset") };
  }
  const problem = quantityModelProblem(instrument);
  if (problem) return { rejection: { code: "identity-mismatch", instrumentId: instrument.instrumentId, message: problem } };
  return { value: { instrument, book } };
}

export function validateCommonAssumptions(
  assumptions: OptionsParityAssumptions,
  pair: OptionsParityPair,
  underlying: OptionsParityUnderlyingInstrument,
  evaluatedAt: number,
  limits: Required<OptionsParityEvaluationLimits>
): { values: { source: string; asOf: number }[] } | { rejection: OptionsParityRejection } {
  if (!assumptions || assumptions.valuationAsset !== pair.call.instrument.strikeAsset || underlying.quoteAsset !== assumptions.valuationAsset) {
    return { rejection: rejection("missing-assumption", "valuationAsset must exactly match the strike and underlying quote asset") };
  }
  if (pair.call.instrument.settlementAsset !== assumptions.valuationAsset) {
    return {
      rejection: rejection(
        "settlement-mismatch",
        "settlementAsset must match valuationAsset; settlement FX and expiry cash-flow conversion are not modelled"
      )
    };
  }
  const values = [assumptions.riskFreeRate, assumptions.dividendYield, assumptions.settlement, assumptions.underlyingFee];
  for (const value of values) {
    const problem = sourcedProblem(value, evaluatedAt, limits);
    if (problem) return { rejection: rejection(problem.code, problem.message) };
  }
  if (!Number.isFinite(assumptions.riskFreeRate.annualRate) || !Number.isFinite(assumptions.dividendYield.annualRate)) {
    return { rejection: rejection("missing-assumption", "risk-free and dividend rates must be explicit finite decimals") };
  }
  const settlement = assumptions.settlement;
  if (
    settlement.exerciseStyle !== "european" ||
    settlement.automaticExercise !== true ||
    settlement.holdToExpiry !== true ||
    settlement.economicSettlement !== "cash" ||
    !settlement.settlementPriceSource?.trim()
  ) return { rejection: rejection("settlement-mismatch", "European automatic hold-to-expiry cash-equivalent settlement must be explicit") };
  const processes = new Set([pair.call.instrument.settlementProcess, pair.put.instrument.settlementProcess]);
  if ([...processes].some((process) => !settlement.acknowledgedProcesses.includes(process))) {
    return { rejection: rejection("settlement-mismatch", "Settlement assumption does not acknowledge every option settlement process") };
  }
  const feeProblem = feeAssumptionProblem(assumptions.underlyingFee, evaluatedAt, limits);
  if (feeProblem) return { rejection: rejection(feeProblem.code, feeProblem.message) };
  return { values };
}

export function crossSeriesProblem(left: OptionsParityPair, right: OptionsParityPair) {
  const a = left.call.instrument;
  const b = right.call.instrument;
  const ids = [left.call.instrument.instrumentId, left.put.instrument.instrumentId, right.call.instrument.instrumentId, right.put.instrument.instrumentId];
  if (new Set(ids).size !== ids.length) return "Box legs must have four distinct instrument ids";
  if (a.strikePrice === b.strikePrice) return "Box requires two distinct strikes";
  if (
    a.underlyingAsset !== b.underlyingAsset ||
    a.expiryTime !== b.expiryTime ||
    a.strikeAsset !== b.strikeAsset ||
    a.settlementAsset !== b.settlementAsset ||
    a.settlementProcess !== b.settlementProcess
  ) return "Box series must share underlying, expiry, strike asset, settlement asset and settlement process";
  return undefined;
}

export function firstBookProblem(books: OptionsParityBook[], evaluatedAt: number, limits: Required<OptionsParityEvaluationLimits>) {
  for (const book of books) {
    const problem = bookProblem(book, evaluatedAt, limits);
    if (problem) return problem;
  }
  const exchange = books.map((book) => book.exchangeTs);
  const received = books.map((book) => book.receivedAt);
  const skew = Math.max(Math.max(...exchange) - Math.min(...exchange), Math.max(...received) - Math.min(...received));
  return skew > limits.maxLegSkewMs ? rejection("skewed-books", `Leg timestamp skew is ${skew} ms`) : undefined;
}

export function feeAssumptionProblem(
  value: OptionsParityFeeAssumption | undefined,
  evaluatedAt: number,
  limits: Required<OptionsParityEvaluationLimits>
) {
  const sourced = sourcedProblem(value, evaluatedAt, limits);
  if (sourced) return sourced;
  const model = value!.model;
  if (!model || (model.kind !== "notional-bps" && model.kind !== "per-base-capped")) return { code: "missing-assumption" as const, message: "Fee model is required" };
  if (model.kind === "notional-bps" && (!nonNegative(model.bps) || model.bps > 10_000)) {
    return { code: "missing-assumption" as const, message: "Fee bps must be between 0 and 10000" };
  }
  if (model.kind === "per-base-capped" && (!nonNegative(model.feePerBaseValuation) || !nonNegative(model.premiumCapFraction) || model.premiumCapFraction > 1)) {
    return { code: "missing-assumption" as const, message: "Per-base capped fee inputs are invalid" };
  }
  return undefined;
}

export function fxAssumptionProblem(
  value: OptionsParityAssumptions["premiumFx"][string],
  from: string,
  to: string,
  evaluatedAt: number,
  limits: Required<OptionsParityEvaluationLimits>
) {
  const sourced = sourcedProblem(value, evaluatedAt, limits);
  if (sourced) return sourced;
  if (value!.fromAsset !== from || value!.toAsset !== to || !positive(value!.rate)) {
    return { code: "missing-assumption" as const, message: `Explicit ${from}->${to} premium conversion is required` };
  }
  if (from === to && value!.rate !== 1) return { code: "missing-assumption" as const, message: "Identity premium conversion must equal 1" };
  return undefined;
}

export function sourcedProblem(
  value: { source: string; asOf: number } | undefined,
  evaluatedAt: number,
  limits: Required<OptionsParityEvaluationLimits>
) {
  if (!value?.source?.trim() || !positiveTimestamp(value.asOf)) return { code: "missing-assumption" as const, message: "Assumption source and timestamp are required" };
  if (value.asOf > evaluatedAt + limits.maxFutureClockSkewMs) return { code: "stale-assumption" as const, message: "Assumption timestamp exceeds the future-clock boundary" };
  if (evaluatedAt - value.asOf > limits.maxAssumptionAgeMs) return { code: "stale-assumption" as const, message: "Assumption is stale" };
  return undefined;
}

export function timestampMetrics(legs: OptionsParityLegSimulation[], assumptions: { asOf: number }[], evaluatedAt: number) {
  const exchange = legs.map((leg) => leg.exchangeTs);
  const received = legs.map((leg) => leg.receivedAt);
  const oldestExchangeTs = Math.min(...exchange);
  const newestExchangeTs = Math.max(...exchange);
  const oldestReceivedAt = Math.min(...received);
  const newestReceivedAt = Math.max(...received);
  const oldestAssumptionAsOf = Math.min(...assumptions.map((value) => value.asOf));
  return {
    evaluatedAt,
    oldestExchangeTs,
    newestExchangeTs,
    oldestReceivedAt,
    newestReceivedAt,
    quoteAgeMs: Math.max(0, evaluatedAt - oldestExchangeTs, evaluatedAt - oldestReceivedAt),
    legSkewMs: Math.max(newestExchangeTs - oldestExchangeTs, newestReceivedAt - oldestReceivedAt),
    oldestAssumptionAsOf,
    assumptionAgeMs: Math.max(0, evaluatedAt - oldestAssumptionAsOf)
  };
}

export function normalizedLimits(value: OptionsParityEvaluationLimits | undefined): Required<OptionsParityEvaluationLimits> {
  return {
    maxQuoteAgeMs: positiveOr(value?.maxQuoteAgeMs, DEFAULTS.maxQuoteAgeMs),
    maxLegSkewMs: positiveOr(value?.maxLegSkewMs, DEFAULTS.maxLegSkewMs),
    maxFutureClockSkewMs: positiveOr(value?.maxFutureClockSkewMs, DEFAULTS.maxFutureClockSkewMs),
    maxAssumptionAgeMs: positiveOr(value?.maxAssumptionAgeMs, DEFAULTS.maxAssumptionAgeMs),
    minimumNetEdgeValue: nonNegativeOr(value?.minimumNetEdgeValue, DEFAULTS.minimumNetEdgeValue),
    pairingIterations: Math.max(4, Math.min(64, Math.floor(positiveOr(value?.pairingIterations, DEFAULTS.pairingIterations))))
  };
}

function instrumentProblem(instrument: OptionsParityInstrument, expectedType: "call" | "put", evaluatedAt: number) {
  if (instrument.optionType !== expectedType) return { code: "identity-mismatch" as const, message: `Expected ${expectedType} option metadata` };
  if (instrument.exerciseStyle !== "european" || instrument.automaticExercise !== true) {
    return { code: "unsupported-exercise" as const, message: "Only European automatically exercised options are supported" };
  }
  if (!positiveTimestamp(instrument.expiryTime) || instrument.expiryTime <= evaluatedAt) return { code: "expired" as const, message: "Option expiry must be in the future" };
  if (!positive(instrument.strikePrice)) return { code: "identity-mismatch" as const, message: "Option strike must be positive" };
  const quantityProblem = quantityModelProblem(instrument);
  return quantityProblem ? { code: "identity-mismatch" as const, message: quantityProblem } : undefined;
}

function quantityModelProblem(instrument: OptionsParityInstrument | OptionsParityUnderlyingInstrument) {
  if (!instrument.instrumentId?.trim() || !positive(instrument.quantityStep) || !positive(instrument.minimumQuantity)) return "Instrument quantity metadata is incomplete";
  if (!positive(instrument.basePerQuantityUnit)) return "basePerQuantityUnit must be positive";
  if (instrument.quantityUnit === "base" && instrument.basePerQuantityUnit !== 1) return "Base-unit books must use basePerQuantityUnit=1";
  return undefined;
}

function pairIdentityProblem(call: OptionsParityInstrument, put: OptionsParityInstrument) {
  if (call.instrumentId === put.instrumentId) return "Call and put instrument ids must be distinct";
  if (
    call.underlyingAsset !== put.underlyingAsset ||
    call.expiryTime !== put.expiryTime ||
    call.strikePrice !== put.strikePrice ||
    call.strikeAsset !== put.strikeAsset ||
    call.settlementAsset !== put.settlementAsset ||
    call.settlementProcess !== put.settlementProcess
  ) return "Call and put must have identical underlying, expiry, strike, strike asset, settlement asset and settlement process";
  return undefined;
}

function bookProblem(book: OptionsParityBook, evaluatedAt: number, limits: Required<OptionsParityEvaluationLimits>): OptionsParityRejection | undefined {
  if (!book || !book.instrumentId?.trim()) return rejection("missing-leg", "Book and instrumentId are required");
  if (book.complete !== true) return { instrumentId: book.instrumentId, code: "incomplete-book", message: "Only complete depth snapshots are accepted" };
  if (!positiveTimestamp(book.exchangeTs) || !positiveTimestamp(book.receivedAt)) return { instrumentId: book.instrumentId, code: "invalid-book", message: "Book timestamps must be positive" };
  if (book.exchangeTs > evaluatedAt + limits.maxFutureClockSkewMs || book.receivedAt > evaluatedAt + limits.maxFutureClockSkewMs) {
    return { instrumentId: book.instrumentId, code: "invalid-book", message: "Book timestamp exceeds the future-clock boundary" };
  }
  const age = Math.max(evaluatedAt - book.exchangeTs, evaluatedAt - book.receivedAt);
  if (age > limits.maxQuoteAgeMs) return { instrumentId: book.instrumentId, code: "stale-book", message: `Book is ${age} ms old` };
  const bidProblem = sideProblem(book.bids, "bid");
  const askProblem = sideProblem(book.asks, "ask");
  if (bidProblem || askProblem || book.bids[0]![0] >= book.asks[0]![0]) {
    return { instrumentId: book.instrumentId, code: "invalid-book", message: bidProblem ?? askProblem ?? "Book is crossed or locked" };
  }
  return undefined;
}

function sideProblem(levels: readonly (readonly [number, number])[], side: "bid" | "ask") {
  if (!Array.isArray(levels) || levels.length === 0) return `${side} side is empty`;
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (!level || level.length !== 2 || !positive(level[0]) || !positive(level[1])) return `${side}[${index}] is invalid`;
    if (index > 0) {
      const previous = levels[index - 1]![0];
      if ((side === "bid" && level[0] >= previous) || (side === "ask" && level[0] <= previous)) return `${side} side is not strictly sorted`;
    }
  }
  return undefined;
}

function rejection(code: OptionsParityRejection["code"], message: string): OptionsParityRejection {
  return { code, message };
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function positiveTimestamp(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveOr(value: number | undefined, fallback: number) {
  return value !== undefined && positive(value) ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number) {
  return value !== undefined && nonNegative(value) ? value : fallback;
}
