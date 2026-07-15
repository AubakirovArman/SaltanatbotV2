import { PublicVenueAdapterError } from "../publicTypes.js";

export function dydxValidation(message: string): PublicVenueAdapterError {
  return new PublicVenueAdapterError("dydx", "validation", message);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dydxValidation(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== "string") throw dydxValidation(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw dydxValidation(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
}

export function ticker(value: unknown, label = "ticker"): string {
  const normalized = text(value, label, 80).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}-[A-Z0-9][A-Z0-9._-]{0,39}$/.test(normalized)) {
    throw dydxValidation(`${label} has invalid format`);
  }
  return normalized;
}

export function asset(value: unknown, label: string): string {
  const normalized = text(value, label, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(normalized)) {
    throw dydxValidation(`${label} has invalid format`);
  }
  return normalized;
}

export function finite(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw dydxValidation(`${label} must be finite`);
  return parsed;
}

export function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw dydxValidation(`${label} must be positive`);
  return parsed;
}

export function nonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw dydxValidation(`${label} must be non-negative`);
  return parsed;
}

export function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw dydxValidation(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw dydxValidation(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw dydxValidation(`${label} must be a valid ISO timestamp`);
  return parsed;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
