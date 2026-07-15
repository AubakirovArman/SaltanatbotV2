export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} rows`);
  return value;
}

export function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function optionalText(value: unknown, label: string) {
  if (value === undefined) return undefined;
  return text(value, label);
}

export function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

export function positive(value: unknown, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

export function nonNegative(value: unknown, label: string) {
  const result = finite(value, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}

export function integer(value: unknown, label: string) {
  const result = nonNegative(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be a non-negative integer`);
  return result;
}

export function bool(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function exact<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

export function optionalFinite(value: unknown, label: string) {
  return value === undefined ? undefined : finite(value, label);
}
