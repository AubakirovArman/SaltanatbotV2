import { readBoundedText } from "../../http/boundedResponse.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { DydxNetwork } from "./types.js";
import { dydxValidation, errorMessage, safeInteger, ticker } from "./validation.js";

const NETWORK_ORIGINS: Record<DydxNetwork, string> = {
  mainnet: "https://indexer.dydx.trade",
  testnet: "https://indexer.v4testnet.dydx.exchange"
};

export interface DydxIndexerTransportOptions {
  fetch?: typeof fetch;
  network?: DydxNetwork;
  baseUrl?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

/** Credential-free transport restricted to three public Indexer market-data routes. */
export class DydxIndexerTransport {
  readonly network: DydxNetwork;
  private readonly fetcher: typeof fetch;
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(options: DydxIndexerTransportOptions = {}) {
    this.network = options.network ?? "mainnet";
    this.fetcher = options.fetch ?? fetch;
    this.origin = exactOrigin(options.baseUrl ?? NETWORK_ORIGINS[this.network]);
    this.timeoutMs = safeInteger(options.timeoutMs ?? 8_000, "timeoutMs", 1, 60_000);
    this.maxPayloadBytes = safeInteger(options.maxPayloadBytes ?? 4 * 1024 * 1024, "maxPayloadBytes", 1_024, 32 * 1024 * 1024);
  }

  getPerpetualMarkets(signal?: AbortSignal): Promise<unknown> {
    return this.get("/v4/perpetualMarkets", undefined, signal);
  }

  getOrderbook(instrumentId: string, signal?: AbortSignal): Promise<unknown> {
    const market = ticker(instrumentId, "instrumentId");
    return this.get(`/v4/orderbooks/perpetualMarket/${encodeURIComponent(market)}`, undefined, signal);
  }

  getHistoricalFunding(instrumentId: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    const market = ticker(instrumentId, "instrumentId");
    return this.get(`/v4/historicalFunding/${encodeURIComponent(market)}`, { limit: String(safeInteger(limit, "historyLimit", 1, 100)) }, signal);
  }

  private async get(pathname: string, query: Record<string, string> | undefined, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    const url = new URL(pathname, this.origin);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
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
      if (response.status === 429) throw new PublicVenueAdapterError("dydx", "rate-limit", "HTTP 429", 429);
      if (!response.ok) throw new PublicVenueAdapterError("dydx", "http", `HTTP ${response.status}`, response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => dydxValidation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw dydxValidation("response is not valid JSON");
      }
      const exchangeError = indexerError(parsed);
      if (exchangeError) throw new PublicVenueAdapterError("dydx", "exchange", exchangeError);
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("dydx", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("dydx", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
}

function exactOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw dydxValidation("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw dydxValidation("baseUrl must use HTTP or HTTPS");
  }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw dydxValidation("baseUrl must be an origin without credentials, path, query or fragment");
  }
  return origin;
}

function indexerError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as { errors?: unknown; error?: unknown };
  if (typeof row.error === "string" && row.error.trim()) return row.error.slice(0, 300);
  if (Array.isArray(row.errors) && row.errors.length > 0) {
    const messages = row.errors.slice(0, 5).map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { msg?: unknown }).msg === "string" ? (item as { msg: string }).msg : "unknown exchange error"));
    return messages.join("; ").slice(0, 300);
  }
  return undefined;
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("dydx", "cancelled", "request was cancelled");
}
