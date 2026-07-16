import { createHmac } from "node:crypto";
import type { ExchangeKeys } from "./binance.js";
import type { MarketType } from "../types.js";
import {
  ExchangeTransportError,
  parseExchangeJsonBody,
  readExchangeResponseBody,
  requireExchangeObject
} from "./errors.js";
import { getExchangeRequestGuard, type ExchangeRequestGuard } from "./requestGuard.js";
import { assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../../runtimeProfile.js";
import { type SignedRequestAuthorizer, withSignedRequestAuthorization } from "./signedRequestGate.js";

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
  runtimePolicy?: RuntimePolicy;
}

/** Shared signed Bybit V5 transport for execution and UTA account services. */
export class BybitV5Client {
  private readonly base: string;
  private readonly recvWindow: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly requestGuard: ExchangeRequestGuard;
  private readonly runtimePolicy: RuntimePolicy;

  constructor(
    private readonly keys: ExchangeKeys,
    private readonly market: MarketType,
    private readonly authorizer: SignedRequestAuthorizer,
    options: BybitClientOptions = {}
  ) {
    this.base = options.base ?? "https://api.bybit.com";
    this.recvWindow = options.recvWindow ?? "5000";
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.requestGuard = options.requestGuard ?? getExchangeRequestGuard("bybit");
    this.runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  }

  async request<T>(method: BybitMethod, path: string, params: Record<string, unknown> = {}): Promise<BybitEnvelope<T>> {
    assertPrivateExchangeAccess(`Bybit signed ${method} request`, method === "GET" ? "read" : "mutation", this.runtimePolicy);
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Bybit API keys are not set");
    this.requestGuard.assertAvailable();
    const prepared = prepareWirePayload(method, params);
    return withSignedRequestAuthorization(this.authorizer, { venue: "bybit", market: this.market, method, path, payload: prepared.descriptor }, async () => {
      const timestamp = String(this.now());
      let url = `${this.base}${path}`;
      if (method === "GET" && prepared.serialized) url += `?${prepared.serialized}`;
      const signature = createHmac("sha256", this.keys.apiSecret)
        .update(timestamp + this.keys.apiKey + this.recvWindow + prepared.serialized)
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
          body: method === "POST" ? prepared.serialized : undefined
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
    });
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

function prepareWirePayload(method: BybitMethod, params: Record<string, unknown>): { descriptor: Readonly<Record<string, unknown>>; serialized: string } {
  if (method === "POST") {
    const serialized = JSON.stringify(params);
    const descriptor = JSON.parse(serialized) as unknown;
    if (!isObject(descriptor)) throw new Error("Bybit signed payload must serialize to an object");
    return { descriptor: Object.freeze(descriptor), serialized };
  }
  const descriptor: Record<string, string> = {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Bybit query field ${key} must be a wire primitive`);
    }
    const wireValue = String(value);
    descriptor[key] = wireValue;
    query.set(key, wireValue);
  }
  return { descriptor: Object.freeze(descriptor), serialized: query.toString() };
}
