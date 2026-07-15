import type { ArbitrageOrderBook } from "./depthBook.js";
import type { ArbitrageDepthBookTiming, ArbitrageDepthResponse, ArbitrageDepthTiming } from "./types.js";

export const MAX_ARBITRAGE_DEPTH_AGE_MS = 10_000;
export const MAX_ARBITRAGE_DEPTH_LEG_SKEW_MS = 3_000;
export const MAX_ARBITRAGE_DEPTH_FUTURE_CLOCK_SKEW_MS = 1_000;

/** Re-evaluates cached response age without changing either book's source timestamps. */
export function refreshDepthTiming(value: ArbitrageDepthResponse, evaluatedAt: number): ArbitrageDepthResponse {
  const timing = buildDepthTiming(timingBook(value.timing.spot), timingBook(value.timing.perpetual), evaluatedAt);
  return { ...value, timing, complete: value.complete && timing.exchangeTimestampsVerified && timing.sequenceContinuityVerified && timing.quality === "fresh", capturedAt: evaluatedAt };
}

export function buildDepthTiming(spotBook: ArbitrageOrderBook, perpetualBook: ArbitrageOrderBook, evaluatedAt: number): ArbitrageDepthTiming {
  const spot = bookTiming(spotBook, evaluatedAt);
  const perpetual = bookTiming(perpetualBook, evaluatedAt);
  const localTimestampsVerified = validTimestamp(evaluatedAt) && validTimestamp(spotBook.receivedAt) && spotBook.receivedAt <= evaluatedAt && validTimestamp(perpetualBook.receivedAt) && perpetualBook.receivedAt <= evaluatedAt;
  const suppliedExchangeTimestampsValid = (spotBook.exchangeTs === undefined || validTimestamp(spotBook.exchangeTs)) && (perpetualBook.exchangeTs === undefined || validTimestamp(perpetualBook.exchangeTs));
  const receiveSkewMs = localTimestampsVerified ? Math.abs(spot.receivedAt - perpetual.receivedAt) : Number.MAX_SAFE_INTEGER;
  const spotExchangeTs = spot.exchangeTs;
  const perpetualExchangeTs = perpetual.exchangeTs;
  const exchangeTimestampsVerified = validTimestamp(spotExchangeTs) && validTimestamp(perpetualExchangeTs);
  const sequenceContinuityVerified = spotBook.sequenceVerified === true && perpetualBook.sequenceVerified === true && validSequence(spotBook.sequence) && validSequence(perpetualBook.sequence);
  const exchangeTimestampsPlausible = timestampWithinFutureBoundary(spotExchangeTs, evaluatedAt) && timestampWithinFutureBoundary(perpetualExchangeTs, evaluatedAt);
  const exchangeSkewMs = validTimestamp(spotExchangeTs) && validTimestamp(perpetualExchangeTs) ? Math.abs(spotExchangeTs - perpetualExchangeTs) : undefined;
  const legSkewMs = Math.max(receiveSkewMs, exchangeSkewMs ?? 0);
  const ageMs = Math.max(spot.ageMs, perpetual.ageMs);
  const quality = !localTimestampsVerified || !suppliedExchangeTimestampsValid || !exchangeTimestampsVerified || !exchangeTimestampsPlausible || !sequenceContinuityVerified ? "unverified" : ageMs > MAX_ARBITRAGE_DEPTH_AGE_MS ? "stale" : legSkewMs > MAX_ARBITRAGE_DEPTH_LEG_SKEW_MS ? "skewed" : "fresh";
  return {
    spot,
    perpetual,
    ageMs,
    receiveSkewMs,
    ...(exchangeSkewMs === undefined ? {} : { exchangeSkewMs }),
    legSkewMs,
    exchangeTimestampsVerified,
    sequenceContinuityVerified,
    quality
  };
}

function bookTiming(book: Pick<ArbitrageOrderBook, "exchangeTs" | "receivedAt" | "sequence" | "sequenceVerified" | "source">, evaluatedAt: number): ArbitrageDepthBookTiming {
  const receiveAgeMs = validTimestamp(book.receivedAt) && validTimestamp(evaluatedAt) ? Math.max(0, evaluatedAt - book.receivedAt) : Number.MAX_SAFE_INTEGER;
  const exchangeAgeMs = validTimestamp(book.exchangeTs) && validTimestamp(evaluatedAt) ? Math.max(0, evaluatedAt - book.exchangeTs) : 0;
  return {
    ...(validTimestamp(book.exchangeTs) ? { exchangeTs: book.exchangeTs } : {}),
    receivedAt: book.receivedAt,
    ageMs: Math.max(receiveAgeMs, exchangeAgeMs),
    ...(validSequence(book.sequence) ? { sequence: book.sequence } : {}),
    sequenceVerified: book.sequenceVerified === true,
    source: book.source
  };
}

function timingBook(timing: ArbitrageDepthBookTiming): ArbitrageOrderBook {
  return {
    bids: [],
    asks: [],
    source: timing.source,
    sequenceVerified: timing.sequenceVerified,
    ...(timing.exchangeTs === undefined ? {} : { exchangeTs: timing.exchangeTs }),
    receivedAt: timing.receivedAt,
    ...(timing.sequence === undefined ? {} : { sequence: timing.sequence })
  };
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSequence(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestampWithinFutureBoundary(value: number | undefined, evaluatedAt: number) {
  return validTimestamp(value) && value <= evaluatedAt + MAX_ARBITRAGE_DEPTH_FUTURE_CLOCK_SKEW_MS;
}
