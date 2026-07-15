import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import { readBoundedText } from "../../http/boundedResponse.js";
import type { AdapterValidationIssue, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { gateMarketType, normalizeGateDepth, normalizeGateFunding, normalizeGateInstruments, normalizeGateTicker } from "./normalize.js";
import type { GateErrorEnvelope, GateMarketType } from "./types.js";

const DEFAULT_BASE_URL = "https://api.gateio.ws";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH_LEVELS = 100;

export const GATE_PUBLIC_CAPABILITIES: VenueCapabilityManifest = Object.freeze({
  venue: "gate",
  publicData: true,
  spot: true,
  margin: false,
  perpetual: true,
  datedFuture: false,
  option: false,
  nativeSpread: false,
  topBook: true,
  depth: true,
  publicTrades: false,
  funding: true,
  borrow: false,
  depositWithdrawal: false,
  privateExecution: false,
  demoEnvironment: false
});

export interface GatePublicAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
  maxPayloadBytes?: number;
}

/** Credential-free Gate API v4 REST adapter for SPOT and USDT perpetual public data. */
export class GatePublicAdapter implements PublicVenueAdapter {
  readonly venue = "gate";
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly baseUrl: URL;
  private readonly maxPayloadBytes: number;

  constructor(options: GatePublicAdapterOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.baseUrl = validatedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  }

  capabilities(): VenueCapabilityManifest {
    return { ...GATE_PUBLIC_CAPABILITIES };
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    const type = gateMarketType(marketType);
    const rows = await this.fetchArray(type === "spot" ? "/api/v4/spot/currency_pairs" : "/api/v4/futures/usdt/contracts", {}, signal);
    const receivedAt = this.now();
    const normalized = normalizeGateInstruments(rows, type);
    requireAtLeastOneValid(rows, normalized.instruments, `${type} instruments`);
    return {
      venue: this.venue,
      marketType: type,
      receivedAt,
      instruments: normalized.instruments,
      rejectedRows: normalized.rejectedRows
    };
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    const type = gateMarketType(marketType);
    if (type === "spot") {
      throw new PublicVenueAdapterError(this.venue, "unsupported", "unfiltered SPOT tickers omit bid/ask sizes; use ticker() for executable top book");
    }
    const rows = await this.fetchArray("/api/v4/futures/usdt/tickers", {}, signal);
    const receivedAt = this.now();
    const tickers: PublicTopBook[] = [];
    const rejectedRows: AdapterValidationIssue[] = [];
    rows.forEach((row, index) => {
      try {
        tickers.push(normalizeGateTicker(row, type, receivedAt));
      } catch (error) {
        rejectedRows.push({ index, instrumentId: rawTickerInstrumentId(row, type), message: errorMessage(error) });
      }
    });
    requireAtLeastOneValid(rows, tickers, `${type} tickers`);
    return { venue: this.venue, marketType: type, receivedAt, tickers, rejectedRows };
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    const type = gateMarketType(marketType);
    const rows = await this.fetchArray(
      type === "spot" ? "/api/v4/spot/tickers" : "/api/v4/futures/usdt/tickers",
      type === "spot" ? { currency_pair: normalizedId } : { contract: normalizedId },
      signal
    );
    const matching = exactlyOneMatchingTicker(rows, normalizedId, type);
    return normalizeGateTicker(matching, type, this.now());
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    const instrumentId = normalizedInstrumentId(request.instrumentId);
    const type = gateMarketType(request.marketType);
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DEPTH_LEVELS) {
      throw validation(`depth limit must be an integer between 1 and ${MAX_DEPTH_LEVELS}`);
    }
    const path = type === "spot" ? "/api/v4/spot/order_book" : "/api/v4/futures/usdt/order_book";
    const query: Record<string, string> = { interval: "0", limit: String(limit), with_id: "true" };
    query[type === "spot" ? "currency_pair" : "contract"] = instrumentId;
    const row = await this.fetchObject(path, query, signal);
    return normalizeGateDepth(row, { instrumentId, marketType: type, limit }, this.now());
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    if (!normalizedId.endsWith("_USDT")) throw validation("funding is only available for Gate USDT perpetual instruments");
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const currentRequest = this.fetchObject(`/api/v4/futures/usdt/contracts/${encodeURIComponent(normalizedId)}`, {}, options.signal);
    const historyRequest = this.fetchArray("/api/v4/futures/usdt/funding_rate", { contract: normalizedId, limit: String(historyLimit) }, options.signal);
    const [currentResult, historyResult] = await Promise.allSettled([currentRequest, historyRequest]);
    if (options.signal?.aborted) throw cancelled();
    if (currentResult.status === "rejected") throw currentResult.reason;
    const historyRows = historyResult.status === "fulfilled" ? historyResult.value : [];
    const historyErrors = historyResult.status === "rejected" ? [`funding history: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeGateFunding(currentResult.value, historyRows, normalizedId, this.now(), historyErrors);
  }

  private async fetchArray(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown[]> {
    const parsed = await this.fetchJson(path, query, signal);
    if (!Array.isArray(parsed)) throw validation("response must be an array");
    return parsed;
  }

  private async fetchObject(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = await this.fetchJson(path, query, signal);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("response must be an object");
    return parsed as Record<string, unknown>;
  }

  private async fetchJson(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw cancelled();
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
      const response = await this.fetcher(url, { method: "GET", signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      const parsed = parseJson(body);
      const exchangeError = gateExchangeError(parsed);
      if (response.status === 429 || exchangeError?.label === "TOO_MANY_REQUESTS") {
        throw new PublicVenueAdapterError(this.venue, "rate-limit", exchangeError?.message ?? `HTTP ${response.status}`, response.status);
      }
      if (!response.ok) {
        if (exchangeError) throw new PublicVenueAdapterError(this.venue, "exchange", exchangeError.message, response.status);
        throw new PublicVenueAdapterError(this.venue, "http", `HTTP ${response.status}`, response.status);
      }
      if (parsed === INVALID_JSON) throw validation("response is not valid JSON");
      if (exchangeError) throw new PublicVenueAdapterError(this.venue, "exchange", exchangeError.message, response.status);
      return parsed;
    } catch (error) {
      if (error instanceof PublicVenueAdapterError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new PublicVenueAdapterError(this.venue, "timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new PublicVenueAdapterError(this.venue, "http", `network request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
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

function gateExchangeError(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as GateErrorEnvelope;
  if (typeof row.label !== "string" || !row.label) return undefined;
  const detail = typeof row.detail === "string" && row.detail ? `: ${row.detail}` : "";
  const message = typeof row.message === "string" && row.message ? row.message : row.label;
  return { label: row.label, message: `${row.label}: ${message}${detail}` };
}

function validatedBaseUrl(value: string) {
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

function exactlyOneMatchingTicker(rows: unknown[], instrumentId: string, marketType: GateMarketType) {
  const matching = rows.filter((row) => rawTickerInstrumentId(row, marketType) === instrumentId);
  if (matching.length !== 1) throw validation(`ticker response must contain exactly one ${instrumentId} row`);
  return matching[0];
}

function rawTickerInstrumentId(row: unknown, marketType: GateMarketType) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as { currency_pair?: unknown; contract?: unknown };
  const value = marketType === "spot" ? record.currency_pair : record.contract;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function normalizedInstrumentId(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(normalized)) throw validation("instrumentId contains invalid characters");
  return normalized;
}

function requireAtLeastOneValid(source: unknown[], normalized: unknown[], label: string) {
  if (source.length === 0) throw validation(`${label} response is empty`);
  if (normalized.length === 0) throw validation(`${label} response contains no valid rows`);
}

function boundedHistoryLimit(value: number | undefined) {
  if (value === undefined) return 100;
  if (!Number.isFinite(value)) throw validation("historyLimit must be finite");
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}

function validation(message: string) {
  return new PublicVenueAdapterError("gate", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("gate", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
