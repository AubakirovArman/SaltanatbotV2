export type PriceThresholdDirection = "above" | "below";

interface DecimalMagnitude {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_DIGITS = 1_000;
const MAX_ABSOLUTE_EXPONENT = 1_000;

/**
 * Compare a finite JavaScript market price by its shortest round-trip decimal
 * representation with the declared threshold decimal. This avoids converting
 * a higher-precision threshold into a rounded IEEE-754 number.
 */
export function priceMatchesThreshold(close: number, threshold: string, direction: PriceThresholdDirection): boolean {
  if (!Number.isFinite(close) || close <= 0) return false;
  const observed = parsePositiveDecimal(String(close));
  const declared = parsePositiveDecimal(threshold);
  if (!observed || !declared) return false;
  const comparison = compareMagnitudes(observed, declared);
  return direction === "above" ? comparison >= 0 : comparison <= 0;
}

function parsePositiveDecimal(value: string): DecimalMagnitude | undefined {
  const matched = DECIMAL.exec(value);
  if (!matched) return undefined;
  const integer = matched[1]!;
  const fraction = matched[2] ?? "";
  const exponentText = matched[3] ?? "0";
  if (integer.length + fraction.length > MAX_DECIMAL_DIGITS || exponentText.length > 6) return undefined;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_ABSOLUTE_EXPONENT) return undefined;

  let digits = `${integer}${fraction}`.replace(/^0+/, "") || "0";
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  while (scale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  const magnitude = BigInt(digits);
  return magnitude > 0n ? { digits: magnitude, scale } : undefined;
}

function compareMagnitudes(left: DecimalMagnitude, right: DecimalMagnitude): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const leftScaled = left.digits * powerOfTen(scale - left.scale);
  const rightScaled = right.digits * powerOfTen(scale - right.scale);
  if (leftScaled === rightScaled) return 0;
  return leftScaled < rightScaled ? -1 : 1;
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}
