import type { PairwiseBookSnapshot, PairwiseDepthLevel, PairwiseInstrument, PairwiseLegSimulation } from "./types.js";

export type PairwisePlanFailure = {
  code: "minimum-quantity" | "minimum-notional" | "insufficient-depth";
  instrumentId: string;
  message: string;
};

export type PairwisePlanResult = { leg: PairwiseLegSimulation } | { failure: PairwisePlanFailure };

/** Converts and walks one native order into base-equivalent and quote quantities. */
export function planPairwiseLeg(
  role: "long" | "short",
  instrument: PairwiseInstrument,
  book: PairwiseBookSnapshot,
  targetBaseQuantity: number
): PairwisePlanResult {
  const side = role === "long" ? "buy" : "sell";
  const levels = role === "long" ? book.asks : book.bids;
  const totalNative = levels.reduce((sum, [, quantity]) => sum + quantity, 0);
  const maxUnits = Math.floor(totalNative / instrument.quantityStep + 1e-10);
  if (!Number.isSafeInteger(maxUnits) || maxUnits <= 0) {
    return failed(instrument, "insufficient-depth", "Visible depth contains no step-aligned native quantity");
  }

  const units = nativeUnitsForBase(instrument, levels, targetBaseQuantity, maxUnits);
  const nativeQuantity = units * instrument.quantityStep;
  if (nativeQuantity + tolerance(nativeQuantity) < instrument.minimumQuantity) {
    return failed(instrument, "minimum-quantity", "Base-equivalent pairing rounds below the venue minimum quantity");
  }
  const walked = walkNative(instrument, levels, nativeQuantity);
  if (!walked) return failed(instrument, "insufficient-depth", "Visible depth cannot fill the step-aligned native quantity");
  if (walked.quoteNotional + tolerance(walked.quoteNotional) < instrument.minimumNotional) {
    return failed(instrument, "minimum-notional", "Rounded leg notional is below the venue minimum");
  }

  return {
    leg: {
      role,
      instrumentId: instrument.instrumentId,
      venue: instrument.venue,
      symbol: instrument.symbol,
      marketType: instrument.marketType,
      side,
      bookSide: role === "long" ? "asks" : "bids",
      nativeQuantity,
      quantityUnit: instrument.quantityModel.unit,
      baseEquivalentQuantity: walked.baseQuantity,
      averagePrice: walked.quoteNotional / walked.baseQuantity,
      worstPrice: walked.worstPrice,
      quoteNotional: walked.quoteNotional,
      entryFeeBps: instrument.takerFeeBps,
      entryFeeQuote: (walked.quoteNotional * instrument.takerFeeBps) / 10_000,
      levelsUsed: walked.levelsUsed,
      depthLimited: walked.baseQuantity + tolerance(targetBaseQuantity) < targetBaseQuantity && units === maxUnits,
      exchangeTs: book.exchangeTs,
      receivedAt: book.receivedAt
    }
  };
}

/** Exact discrete native-unit cap for a spot buy funded by verified quote capital. */
export function affordablePairwiseBaseQuantity(
  instrument: PairwiseInstrument,
  book: PairwiseBookSnapshot,
  targetBaseQuantity: number,
  availableQuoteQuantity: number
): number | undefined {
  const target = planPairwiseLeg("long", instrument, book, targetBaseQuantity);
  if ("failure" in target || target.leg.quoteNotional <= availableQuoteQuantity + tolerance(availableQuoteQuantity)) return undefined;
  const maxUnits = Math.round(target.leg.nativeQuantity / instrument.quantityStep);
  if (!Number.isSafeInteger(maxUnits) || maxUnits <= 0) return 0;
  const levels = book.asks;
  let lower = 0;
  let upper = maxUnits;
  let affordableBase = 0;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const walked = middle === 0 ? undefined : walkNative(instrument, levels, middle * instrument.quantityStep);
    if (walked && walked.quoteNotional <= availableQuoteQuantity + tolerance(availableQuoteQuantity)) {
      affordableBase = walked.baseQuantity;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return affordableBase;
}

function nativeUnitsForBase(
  instrument: PairwiseInstrument,
  levels: readonly PairwiseDepthLevel[],
  targetBaseQuantity: number,
  maxUnits: number
): number {
  const model = instrument.quantityModel;
  if (model.unit === "base" || (model.unit === "contract" && model.multiplierAsset === "base")) {
    const basePerNative = model.unit === "base" ? 1 : model.contractMultiplier;
    return Math.min(maxUnits, Math.max(0, Math.floor(targetBaseQuantity / (instrument.quantityStep * basePerNative) + 1e-10)));
  }

  let lower = 0;
  let upper = maxUnits;
  while (lower < upper) {
    const middle = lower + Math.ceil((upper - lower) / 2);
    const walked = walkNative(instrument, levels, middle * instrument.quantityStep);
    if (walked && walked.baseQuantity <= targetBaseQuantity + tolerance(targetBaseQuantity)) lower = middle;
    else upper = middle - 1;
  }
  return lower;
}

interface WalkedNative {
  baseQuantity: number;
  quoteNotional: number;
  worstPrice: number;
  levelsUsed: number;
}

function walkNative(
  instrument: PairwiseInstrument,
  levels: readonly PairwiseDepthLevel[],
  requestedNative: number
): WalkedNative | undefined {
  let remaining = requestedNative;
  let baseQuantity = 0;
  let quoteNotional = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableNative] of levels) {
    if (remaining <= tolerance(requestedNative)) break;
    const take = Math.min(remaining, availableNative);
    const converted = convertNative(instrument, take, price);
    baseQuantity += converted.base;
    quoteNotional += converted.quote;
    remaining -= take;
    worstPrice = price;
    levelsUsed += 1;
  }
  if (remaining > tolerance(requestedNative) || baseQuantity <= 0 || quoteNotional <= 0) return undefined;
  return { baseQuantity, quoteNotional, worstPrice, levelsUsed };
}

function convertNative(instrument: PairwiseInstrument, nativeQuantity: number, price: number) {
  const model = instrument.quantityModel;
  if (model.unit === "base") return { base: nativeQuantity, quote: nativeQuantity * price };
  if (model.unit === "quote") return { base: nativeQuantity / price, quote: nativeQuantity };
  if (model.multiplierAsset === "base") {
    const base = nativeQuantity * model.contractMultiplier;
    return { base, quote: base * price };
  }
  const quote = nativeQuantity * model.contractMultiplier;
  return { base: quote / price, quote };
}

function failed(
  instrument: PairwiseInstrument,
  code: PairwisePlanFailure["code"],
  message: string
): { failure: PairwisePlanFailure } {
  return { failure: { code, instrumentId: instrument.instrumentId, message } };
}

export function pairwiseTolerance(value: number): number {
  return tolerance(value);
}

function tolerance(value: number): number {
  return Math.max(1e-12, Math.abs(value) * 1e-10);
}
