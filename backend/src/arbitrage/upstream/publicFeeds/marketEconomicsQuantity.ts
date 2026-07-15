import type { PairwiseInstrument } from "../../engines/pairwise/index.js";
import { lessThanWithTolerance, safePositiveProduct, safePositiveQuotient } from "./marketEconomicsArithmetic.js";
import { CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION, type ContinuousMarketBlockCode, type ContinuousMarketBlockReason, type ContinuousMarketLeg } from "./marketEconomicsTypes.js";
import type { ContinuousTopBook } from "./types.js";

const BPS = 10_000;
const MAX_RATIONAL_EXPONENT = 30;
const MAX_RATIONAL_DIGITS = 120;

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface PairedLegQuantity {
  topNativeQuantity: number;
  alignedNativeCapacity: number;
  alignedBaseCapacity: number;
  usedNativeQuantity: number;
  baseQuantity: number;
  price: number;
}

export interface PairedQuantity {
  commonBaseQuantity: number;
  long: PairedLegQuantity;
  short: PairedLegQuantity;
}

export class QuantityFailure extends Error {
  constructor(
    readonly code: ContinuousMarketBlockCode,
    message: string
  ) {
    super(message);
    this.name = "QuantityFailure";
  }
}

/** Aligns both native top-book capacities to one exact common base step. */
export function pairTopQuantity(long: PairwiseInstrument, short: PairwiseInstrument, longBook: ContinuousTopBook, shortBook: ContinuousTopBook): PairedQuantity {
  const longValues = quantityValues(long, longBook.ask, longBook.askSize);
  const shortValues = quantityValues(short, shortBook.bid, shortBook.bidSize);
  const commonStep = commonRationalStep(longValues.baseStep, shortValues.baseStep);
  const commonUnits = minimumBigInt(floorRatio(longValues.alignedBaseCapacity, commonStep), floorRatio(shortValues.alignedBaseCapacity, commonStep));
  if (commonUnits <= 0n) throw new QuantityFailure("no-common-quantity", "Top books have no exact step-aligned common base quantity");
  const commonBase = multiplyInteger(commonStep, commonUnits);
  return {
    commonBaseQuantity: rationalNumber(commonBase),
    long: pairedLeg(longValues, commonBase),
    short: pairedLeg(shortValues, commonBase)
  };
}

export function minimumReasonsForPair(long: PairwiseInstrument, short: PairwiseInstrument, pair: PairedQuantity) {
  const reasons: ContinuousMarketBlockReason[] = [];
  for (const [instrument, leg] of [
    [long, pair.long],
    [short, pair.short]
  ] as const) {
    if (lessThanWithTolerance(leg.usedNativeQuantity, instrument.minimumQuantity)) {
      reasons.push(marketReason("minimum-quantity", instrument.instrumentId, "Common top-book quantity is below the venue minimum quantity"));
    }
    const quoteNotional = safePositiveProduct(leg.baseQuantity, leg.price, `${instrument.instrumentId} minimum-notional basis`);
    if (lessThanWithTolerance(quoteNotional, instrument.minimumNotional)) {
      reasons.push(marketReason("minimum-notional", instrument.instrumentId, "Common top-book quantity is below the venue minimum notional"));
    }
  }
  return reasons;
}

export function marketLeg(role: "long" | "short", instrument: PairwiseInstrument, book: ContinuousTopBook, quantity: PairedLegQuantity): ContinuousMarketLeg {
  const quoteNotional = safePositiveProduct(quantity.baseQuantity, quantity.price, `${instrument.instrumentId} quote notional`);
  const publicEntryFeeQuoteEquivalentEstimate = instrument.takerFeeBps === 0 ? 0 : safePositiveQuotient(safePositiveProduct(quoteNotional, instrument.takerFeeBps, `${instrument.instrumentId} public entry fee numerator`), BPS, `${instrument.instrumentId} public entry fee quote-equivalent estimate`);
  const quality = book.continuity.kind as "sequence-verified" | "checksum-verified";
  return {
    role,
    side: role === "long" ? "buy" : "sell",
    instrumentId: instrument.instrumentId,
    venue: instrument.venue,
    symbol: instrument.symbol,
    marketType: instrument.marketType,
    quantityUnit: instrument.quantityModel.unit,
    price: quantity.price,
    topNativeQuantity: quantity.topNativeQuantity,
    alignedNativeCapacity: quantity.alignedNativeCapacity,
    usedNativeQuantity: quantity.usedNativeQuantity,
    baseQuantity: quantity.baseQuantity,
    quoteNotional,
    takerFeeBps: instrument.takerFeeBps,
    publicEntryFeeQuoteEquivalentEstimate,
    feeAssumption: {
      policyVersion: CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION,
      source: "operator-environment",
      accountTierVerified: false,
      discountsApplied: false,
      rebatesApplied: false,
      feeAssetVerified: false,
      exposureImpactIncluded: false
    },
    bookEvidence: {
      sourceId: `${book.venue}:public-websocket:${book.instrumentId}:${book.continuity.protocol}:generation-${book.connectionGeneration}`,
      quality,
      protocol: book.continuity.protocol,
      sequence: book.continuity.kind === "sequence-verified" || book.continuity.kind === "checksum-verified" ? book.continuity.sequence : 0,
      ...(book.continuity.kind === "checksum-verified" ? { checksum: book.continuity.checksum } : {}),
      connectionGeneration: book.connectionGeneration,
      exchangeTs: book.exchangeTs,
      receivedAt: book.receivedAt
    }
  };
}

function quantityValues(instrument: PairwiseInstrument, price: number, topNativeQuantity: number) {
  const nativeStep = rational(instrument.quantityStep);
  const basePerNative =
    instrument.quantityModel.unit === "base"
      ? rational(1)
      : instrument.quantityModel.unit === "quote"
        ? divideRational(rational(1), rational(price))
        : instrument.quantityModel.multiplierAsset === "base"
          ? rational(instrument.quantityModel.contractMultiplier)
          : (() => {
              throw new QuantityFailure("unsupported-quantity-precision", "Quote-valued contract quantity requires an explicit settlement/FX model");
            })();
  const topNative = rational(topNativeQuantity);
  const alignedNativeUnits = floorRatio(topNative, nativeStep);
  if (alignedNativeUnits <= 0n) throw new QuantityFailure("no-common-quantity", `Top book ${instrument.instrumentId} has no native step-aligned capacity`);
  const alignedNativeCapacity = multiplyInteger(nativeStep, alignedNativeUnits);
  const baseStep = multiplyRational(nativeStep, basePerNative);
  return {
    price,
    topNativeQuantity,
    nativeStep,
    basePerNative,
    baseStep,
    alignedNativeCapacity,
    alignedBaseCapacity: multiplyRational(alignedNativeCapacity, basePerNative)
  };
}

function pairedLeg(values: ReturnType<typeof quantityValues>, commonBase: Rational): PairedLegQuantity {
  const usedNative = divideRational(commonBase, values.basePerNative);
  if (divideRational(usedNative, values.nativeStep).denominator !== 1n) {
    throw new QuantityFailure("no-common-quantity", "Common base quantity is not an exact native-step multiple");
  }
  return {
    topNativeQuantity: values.topNativeQuantity,
    alignedNativeCapacity: rationalNumber(values.alignedNativeCapacity),
    alignedBaseCapacity: rationalNumber(values.alignedBaseCapacity),
    usedNativeQuantity: rationalNumber(usedNative),
    baseQuantity: rationalNumber(commonBase),
    price: values.price
  };
}

function commonRationalStep(left: Rational, right: Rational): Rational {
  const denominator = lcm(left.denominator, right.denominator);
  const leftUnits = left.numerator * (denominator / left.denominator);
  const rightUnits = right.numerator * (denominator / right.denominator);
  return normalized({ numerator: lcm(leftUnits, rightUnits), denominator });
}

function rational(value: number): Rational {
  if (!Number.isFinite(value) || value <= 0) throw new QuantityFailure("unsupported-quantity-precision", "Quantity inputs must be finite positive numbers");
  const [coefficient, exponentText = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_RATIONAL_EXPONENT) {
    throw new QuantityFailure("unsupported-quantity-precision", "Quantity exponent exceeds the bounded rational model");
  }
  const [whole = "", fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  if (digits.length > MAX_RATIONAL_EXPONENT) throw new QuantityFailure("unsupported-quantity-precision", "Quantity precision exceeds the bounded rational model");
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  return normalized({ numerator, denominator });
}

function normalized(value: Rational): Rational {
  if (value.numerator <= 0n || value.denominator <= 0n) throw new QuantityFailure("unsupported-quantity-precision", "Rational quantity must be positive");
  const divisor = gcd(value.numerator, value.denominator);
  const result = { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
  if (result.numerator.toString().length + result.denominator.toString().length > MAX_RATIONAL_DIGITS) {
    throw new QuantityFailure("unsupported-quantity-precision", "Common quantity exceeds the bounded rational model");
  }
  return result;
}

function multiplyRational(left: Rational, right: Rational) {
  return normalized({ numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator });
}

function divideRational(left: Rational, right: Rational) {
  return normalized({ numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator });
}

function multiplyInteger(value: Rational, multiplier: bigint) {
  return normalized({ numerator: value.numerator * multiplier, denominator: value.denominator });
}

function floorRatio(left: Rational, right: Rational) {
  return (left.numerator * right.denominator) / (left.denominator * right.numerator);
}

function rationalNumber(value: Rational) {
  const result = Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(result) || result <= 0) throw new QuantityFailure("unsupported-quantity-precision", "Common quantity cannot be represented as a finite number");
  return result;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function lcm(left: bigint, right: bigint) {
  return (left / gcd(left, right)) * right;
}

function minimumBigInt(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function marketReason(code: ContinuousMarketBlockCode, subject: string, message: string): ContinuousMarketBlockReason {
  return { code, stage: "market-data", subject, message };
}
