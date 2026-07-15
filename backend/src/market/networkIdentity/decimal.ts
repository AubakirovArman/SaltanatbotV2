import type { DecimalString } from "./types.js";

const MAX_INTEGER_DIGITS = 30;

export function decimalUnits(value: DecimalString, decimals: number, label: string): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new TypeError(`${label} quantityDecimals is invalid`);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new TypeError(`${label} must be an unsigned canonical decimal string`);
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  if (whole.length > MAX_INTEGER_DIGITS) throw new TypeError(`${label} exceeds the supported magnitude`);
  if (fraction.length > decimals) throw new TypeError(`${label} exceeds ${decimals} decimal places`);
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatDecimal(units: bigint, decimals: number): DecimalString {
  if (units < 0n) throw new TypeError("decimal units cannot be negative");
  if (decimals === 0) return units.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function percentageFeeUnits(amount: bigint, percentageBps: number): bigint {
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 0 || percentageBps > 10_000) throw new TypeError("percentageBps is invalid");
  const numerator = amount * BigInt(percentageBps);
  return numerator === 0n ? 0n : (numerator + 9_999n) / 10_000n;
}
