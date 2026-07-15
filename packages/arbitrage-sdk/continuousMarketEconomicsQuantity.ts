const MAX_RATIONAL_EXPONENT = 30;
const MAX_RATIONAL_DIGITS = 120;

export interface ContinuousQuantityInstrument {
  quantityModel: { unit: "base" } | { unit: "quote" } | { unit: "contract"; contractMultiplier: number; multiplierAsset: "base" | "quote" };
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
}

export interface ContinuousQuantityBook {
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
}

export interface ContinuousExpectedLegQuantity {
  topNativeQuantity: number;
  alignedNativeCapacity: number;
  alignedBaseCapacity: number;
  usedNativeQuantity: number;
  baseQuantity: number;
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export function expectedContinuousPairQuantities(long: ContinuousQuantityInstrument, short: ContinuousQuantityInstrument, longBook: ContinuousQuantityBook, shortBook: ContinuousQuantityBook) {
  const longValues = quantityValues(long, longBook.ask, longBook.askSize);
  const shortValues = quantityValues(short, shortBook.bid, shortBook.bidSize);
  const commonStep = commonRationalStep(longValues.baseStep, shortValues.baseStep);
  const commonUnits = minimumBigInt(floorRatio(longValues.alignedBaseCapacityRational, commonStep), floorRatio(shortValues.alignedBaseCapacityRational, commonStep));
  if (commonUnits <= 0n) throw new Error("continuous market common quantity is invalid");
  const commonBase = multiplyInteger(commonStep, commonUnits);
  const longExpected = expectedLegQuantity(longValues, commonBase);
  const shortExpected = expectedLegQuantity(shortValues, commonBase);
  if (
    longExpected.usedNativeQuantity + tolerance(longExpected.usedNativeQuantity) < long.minimumQuantity ||
    shortExpected.usedNativeQuantity + tolerance(shortExpected.usedNativeQuantity) < short.minimumQuantity ||
    longExpected.baseQuantity * longBook.ask + tolerance(longExpected.baseQuantity * longBook.ask) < long.minimumNotional ||
    shortExpected.baseQuantity * shortBook.bid + tolerance(shortExpected.baseQuantity * shortBook.bid) < short.minimumNotional
  ) {
    throw new Error("continuous market-only quantity violates venue minimums");
  }
  return { commonBaseQuantity: rationalNumber(commonBase), long: longExpected, short: shortExpected };
}

function quantityValues(instrument: ContinuousQuantityInstrument, price: number, topNativeQuantity: number) {
  const nativeStep = rational(instrument.quantityStep);
  const quantityModel = instrument.quantityModel;
  const basePerNative =
    quantityModel.unit === "base"
      ? rational(1)
      : quantityModel.unit === "quote"
        ? divideRational(rational(1), rational(price))
        : quantityModel.multiplierAsset === "base"
          ? rational(quantityModel.contractMultiplier)
          : (() => {
              throw new Error("continuous market quote-valued contract quantity is unsupported");
            })();
  const topNative = rational(topNativeQuantity);
  const alignedNativeUnits = floorRatio(topNative, nativeStep);
  if (alignedNativeUnits <= 0n) throw new Error("continuous market top book has no step-aligned capacity");
  const alignedNativeCapacity = multiplyInteger(nativeStep, alignedNativeUnits);
  const baseStep = multiplyRational(nativeStep, basePerNative);
  return { topNativeQuantity, nativeStep, basePerNative, baseStep, alignedNativeCapacity, alignedBaseCapacityRational: multiplyRational(alignedNativeCapacity, basePerNative) };
}

function expectedLegQuantity(values: ReturnType<typeof quantityValues>, commonBase: Rational): ContinuousExpectedLegQuantity {
  const usedNative = divideRational(commonBase, values.basePerNative);
  if (divideRational(usedNative, values.nativeStep).denominator !== 1n) throw new Error("continuous market common quantity is not native-step aligned");
  return {
    topNativeQuantity: values.topNativeQuantity,
    alignedNativeCapacity: rationalNumber(values.alignedNativeCapacity),
    alignedBaseCapacity: rationalNumber(values.alignedBaseCapacityRational),
    usedNativeQuantity: rationalNumber(usedNative),
    baseQuantity: rationalNumber(commonBase)
  };
}

function commonRationalStep(left: Rational, right: Rational): Rational {
  const denominator = lcm(left.denominator, right.denominator);
  const leftUnits = left.numerator * (denominator / left.denominator);
  const rightUnits = right.numerator * (denominator / right.denominator);
  return normalized({ numerator: lcm(leftUnits, rightUnits), denominator });
}

function rational(value: number): Rational {
  if (!Number.isFinite(value) || value <= 0) throw new Error("continuous market quantity input must be finite and positive");
  const [coefficient, exponentText = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_RATIONAL_EXPONENT) throw new Error("continuous market quantity exponent is unsupported");
  const [whole = "", fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  if (digits.length > MAX_RATIONAL_EXPONENT) throw new Error("continuous market quantity precision is unsupported");
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator *= 10n ** BigInt(-exponent);
  return normalized({ numerator, denominator });
}

function normalized(value: Rational): Rational {
  if (value.numerator <= 0n || value.denominator <= 0n) throw new Error("continuous market rational quantity must be positive");
  const divisor = gcd(value.numerator, value.denominator);
  const result = { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
  if (result.numerator.toString().length + result.denominator.toString().length > MAX_RATIONAL_DIGITS) throw new Error("continuous market rational quantity is too large");
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
  if (!Number.isFinite(result) || result <= 0) throw new Error("continuous market rational quantity cannot be represented");
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

function tolerance(value: number) {
  return Math.max(1e-12, Math.abs(value) * 1e-10);
}
