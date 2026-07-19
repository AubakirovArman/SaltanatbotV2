import { PublicVenueAdapterError } from "../publicTypes.js";
import { readBoundedText } from "../../http/boundedResponse.js";
import type { HyperliquidInfoRequest, HyperliquidNetwork } from "./types.js";

const NETWORK_ORIGINS: Record<HyperliquidNetwork, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz"
};

export interface HyperliquidTransportOptions {
  fetch?: typeof fetch;
  network?: HyperliquidNetwork;
  baseUrl?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

/** Credential-free transport restricted to an allowlist of public `/info` requests. */
export class HyperliquidInfoTransport {
  readonly network: HyperliquidNetwork;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(options: HyperliquidTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.network = options.network ?? "mainnet";
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 8_000, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? 4 * 1024 * 1024, "maxPayloadBytes");
    this.endpoint = infoEndpoint(options.baseUrl ?? NETWORK_ORIGINS[this.network]);
  }

  async post(request: HyperliquidInfoRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
    assertAllowedRequest(request);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      if (response.status === 429) throw new PublicVenueAdapterError("hyperliquid", "rate-limit", "HTTP 429", 429);
      if (!response.ok) throw new PublicVenueAdapterError("hyperliquid", "http", `HTTP ${response.status}`, response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw validation("response is not valid JSON");
      }
      if (isExchangeError(parsed)) throw new PublicVenueAdapterError("hyperliquid", "exchange", parsed.error);
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError("hyperliquid", "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError("hyperliquid", "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
}

function infoEndpoint(value: string) {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw validation("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw validation("baseUrl must use HTTP or HTTPS");
  if (origin.username || origin.password || origin.search || origin.hash) throw validation("baseUrl cannot contain credentials, query or fragment");
  if (origin.pathname !== "/") throw validation("baseUrl must be an origin without a path");
  return new URL("/info", origin);
}

function assertAllowedRequest(request: HyperliquidInfoRequest) {
  if (!request || typeof request !== "object") throw validation("info request must be an object");
  const allowed = new Set(["spotMetaAndAssetCtxs", "metaAndAssetCtxs", "l2Book", "candleSnapshot", "predictedFundings", "fundingHistory"]);
  if (!allowed.has(request.type)) throw validation(`unsupported public info request ${String(request.type)}`);
}

function isExchangeError(value: unknown): value is { error: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { error?: unknown }).error === "string");
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function validation(message: string) {
  return new PublicVenueAdapterError("hyperliquid", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("hyperliquid", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
