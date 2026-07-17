import { canonicalAlertDecimal } from "./priceAlertMigration";
import { mergePriceAlertSnapshots, type PriceAlert } from "../market/alerts";

export function prepareLocalSnapshot(current: PriceAlert[], desired: PriceAlert[], stored: PriceAlert[], clock: { current: number }): PriceAlert[] {
  const currentById = new Map(current.map((alert) => [alert.id, alert]));
  const storedById = new Map(stored.map((alert) => [alert.id, alert]));
  clock.current = Math.max(clock.current, Date.now(), ...current.map(({ localRevision }) => localRevision ?? 0), ...stored.map(({ localRevision }) => localRevision ?? 0));
  const stamped = desired.map((alert) => {
    const previous = currentById.get(alert.id);
    const latest = storedById.get(alert.id);
    const rebased = previous && latest && (latest.localRevision ?? 0) > (previous.localRevision ?? 0)
      ? rebaseLocalAlert(previous, alert, latest)
      : alert;
    if (latest && sameLocalAlert(latest, rebased)) return latest;
    if (previous && sameLocalAlert(previous, rebased)) return { ...rebased, ...(previous.localRevision ? { localRevision: previous.localRevision } : {}) };
    clock.current += 1;
    return { ...rebased, localRevision: clock.current };
  });
  return mergePriceAlertSnapshots(stored, stamped);
}

export function sameLocalSnapshot(left: PriceAlert[], right: PriceAlert[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isOwnerStorageMessage(value: unknown, ownerId: string | undefined): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).ownerId === (ownerId ?? null);
}

export function validateAlertThresholdPrecision(value: number, decimals: number): void {
  const canonical = canonicalAlertDecimal(value);
  const supportedDecimals = Number.isSafeInteger(decimals) ? Math.max(0, Math.min(18, decimals)) : 18;
  const fractionDigits = canonical.split(".")[1]?.length ?? 0;
  if (fractionDigits > supportedDecimals) throw new Error(`Alert price supports at most ${supportedDecimals} decimal places for this instrument.`);
}

/**
 * Parses the text the user actually entered instead of first coercing it to an
 * IEEE-754 number. The exact decimal must survive that conversion unchanged;
 * otherwise an alert could be armed at a subtly different price.
 */
export function parseAlertThresholdInput(raw: string, decimals: number): number {
  const normalized = normalizePositiveDecimalInput(raw);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Alert price must be a positive finite number.");
  if (canonicalAlertDecimal(value) !== normalized) {
    throw new Error("Alert price cannot be represented exactly at the supported precision.");
  }
  validateAlertThresholdPrecision(value, decimals);
  return value;
}

function normalizePositiveDecimalInput(raw: string): string {
  if (raw.length === 0 || raw.length > 128 || raw !== raw.trim()) {
    throw new Error("Alert price is not a supported decimal.");
  }
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match || match[1] === "-") throw new Error("Alert price is not a supported positive decimal.");

  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error("Alert price exponent is outside the supported range.");
  }

  let digits = `${integer}${fraction}`;
  let decimalIndex = integer.length + exponent;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero < 0) throw new Error("Alert price must be greater than zero.");
  digits = digits.slice(firstNonZero);
  decimalIndex -= firstNonZero;

  let normalizedInteger: string;
  let normalizedFraction: string;
  if (decimalIndex <= 0) {
    const fractionLength = -decimalIndex + digits.length;
    if (fractionLength > 18) throw new Error("Alert price exceeds the supported decimal precision.");
    normalizedInteger = "0";
    normalizedFraction = `${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    if (decimalIndex > 40) throw new Error("Alert price exceeds the supported decimal precision.");
    normalizedInteger = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    normalizedFraction = "";
  } else {
    normalizedInteger = digits.slice(0, decimalIndex);
    normalizedFraction = digits.slice(decimalIndex);
  }

  normalizedFraction = normalizedFraction.replace(/0+$/, "");
  if (normalizedInteger.length > 40 || normalizedFraction.length > 18) {
    throw new Error("Alert price exceeds the supported decimal precision.");
  }
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

function rebaseLocalAlert(previous: PriceAlert, desired: PriceAlert, latest: PriceAlert): PriceAlert {
  const result = { ...latest } as Record<string, unknown>;
  const previousRecord = previous as unknown as Record<string, unknown>;
  const desiredRecord = desired as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(previousRecord), ...Object.keys(desiredRecord)])) {
    if (key === "localRevision" || Object.is(previousRecord[key], desiredRecord[key])) continue;
    if (key in desiredRecord) result[key] = desiredRecord[key];
    else delete result[key];
  }
  return result as unknown as PriceAlert;
}

function sameLocalAlert(left: PriceAlert, right: PriceAlert): boolean {
  const { localRevision: _leftRevision, ...leftValue } = left;
  const { localRevision: _rightRevision, ...rightValue } = right;
  return JSON.stringify(leftValue) === JSON.stringify(rightValue);
}
