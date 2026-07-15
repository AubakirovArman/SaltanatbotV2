import { createHmac } from "node:crypto";
import type { ExchangeKeys } from "./binance.js";
import {
  ExchangeTransportError,
  parseExchangeJsonBody,
  readExchangeResponseBody,
  requireExchangeObject
} from "./errors.js";
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
    const mutation = method !== "GET";
    const context = `Bybit ${method} ${path}`;
    if (!response.ok) {
      const raw = await readExchangeResponseBody(response, context, mutation);
      const message = `Bybit HTTP ${response.status}: ${raw}`;
      if (method !== "GET" && response.status >= 500) throw new ExchangeTransportError(message, true);
      throw new Error(message);
    }
    const raw = await readExchangeResponseBody(response, context, mutation);
    const parsed = parseExchangeJsonBody(raw, context, mutation);
    const envelope = requireBybitEnvelope<T>(parsed, context, mutation);
    this.requestGuard.detectClockSkew(envelope.retCode, envelope.retMsg, response.headers?.get?.("date") ?? null);
    if (envelope.retCode !== 0) throw new Error(`Bybit: ${envelope.retMsg}`);
    return envelope;
  }
}

function requireBybitEnvelope<T>(value: unknown, context: string, ambiguous: boolean): BybitEnvelope<T> {
  const envelope = requireExchangeObject(value, context, ambiguous);
  if (
    typeof envelope.retCode !== "number"
    || !Number.isFinite(envelope.retCode)
    || typeof envelope.retMsg !== "string"
    || (envelope.retCode === 0 && !Object.hasOwn(envelope, "result"))
    || (ambiguous && envelope.retCode === 0 && !isObject(envelope.result))
  ) {
    throw new ExchangeTransportError(`${context} response did not match the Bybit envelope schema`, ambiguous);
  }
  return envelope as unknown as BybitEnvelope<T>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return query.toString();
}
