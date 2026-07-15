import { PublicVenueAdapterError } from "../publicTypes.js";
import { readBoundedText } from "../../http/boundedResponse.js";
import type { DeribitEnvironment, DeribitPublicMethod } from "./types.js";

const ENVIRONMENT_ORIGINS: Record<DeribitEnvironment, string> = {
  production: "https://www.deribit.com",
  test: "https://test.deribit.com"
};

const ALLOWED_METHODS = new Set<DeribitPublicMethod>([
  "public/get_instrument",
  "public/get_instruments",
  "public/get_order_book",
  "public/get_funding_rate_history",
  "public/ticker"
]);

const ENVELOPE_KEYS = new Set(["jsonrpc", "id", "result", "error", "testnet", "usIn", "usOut", "usDiff"]);
const ORDER_BOOK_DEPTHS = new Set([1, 5, 10, 20, 50, 100, 1_000, 10_000]);

export interface DeribitRpcTransportOptions {
  fetch?: typeof fetch;
  environment?: DeribitEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

/** Credential-free JSON-RPC transport restricted to an allowlist of public methods. */
export class DeribitJsonRpcTransport {
  readonly environment: DeribitEnvironment;
  private readonly fetcher: typeof fetch;
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private requestId = 0;

  constructor(options: DeribitRpcTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.environment = options.environment ?? "production";
    this.origin = validatedOrigin(options.baseUrl ?? ENVIRONMENT_ORIGINS[this.environment]);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 8_000, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? 4 * 1024 * 1024, "maxPayloadBytes");
  }

  async call(method: DeribitPublicMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) throw validation(`method ${String(method)} is not an allowed public method`);
    assertParams(method, params);
    if (signal?.aborted) throw cancelled();

    const id = this.nextRequestId();
    const endpoint = new URL(`/api/v2/${method}`, this.origin);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
      });
      if (response.status === 429) throw new PublicVenueAdapterError("deribit", "rate-limit", "HTTP 429", 429);
      if (!response.ok) throw new PublicVenueAdapterError("deribit", "http", `HTTP ${response.status}`, response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw validation("response is not valid JSON");
      }
      return unwrapEnvelope(parsed, id);
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("deribit", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("deribit", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private nextRequestId() {
    this.requestId = this.requestId >= Number.MAX_SAFE_INTEGER ? 1 : this.requestId + 1;
    return this.requestId;
  }
}

function unwrapEnvelope(value: unknown, expectedId: number): unknown {
  const envelope = record(value, "JSON-RPC response");
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.has(key)) throw validation(`JSON-RPC response contains unexpected field ${key}`);
  }
  if (envelope.jsonrpc !== "2.0") throw validation("JSON-RPC response version must be 2.0");
  if (envelope.id !== expectedId) throw validation(`JSON-RPC response id does not match request ${expectedId}`);
  validateExtension(envelope.testnet, "testnet", "boolean");
  for (const key of ["usIn", "usOut", "usDiff"] as const) validateExtension(envelope[key], key, "integer");

  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (hasResult === hasError) throw validation("JSON-RPC response must contain exactly one of result or error");
  if (hasError) {
    const error = record(envelope.error, "JSON-RPC error");
    const code = integer(error.code, "JSON-RPC error.code");
    const message = nonEmptyString(error.message, "JSON-RPC error.message");
    const kind = code === 10028 ? "rate-limit" : "exchange";
    throw new PublicVenueAdapterError("deribit", kind, `JSON-RPC ${code}: ${message}`);
  }
  if (envelope.result === undefined) throw validation("JSON-RPC result cannot be undefined");
  return envelope.result;
}

function assertParams(method: DeribitPublicMethod, value: Record<string, unknown>) {
  const params = record(value, `${method} params`);
  if (method === "public/get_instruments") {
    exactKeys(params, ["currency", "kind", "expired"]);
    const currency = nonEmptyString(params.currency, "currency").toUpperCase();
    if (currency !== "ANY" && !/^[A-Z0-9_]{2,20}$/.test(currency)) throw validation("currency is invalid");
    if (params.kind !== "future" && params.kind !== "option") throw validation("kind must be future or option");
    if (params.expired !== undefined && typeof params.expired !== "boolean") throw validation("expired must be boolean");
    return;
  }
  if (method === "public/get_funding_rate_history") {
    exactKeys(params, ["instrument_name", "start_timestamp", "end_timestamp"]);
    instrumentName(params.instrument_name);
    const start = timestamp(params.start_timestamp, "start_timestamp");
    const end = timestamp(params.end_timestamp, "end_timestamp");
    if (start >= end) throw validation("funding history start_timestamp must precede end_timestamp");
    return;
  }
  if (method === "public/get_order_book") {
    exactKeys(params, ["instrument_name", "depth"]);
    instrumentName(params.instrument_name);
    const depth = integer(params.depth, "depth");
    if (!ORDER_BOOK_DEPTHS.has(depth)) throw validation("depth must be one of 1, 5, 10, 20, 50, 100, 1000 or 10000");
    return;
  }
  exactKeys(params, ["instrument_name"]);
  instrumentName(params.instrument_name);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw validation(`unexpected request parameter ${key}`);
  }
}

function validatedOrigin(value: string) {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw validation("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw validation("baseUrl must use HTTP or HTTPS");
  if (origin.username || origin.password || origin.search || origin.hash) throw validation("baseUrl cannot contain credentials, query or fragment");
  if (origin.pathname !== "/") throw validation("baseUrl must be an origin without a path");
  return origin;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function validateExtension(value: unknown, label: string, kind: "boolean" | "integer") {
  if (value === undefined) return;
  if (kind === "boolean" && typeof value !== "boolean") throw validation(`JSON-RPC ${label} must be boolean`);
  if (kind === "integer" && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    throw validation(`JSON-RPC ${label} must be a non-negative safe integer`);
  }
}

function instrumentName(value: unknown) {
  const name = nonEmptyString(value, "instrument_name").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_.-]{1,99}$/.test(name)) throw validation("instrument_name contains invalid characters");
  return name;
}

function timestamp(value: unknown, label: string) {
  const result = integer(value, label);
  if (result <= 0) throw validation(`${label} must be positive`);
  return result;
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value)) throw validation(`${label} must be a safe integer`);
  return Number(value);
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function validation(message: string) {
  return new PublicVenueAdapterError("deribit", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("deribit", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
