import { validateSignedRequestShape } from "./executionCapabilityRequestShapes.js";
import type {
  NormalizedSignedExchangeRequest,
  SignedExchangeMethod,
  SignedExchangeRequest,
  SignedExchangeVenue,
  SignedExchangeWireValue
} from "./executionCapabilityTypes.js";
import { assertExactKeys, invalid, isPlainRecord } from "./executionCapabilityValidation.js";

const SIGNED_REQUEST_TOP_LEVEL_KEYS = ["venue", "market", "method", "path", "payload"] as const;

/**
 * Produce the one immutable descriptor that capability checks, permit digests
 * and signed transports must share. It is intentionally stricter than the
 * public TypeScript interface because request objects can still arrive from
 * untyped JavaScript or parsed data at runtime.
 */
export function normalizeSignedExchangeRequest(request: SignedExchangeRequest): NormalizedSignedExchangeRequest {
  if (!isPlainRecord(request)) invalid("Signed exchange request must be a plain object");
  assertExactKeys(request, SIGNED_REQUEST_TOP_LEVEL_KEYS, ["venue", "market", "method", "path"], "Signed exchange request");
  if (request.venue !== "binance" && request.venue !== "bybit") invalid("Unknown signed exchange venue");
  if (request.market !== "spot" && request.market !== "futures") invalid("Unknown signed exchange market");
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) invalid("Unknown signed exchange method");
  if (typeof request.path !== "string" || !/^\/[A-Za-z0-9/_-]+$/.test(request.path) || request.path.includes("//") || request.path.includes("..")) {
    invalid("Signed exchange path must be an exact path without a query or traversal");
  }
  if (Object.hasOwn(request, "payload") && request.payload === undefined) invalid("Signed exchange payload must not be undefined");
  if (request.payload === null) invalid("Signed exchange payload must not be null");
  const payload = normalizeWirePayload(request.payload ?? {}, request.venue, request.method);
  const normalized = Object.freeze({
    venue: request.venue,
    market: request.market,
    method: request.method,
    path: request.path,
    payload
  });
  validateSignedRequestShape(normalized);
  return normalized;
}

function normalizeWirePayload(
  payload: Readonly<Record<string, unknown>>,
  venue: SignedExchangeVenue,
  method: SignedExchangeMethod
): Readonly<Record<string, SignedExchangeWireValue>> {
  if (!isPlainRecord(payload)) invalid("Signed exchange payload must be a plain object");
  const keys = Object.keys(payload).sort();
  if (keys.length > 128) invalid("Signed exchange payload has too many fields");
  const entries: Array<readonly [string, SignedExchangeWireValue]> = [];
  for (const key of keys) {
    if (key.length === 0 || key.length > 128) invalid("Signed request field name is invalid");
    const value = payload[key];
    if (value === null || value === undefined) invalid("Signed request field " + key + " must not be null or undefined");
    if (typeof value === "string") {
      if (value.length > 4096) invalid("Signed request field " + key + " exceeds the string bound");
      entries.push([key, value]);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid("Signed request field " + key + " must be finite");
      const normalizedNumber = Object.is(value, -0) ? 0 : value;
      entries.push([key, venue === "bybit" && method === "GET" ? String(normalizedNumber) : normalizedNumber]);
      continue;
    }
    if (typeof value === "boolean") {
      entries.push([key, venue === "bybit" && method === "GET" ? String(value) : value]);
      continue;
    }
    invalid("Signed request field " + key + " must be a wire primitive");
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, SignedExchangeWireValue>);
}
