import { PublicVenueAdapterError } from "../publicTypes.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw validation(`${label} must be a non-empty string`);
  return value;
}

export function instrumentId(value: unknown, label: string): string {
  const parsed = exactString(value, label).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_./:-]{1,99}$/.test(parsed)) throw validation(`${label} has invalid characters`);
  return parsed;
}

export function asset(value: unknown, label: string): string {
  const parsed = exactString(value, label).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.]{0,29}$/.test(parsed)) throw validation(`${label} is not a valid asset code`);
  // Kraken's own specifications state that XBT in the API and BTC in the UI are the same asset.
  return parsed === "XBT" ? "BTC" : parsed;
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

export function integer(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed)) throw validation(`${label} must be a safe integer`);
  return parsed;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw validation(`${label} must be boolean`);
  return value;
}

export function isoTimestamp(value: unknown, label: string): number {
  const text = exactString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw validation(`${label} must be a valid positive ISO timestamp`);
  return timestamp;
}

export function optionalPositiveField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: positive(value, key) } as Record<Key, number>);
}

export function optionalNonNegativeField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: nonNegative(value, key) } as Record<Key, number>);
}

export function validation(message: string): PublicVenueAdapterError {
  return new PublicVenueAdapterError("kraken", "validation", message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
