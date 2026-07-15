import { readBoundedText } from "../../http/boundedResponse.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { errorMessage, validation } from "./validation.js";

const DEFAULT_SPOT_BASE_URL = "https://api.kraken.com";
const DEFAULT_FUTURES_BASE_URL = "https://futures.kraken.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 8;

export interface KrakenTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  spotBaseUrl?: string;
  futuresBaseUrl?: string;
  maxPayloadBytes?: number;
  maxInFlight?: number;
}

type KrakenQuery = Record<string, string | readonly string[]>;

export class KrakenPublicTransport {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly spotBaseUrl: URL;
  private readonly futuresBaseUrl: URL;
  private readonly maxPayloadBytes: number;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(options: KrakenTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
    this.spotBaseUrl = validatedOrigin(options.spotBaseUrl ?? DEFAULT_SPOT_BASE_URL, "spotBaseUrl");
    this.futuresBaseUrl = validatedOrigin(options.futuresBaseUrl ?? DEFAULT_FUTURES_BASE_URL, "futuresBaseUrl");
  }

  async spot(path: string, query: KrakenQuery, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = await this.fetchJson(this.spotBaseUrl, path, query, signal);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("Spot response envelope must be an object");
    const envelope = parsed as { error?: unknown; result?: unknown };
    if (!Array.isArray(envelope.error)) throw validation("Spot response error must be an array");
    if (envelope.error.length > 0) {
      const message = envelope.error
        .map((item) => String(item))
        .join("; ")
        .slice(0, 500);
      if (/rate.?limit/i.test(message)) throw new PublicVenueAdapterError("kraken", "rate-limit", message, 429);
      throw new PublicVenueAdapterError("kraken", "exchange", message || "Spot exchange error");
    }
    if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
      throw validation("Spot response result must be an object");
    }
    return envelope.result as Record<string, unknown>;
  }

  async futures(path: string, query: KrakenQuery, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = await this.fetchJson(this.futuresBaseUrl, path, query, signal);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("Futures response envelope must be an object");
    const envelope = parsed as { result?: unknown; error?: unknown; errors?: unknown };
    if (envelope.result !== "success") {
      const candidates = Array.isArray(envelope.errors) ? envelope.errors : [envelope.error];
      const message = candidates
        .filter((item) => item !== undefined && item !== null)
        .map(String)
        .join("; ")
        .slice(0, 500);
      if (/apiLimitExceeded|rate.?limit/i.test(message)) {
        throw new PublicVenueAdapterError("kraken", "rate-limit", message || "Futures API limit exceeded", 429);
      }
      throw new PublicVenueAdapterError("kraken", "exchange", message || `Futures result ${String(envelope.result)}`);
    }
    return parsed as Record<string, unknown>;
  }

  private async fetchJson(baseUrl: URL, path: string, query: KrakenQuery, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    if (this.inFlight >= this.maxInFlight) {
      throw new PublicVenueAdapterError("kraken", "rate-limit", `local in-flight limit ${this.maxInFlight} reached`, 429);
    }
    this.inFlight += 1;
    const url = new URL(path, baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      if (typeof value === "string") url.searchParams.set(key, value);
      else value.forEach((item) => url.searchParams.append(key, item));
    });
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (response.status === 429) throw new PublicVenueAdapterError("kraken", "rate-limit", "HTTP 429", response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        if (!response.ok) throw new PublicVenueAdapterError("kraken", "http", `HTTP ${response.status}`, response.status);
        throw validation("response is not valid JSON");
      }
      if (!response.ok) {
        const exchangeMessage = responseErrorMessage(parsed);
        if (exchangeMessage) throw new PublicVenueAdapterError("kraken", "exchange", exchangeMessage, response.status);
        throw new PublicVenueAdapterError("kraken", "http", `HTTP ${response.status}`, response.status);
      }
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("kraken", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("kraken", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.inFlight -= 1;
    }
  }
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as { error?: unknown; errors?: unknown };
  const errors = Array.isArray(envelope.errors) ? envelope.errors : Array.isArray(envelope.error) ? envelope.error : [envelope.error];
  const message = errors
    .filter((item) => item !== undefined && item !== null)
    .map(String)
    .join("; ")
    .slice(0, 500);
  return message || undefined;
}

function validatedOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validation(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw validation(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password || url.search || url.hash) throw validation(`${label} cannot contain credentials, query or fragment`);
  if (url.pathname !== "/") throw validation(`${label} must be an origin without a path`);
  return url;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("kraken", "cancelled", "request was cancelled");
}
