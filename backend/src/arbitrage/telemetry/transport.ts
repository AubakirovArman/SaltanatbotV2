import { createHmac } from "node:crypto";
import type { ExchangeKeys } from "../../trading/exchange/binance.js";
import { getExchangeRequestGuard, type ExchangeRequestGuard } from "../../trading/exchange/requestGuard.js";
import { boundedFetchJson, invalid, object, safeMessage } from "./helpers.js";
import { assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../../runtimeProfile.js";

export interface ReadonlyTelemetryResponse {
  payload: unknown;
  receivedAt: number;
}

export interface BinanceTelemetryRequester {
  read(target: "spot" | "futures", path: string, params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ReadonlyTelemetryResponse>;
}

export interface BybitTelemetryRequester {
  read(path: string, params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ReadonlyTelemetryResponse>;
}

export interface ReadonlyTelemetryTransportOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  requestGuard?: ExchangeRequestGuard;
  binanceSpotBase?: string;
  binanceFuturesBase?: string;
  bybitBase?: string;
  runtimePolicy?: RuntimePolicy;
}

interface EndpointPolicy {
  weight: number;
  maxBytes: number;
}

const BINANCE_ENDPOINTS = new Map<string, EndpointPolicy>([
  ["spot:/api/v3/account/commission", { weight: 20, maxBytes: 128 * 1024 }],
  ["spot:/sapi/v1/capital/config/getall", { weight: 10, maxBytes: 4 * 1024 * 1024 }],
  ["spot:/sapi/v1/margin/maxBorrowable", { weight: 50, maxBytes: 128 * 1024 }],
  ["spot:/sapi/v1/margin/next-hourly-interest-rate", { weight: 100, maxBytes: 128 * 1024 }],
  ["futures:/fapi/v1/accountConfig", { weight: 5, maxBytes: 128 * 1024 }],
  ["futures:/fapi/v1/feeBurn", { weight: 30, maxBytes: 128 * 1024 }],
  ["futures:/fapi/v1/commissionRate", { weight: 20, maxBytes: 128 * 1024 }]
]);

const BYBIT_ENDPOINTS = new Map<string, EndpointPolicy>([
  ["/v5/account/collateral-info", { weight: 1, maxBytes: 512 * 1024 }],
  ["/v5/account/fee-rate", { weight: 1, maxBytes: 256 * 1024 }],
  ["/v5/asset/coin/query-info", { weight: 1, maxBytes: 512 * 1024 }]
]);

/** GET-only Binance signer. Its endpoint allowlist contains no order or mutation route. */
export class BinanceReadonlyTelemetryTransport implements BinanceTelemetryRequester {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly guard: ExchangeRequestGuard;
  private readonly spotBase: string;
  private readonly futuresBase: string;
  private readonly runtimePolicy: RuntimePolicy;

  constructor(private readonly keys: ExchangeKeys, options: ReadonlyTelemetryTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.guard = options.requestGuard ?? getExchangeRequestGuard("binance");
    this.spotBase = validatedBase(options.binanceSpotBase ?? "https://api.binance.com");
    this.futuresBase = validatedBase(options.binanceFuturesBase ?? "https://fapi.binance.com");
    this.runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  }

  async read(target: "spot" | "futures", path: string, params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ReadonlyTelemetryResponse> {
    assertPrivateExchangeAccess("Binance private account telemetry", "read", this.runtimePolicy);
    requireKeys(this.keys, "Binance");
    const policy = BINANCE_ENDPOINTS.get(`${target}:${path}`);
    if (!policy) throw new Error("Binance telemetry endpoint is not allowlisted");
    this.guard.assertAvailable(policy.weight);
    const query = safeQuery(params);
    query.set("timestamp", String(this.now()));
    query.set("recvWindow", "5000");
    query.set("signature", createHmac("sha256", this.keys.apiSecret).update(query.toString()).digest("hex"));
    const base = target === "spot" ? this.spotBase : this.futuresBase;
    return boundedFetchJson(
      this.fetcher,
      `${base}${path}?${query.toString()}`,
      signal,
      policy.maxBytes,
      this.timeoutMs,
      this.now,
      (response) => this.guard.observeHttpResponse(response),
      { "X-MBX-APIKEY": this.keys.apiKey }
    );
  }
}

/** GET-only Bybit v5 signer. Its endpoint allowlist contains no order or mutation route. */
export class BybitReadonlyTelemetryTransport implements BybitTelemetryRequester {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly guard: ExchangeRequestGuard;
  private readonly base: string;
  private readonly runtimePolicy: RuntimePolicy;

  constructor(private readonly keys: ExchangeKeys, options: ReadonlyTelemetryTransportOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.guard = options.requestGuard ?? getExchangeRequestGuard("bybit");
    this.base = validatedBase(options.bybitBase ?? "https://api.bybit.com");
    this.runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  }

  async read(path: string, params: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ReadonlyTelemetryResponse> {
    assertPrivateExchangeAccess("Bybit private account telemetry", "read", this.runtimePolicy);
    requireKeys(this.keys, "Bybit");
    const policy = BYBIT_ENDPOINTS.get(path);
    if (!policy) throw new Error("Bybit telemetry endpoint is not allowlisted");
    this.guard.assertAvailable(policy.weight);
    const query = safeQuery(params).toString();
    const timestamp = String(this.now());
    const recvWindow = "5000";
    const signature = createHmac("sha256", this.keys.apiSecret).update(timestamp + this.keys.apiKey + recvWindow + query).digest("hex");
    const suffix = query ? `?${query}` : "";
    const response = await boundedFetchJson(
      this.fetcher,
      `${this.base}${path}${suffix}`,
      signal,
      policy.maxBytes,
      this.timeoutMs,
      this.now,
      (value) => this.guard.observeHttpResponse(value),
      {
        "X-BAPI-API-KEY": this.keys.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature
      }
    );
    validateBybitEnvelope(response.payload);
    return response;
  }
}

export function bybitResult(response: ReadonlyTelemetryResponse): { result: Record<string, unknown>; asOf: number; receivedAt: number; timestampQuality: "venue" | "receive-time" } {
  const envelope = validateBybitEnvelope(response.payload);
  const venueTime = Number(envelope.time);
  const venueTimestamp = Number.isSafeInteger(venueTime) && venueTime > 0;
  return {
    result: object(envelope.result, "Bybit result"),
    asOf: venueTimestamp ? venueTime : response.receivedAt,
    receivedAt: response.receivedAt,
    timestampQuality: venueTimestamp ? "venue" : "receive-time"
  };
}

function validateBybitEnvelope(value: unknown): Record<string, unknown> {
  const envelope = object(value, "Bybit envelope");
  if (!Number.isSafeInteger(envelope.retCode) || typeof envelope.retMsg !== "string") throw invalid("Bybit telemetry envelope is invalid");
  if (envelope.retCode !== 0) {
    const error = new Error(`Bybit telemetry rejected the request: ${safeMessage(envelope.retMsg)}`) as Error & { status?: number };
    if (envelope.retCode === 10006) error.status = 429;
    throw error;
  }
  if (!Object.hasOwn(envelope, "result")) throw invalid("Bybit telemetry result is missing");
  return envelope;
}

function safeQuery(params: Readonly<Record<string, string>>) {
  const query = new URLSearchParams();
  const entries = Object.entries(params);
  if (entries.length > 20) throw new Error("Telemetry query exceeds the parameter limit");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key) || typeof value !== "string" || value.length > 200 || /[\r\n]/.test(value)) throw new Error("Telemetry query parameter is invalid");
    query.set(key, value);
  }
  return query;
}

function requireKeys(keys: ExchangeKeys, venue: string) {
  if (!keys.apiKey || !keys.apiSecret) throw new Error(`${venue} API keys are not configured`);
}

function validatedBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Telemetry transport base must use HTTPS");
  return value.replace(/\/$/, "");
}
