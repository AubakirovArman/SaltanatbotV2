import { readBoundedText } from "../../http/boundedResponse.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { KucoinDomain, KucoinEnvelope } from "./types.js";
import { errorMessage, exactString, validation } from "./validation.js";

const DEFAULT_SPOT_BASE_URL = "https://api.kucoin.com";
const DEFAULT_FUTURES_BASE_URL = "https://api-futures.kucoin.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 8;

export interface KucoinTransportOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  spotBaseUrl?: string;
  futuresBaseUrl?: string;
  maxPayloadBytes?: number;
  maxInFlight?: number;
}

/** Anonymous GET-only transport for the two documented KuCoin public REST origins. */
export class KucoinPublicTransport {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly origins: Record<KucoinDomain, URL>;
  private readonly maxPayloadBytes: number;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(options: KucoinTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT, "maxInFlight");
    this.origins = {
      spot: validatedOrigin(options.spotBaseUrl ?? DEFAULT_SPOT_BASE_URL, "spotBaseUrl"),
      futures: validatedOrigin(options.futuresBaseUrl ?? DEFAULT_FUTURES_BASE_URL, "futuresBaseUrl")
    };
  }

  async get(domain: KucoinDomain, path: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    if (this.inFlight >= this.maxInFlight) {
      throw new PublicVenueAdapterError("kucoin", "rate-limit", `local in-flight limit ${this.maxInFlight} reached`, 429);
    }
    this.inFlight += 1;
    const url = new URL(path, this.origins[domain]);
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
      if (response.status === 429 || exchangeCode(parsed) === "429000") {
        throw new PublicVenueAdapterError("kucoin", "rate-limit", exchangeMessage(parsed) ?? `HTTP ${response.status}`, response.status || 429);
      }
      if (!response.ok) {
        const message = exchangeMessage(parsed);
        if (message) throw new PublicVenueAdapterError("kucoin", "exchange", message, response.status);
        throw new PublicVenueAdapterError("kucoin", "http", `HTTP ${response.status}`, response.status);
      }
      if (parsed === INVALID_JSON) throw validation("response is not valid JSON");
      const envelope = parsed as KucoinEnvelope;
      if (exchangeCode(envelope) !== "200000") {
        throw new PublicVenueAdapterError("kucoin", "exchange", exchangeMessage(envelope) ?? "unexpected KuCoin response code");
      }
      if (!("data" in envelope)) throw validation("response envelope is missing data");
      return envelope.data;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("kucoin", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("kucoin", "http", `network request failed: ${errorMessage(error)}`);
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

function exchangeCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as KucoinEnvelope).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function exchangeMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as KucoinEnvelope;
  const message = typeof row.msg === "string" ? row.msg : typeof row.message === "string" ? row.message : undefined;
  if (!message?.trim()) return exchangeCode(row) ? `KuCoin code ${exchangeCode(row)}` : undefined;
  return `${exchangeCode(row) ? `${exchangeCode(row)}: ` : ""}${message}`.slice(0, 500);
}

function validatedOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validation(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw validation(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw validation(`${label} must be an origin without credentials, path, query or fragment`);
  }
  return url;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("kucoin", "cancelled", "request was cancelled");
}
