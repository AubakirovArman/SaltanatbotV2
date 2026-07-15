import { readBoundedText } from "../../http/boundedResponse.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { MexcDomain, MexcErrorEnvelope } from "./types.js";
import { errorMessage, validation } from "./validation.js";

const DEFAULT_BASE_URL = "https://api.mexc.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 8;

export interface MexcTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  maxPayloadBytes?: number;
  maxInFlight?: number;
}

/** GET-only public transport pinned to MEXC's post-2026 unified api.mexc.com origin. */
export class MexcPublicTransport {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly origin: URL;
  private readonly maxPayloadBytes: number;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(options: MexcTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.origin = validatedOrigin(options.baseUrl ?? DEFAULT_BASE_URL);
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
  }

  async get(domain: MexcDomain, path: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    if (this.inFlight >= this.maxInFlight) {
      throw new PublicVenueAdapterError("mexc", "rate-limit", `local in-flight limit ${this.maxInFlight} reached`, 429);
    }
    this.inFlight += 1;
    const url = new URL(path, this.origin);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(url, { method: "GET", signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      const parsed = parseJson(body);
      if (response.status === 429) throw new PublicVenueAdapterError("mexc", "rate-limit", "HTTP 429", 429);
      if (!response.ok) {
        const message = exchangeMessage(parsed);
        if (message) throw new PublicVenueAdapterError("mexc", "exchange", message, response.status);
        throw new PublicVenueAdapterError("mexc", "http", `HTTP ${response.status}`, response.status);
      }
      if (parsed === INVALID_JSON) throw validation("response is not valid JSON");
      if (domain === "futures") return unwrapFutures(parsed);
      const error = spotExchangeError(parsed);
      if (error) throw new PublicVenueAdapterError("mexc", "exchange", error);
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("mexc", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("mexc", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.inFlight -= 1;
    }
  }
}

const INVALID_JSON = Symbol("invalid-json");

function parseJson(body: string): unknown | typeof INVALID_JSON {
  try {
    return JSON.parse(body);
  } catch {
    return INVALID_JSON;
  }
}

function unwrapFutures(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation("futures response must be an envelope object");
  const row = value as MexcErrorEnvelope;
  if (row.success !== true || Number(row.code) !== 0) {
    throw new PublicVenueAdapterError("mexc", "exchange", exchangeMessage(row) ?? "MEXC futures request failed");
  }
  if (!("data" in row)) throw validation("futures response envelope is missing data");
  return row.data;
}

function spotExchangeError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as MexcErrorEnvelope;
  if (row.code === undefined) return undefined;
  const code = Number(row.code);
  if (code === 0 || code === 200) return undefined;
  return exchangeMessage(row) ?? `MEXC code ${String(row.code)}`;
}

function exchangeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as MexcErrorEnvelope;
  const message = typeof row.message === "string" ? row.message : typeof row.msg === "string" ? row.msg : undefined;
  return message?.trim() ? message.slice(0, 500) : undefined;
}

function validatedOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validation("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw validation("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw validation("baseUrl must be an origin without credentials, path, query or fragment");
  }
  return url;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("mexc", "cancelled", "request was cancelled");
}
