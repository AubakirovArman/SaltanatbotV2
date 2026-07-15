import { readBoundedText } from "../../http/boundedResponse.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { CoinbaseErrorEnvelope } from "./types.js";
import { errorMessage, validation } from "./validation.js";

const DEFAULT_BASE_URL = "https://api.exchange.coinbase.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 8;

export interface CoinbaseTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  maxPayloadBytes?: number;
  maxInFlight?: number;
}

export class CoinbasePublicTransport {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: URL;
  private readonly maxPayloadBytes: number;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(options: CoinbaseTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
    this.baseUrl = validatedOrigin(options.baseUrl ?? DEFAULT_BASE_URL);
  }

  async get(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    if (this.inFlight >= this.maxInFlight) {
      throw new PublicVenueAdapterError("coinbase", "rate-limit", `local in-flight limit ${this.maxInFlight} reached`, 429);
    }
    this.inFlight += 1;
    const url = new URL(path, this.baseUrl);
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
      const response = await this.fetcher(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (response.status === 429) throw new PublicVenueAdapterError("coinbase", "rate-limit", "HTTP 429", response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        if (!response.ok) throw new PublicVenueAdapterError("coinbase", "http", `HTTP ${response.status}`, response.status);
        throw validation("response is not valid JSON");
      }
      if (!response.ok) {
        const message = exchangeMessage(parsed);
        if (message) throw new PublicVenueAdapterError("coinbase", "exchange", message, response.status);
        throw new PublicVenueAdapterError("coinbase", "http", `HTTP ${response.status}`, response.status);
      }
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("coinbase", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("coinbase", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.inFlight -= 1;
    }
  }
}

function exchangeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = (value as CoinbaseErrorEnvelope).message;
  return typeof message === "string" && message ? message.slice(0, 500) : undefined;
}

function validatedOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validation("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw validation("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw validation("baseUrl cannot contain credentials, query or fragment");
  if (url.pathname !== "/") throw validation("baseUrl must be an origin without a path");
  return url;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("coinbase", "cancelled", "request was cancelled");
}
