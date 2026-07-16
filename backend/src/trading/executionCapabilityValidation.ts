import {
  ExecutionCapabilityError,
  type NormalizedSignedExchangeRequest,
  SIGNED_REQUEST_INVALID,
  SIGNED_REQUEST_UNSUPPORTED,
  type SignedExchangeWireValue
} from "./executionCapabilityTypes.js";

export function assertEmptyPayload(payload: Readonly<Record<string, SignedExchangeWireValue>>, label: string): void {
  assertExactKeys(payload, [], [], label);
}

export function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid(label + " contains unsupported field " + key);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(label + " requires field " + key);
  }
}

export function requirePresent(payload: Readonly<Record<string, SignedExchangeWireValue>>, key: string, label: string): void {
  if (!Object.hasOwn(payload, key)) invalid(label + " requires field " + key);
}

export function forbidKeys(payload: Readonly<Record<string, SignedExchangeWireValue>>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) invalid(label + " forbids field " + key);
  }
}

export function assertExactlyOne(payload: Readonly<Record<string, SignedExchangeWireValue>>, keys: readonly string[], label: string): void {
  const count = keys.filter((key) => Object.hasOwn(payload, key)).length;
  if (count !== 1) invalid(label + " requires exactly one of " + keys.join(" or "));
}

export function assertAtMostOne(payload: Readonly<Record<string, SignedExchangeWireValue>>, keys: readonly string[], label: string): void {
  const count = keys.filter((key) => Object.hasOwn(payload, key)).length;
  if (count > 1) invalid(label + " allows at most one of " + keys.join(" or "));
}

export function hasOwn(payload: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(payload, key);
}

export function requireWireIdentifier(value: unknown, label: string, maxLength = 160): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || hasControlCharacters(value)) {
    invalid(label + " is invalid");
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function requireAssetList(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 200) invalid(label + " is invalid");
  const assets = value.split(",");
  if (assets.length < 1 || assets.length > 20 || assets.some((asset) => !/^[A-Z0-9]{2,20}$/.test(asset))) invalid(label + " is invalid");
  return value;
}

export function positiveDecimalString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    invalid(label + " must be a positive decimal string");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) invalid(label + " must be positive");
  return value;
}

export function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || (typeof value === "string" && !/^[1-9]\d*$/.test(value))) {
    invalid(label + " must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) invalid(label + " must be a positive integer");
  return parsed;
}

export function requiredSymbol(payload: Readonly<Record<string, unknown>>): string {
  const symbol = payload.symbol;
  if (typeof symbol !== "string" || !/^[A-Z0-9][A-Z0-9:_/-]{1,63}$/.test(symbol)) invalid("Signed request symbol is invalid");
  return symbol;
}

export function optionalSymbol(payload: Readonly<Record<string, unknown>>): string | undefined {
  return payload.symbol === undefined ? undefined : requiredSymbol(payload);
}

export function requireAsset(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z0-9]{2,20}$/.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function positiveWireNumber(value: unknown, label: string): void {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") invalid(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) invalid(`${label} must be positive`);
}

export function truthyWireBoolean(value: unknown): boolean {
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  invalid("Wire boolean must be true or false");
}

export function requireEnum<T extends string | number>(value: unknown, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) invalid(`${label} is invalid`);
  return value as T;
}

export function unsupported(request: NormalizedSignedExchangeRequest): ExecutionCapabilityError {
  return new ExecutionCapabilityError(SIGNED_REQUEST_UNSUPPORTED, `Signed exchange request is not allowlisted: ${request.venue} ${request.market} ${request.method} ${request.path}`);
}

export function invalid(message: string): never {
  throw new ExecutionCapabilityError(SIGNED_REQUEST_INVALID, message);
}

export function canonicalJson(value: unknown): string {
  const budget = { nodes: 0 };
  return canonicalNode(value, 0, budget);
}

function canonicalNode(value: unknown, depth: number, budget: { nodes: number }): string {
  budget.nodes += 1;
  if (depth > 8 || budget.nodes > 512) invalid("Signed request value exceeds the canonicalization bound");
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length > 4096) invalid("Signed request string exceeds the canonicalization bound");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Signed request numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalNode(entry, depth + 1, budget)).join(",")}]`;
  if (!isPlainRecord(value)) invalid("Signed request values must be JSON-compatible plain data");
  const keys = Object.keys(value).sort();
  if (keys.length > 128) invalid("Signed request object has too many fields");
  return `{${keys
    .map((key) => {
      if (key.length === 0 || key.length > 128) invalid("Signed request field name is invalid");
      const entry = value[key];
      if (entry === undefined) invalid("Signed request values must not be undefined");
      return `${JSON.stringify(key)}:${canonicalNode(entry, depth + 1, budget)}`;
    })
    .join(",")}}`;
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
