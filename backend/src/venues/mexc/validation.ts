import { PublicVenueAdapterError } from "../publicTypes.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} must be a non-empty string`);
  return value.trim();
}

export function instrumentId(value: unknown, label: string): string {
  const parsed = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_.:-]{1,79}$/.test(parsed)) throw validation(`${label} has invalid characters`);
  return parsed;
}

export function asset(value: unknown, label: string): string {
  const parsed = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.]{0,29}$/.test(parsed)) throw validation(`${label} is not a valid asset code`);
  return parsed;
}

export function finite(value: unknown, label: string): number {
  if (value === "" || value === null || value === undefined) throw validation(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw validation(`${label} must be finite`);
  return parsed;
}

export function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw validation(`${label} must be positive`);
  return parsed;
}

export function nonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw validation(`${label} must be non-negative`);
  return parsed;
}

export function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validation(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function unsignedBigInteger(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw validation(`${label} must be non-negative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw validation(`${label} must be a non-negative integer`);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw validation(`${label} must be an unsigned integer string up to 30 digits`);
  return BigInt(value);
}

export function positiveMillis(value: unknown, label: string): number {
  return safeInteger(value, label, 1);
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw validation(`${label} must be boolean`);
  return value;
}

export function optionalNonNegative(value: unknown, label: string): number | undefined {
  return value === null || value === undefined || value === "" ? undefined : nonNegative(value, label);
}

export function validation(message: string): PublicVenueAdapterError {
  return new PublicVenueAdapterError("mexc", "validation", message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
