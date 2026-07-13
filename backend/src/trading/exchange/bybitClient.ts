import { createHmac } from "node:crypto";
import type { ExchangeKeys } from "./binance.js";
import { ExchangeTransportError } from "./errors.js";
import { getExchangeRequestGuard, type ExchangeRequestGuard } from "./requestGuard.js";

export type BybitMethod = "GET" | "POST";

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

interface BybitClientOptions {
  base?: string;
  recvWindow?: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestGuard?: ExchangeRequestGuard;
}

/** Shared signed Bybit V5 transport for execution and UTA account services. */
export class BybitV5Client {
  private readonly base: string;
  private readonly recvWindow: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly requestGuard: ExchangeRequestGuard;

  constructor(private readonly keys: ExchangeKeys, options: BybitClientOptions = {}) {
    this.base = options.base ?? "https://api.bybit.com";
    this.recvWindow = options.recvWindow ?? "5000";
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestGuard = options.requestGuard ?? getExchangeRequestGuard("bybit");
  }

  async request<T>(method: BybitMethod, path: string, params: Record<string, unknown> = {}): Promise<BybitEnvelope<T>> {
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Bybit API keys are not set");
    this.requestGuard.assertAvailable();
    const timestamp = String(this.now());
    let url = `${this.base}${path}`;
    let body: string | undefined;
    let payload: string;
    if (method === "GET") {
      payload = queryString(params);
      if (payload) url += `?${payload}`;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }
    const signature = createHmac("sha256", this.keys.apiSecret)
      .update(timestamp + this.keys.apiKey + this.recvWindow + payload)
      .digest("hex");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          "X-BAPI-API-KEY": this.keys.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": this.recvWindow,
          "X-BAPI-SIGN": signature,
          "Content-Type": "application/json"
        },
        body
      });
    } catch (error) {
      throw new ExchangeTransportError(`Bybit transport failed: ${error instanceof Error ? error.message : error}`, method !== "GET", { cause: error });
    }
    this.requestGuard.observeHttpResponse(response);
    if (!response.ok) {
      const message = `Bybit HTTP ${response.status}: ${await response.text()}`;
      if (method !== "GET" && response.status >= 500) throw new ExchangeTransportError(message, true);
      throw new Error(message);
    }
    const envelope = await response.json() as BybitEnvelope<T>;
    this.requestGuard.detectClockSkew(envelope.retCode, envelope.retMsg, response.headers?.get?.("date") ?? null);
    if (envelope.retCode !== 0) throw new Error(`Bybit: ${envelope.retMsg}`);
    return envelope;
  }
}

function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return query.toString();
}
