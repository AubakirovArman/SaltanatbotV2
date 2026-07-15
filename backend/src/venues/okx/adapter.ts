import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import { readBoundedText } from "../../http/boundedResponse.js";
import type { AdapterValidationIssue, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { normalizeOkxDepth, normalizeOkxFunding, normalizeOkxInstruments, normalizeOkxTicker, okxInstrumentType } from "./normalize.js";
import type { OkxInstrumentType } from "./types.js";

const DEFAULT_BASE_URL = "https://www.okx.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export const OKX_PUBLIC_CAPABILITIES: VenueCapabilityManifest = Object.freeze({
  venue: "okx",
  publicData: true,
  spot: true,
  margin: false,
  perpetual: true,
  datedFuture: true,
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

export interface OkxPublicAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
  maxPayloadBytes?: number;
}

/** Read-only OKX REST adapter. It never accepts credentials or calls private endpoints. */
export class OkxPublicAdapter implements PublicVenueAdapter {
  readonly venue = "okx";
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly baseUrl: URL;
  private readonly maxPayloadBytes: number;

  constructor(options: OkxPublicAdapterOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
    this.baseUrl = validatedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  }

  capabilities(): VenueCapabilityManifest {
    return { ...OKX_PUBLIC_CAPABILITIES };
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    const instrumentType = okxInstrumentType(marketType);
    const rows = await this.fetchRows("/api/v5/public/instruments", { instType: instrumentType }, signal);
    const receivedAt = this.now();
    const normalized = normalizeOkxInstruments(rows, instrumentType);
    requireAtLeastOneValid(rows, normalized.instruments, `${instrumentType} instruments`);
    return {
      venue: this.venue,
      marketType,
      receivedAt,
      instruments: normalized.instruments,
      rejectedRows: normalized.rejectedRows
    };
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    const instrumentType = okxInstrumentType(marketType);
    const rows = await this.fetchRows("/api/v5/market/tickers", { instType: instrumentType }, signal);
    const receivedAt = this.now();
    const tickers: PublicTopBook[] = [];
    const rejectedRows: AdapterValidationIssue[] = [];
    rows.forEach((row, index) => {
      try {
        tickers.push(normalizeOkxTicker(row, instrumentType, receivedAt));
      } catch (error) {
        rejectedRows.push({ index, instrumentId: rawInstrumentId(row), message: errorMessage(error) });
      }
    });
    requireAtLeastOneValid(rows, tickers, `${instrumentType} tickers`);
    return { venue: this.venue, marketType, receivedAt, tickers, rejectedRows };
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    const instrumentType = okxInstrumentType(marketType);
    const rows = await this.fetchRows("/api/v5/market/ticker", { instId: normalizedId }, signal);
    const matching = exactlyOneMatchingRow(rows, normalizedId, "ticker");
    return normalizeOkxTicker(matching, instrumentType, this.now());
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    const instrumentId = normalizedInstrumentId(request.instrumentId);
    okxInstrumentType(request.marketType);
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400) {
      throw validation("depth limit must be an integer between 1 and 400");
    }
    const rows = await this.fetchRows("/api/v5/market/books", { instId: instrumentId, sz: String(limit) }, signal);
    if (rows.length !== 1) throw validation(`depth response must contain exactly one row, received ${rows.length}`);
    return normalizeOkxDepth(rows[0], { instrumentId, marketType: request.marketType }, this.now());
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    if (!normalizedId.endsWith("-SWAP")) throw validation("funding is only available for OKX SWAP instruments");
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const currentRequest = this.fetchRows("/api/v5/public/funding-rate", { instId: normalizedId }, options.signal);
    const historyRequest = this.fetchRows("/api/v5/public/funding-rate-history", { instId: normalizedId, limit: String(historyLimit) }, options.signal);
    const [currentResult, historyResult] = await Promise.allSettled([currentRequest, historyRequest]);
    if (options.signal?.aborted) throw cancelled();
    if (currentResult.status === "rejected") throw currentResult.reason;
    const current = exactlyOneMatchingRow(currentResult.value, normalizedId, "funding");
    const historyRows = historyResult.status === "fulfilled" ? historyResult.value : [];
    const historyErrors = historyResult.status === "rejected" ? [`funding history: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeOkxFunding(current, historyRows, normalizedId, this.now(), historyErrors);
  }

  private async fetchRows(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown[]> {
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
      const response = await this.fetcher(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      if (response.status === 429) throw new PublicVenueAdapterError(this.venue, "rate-limit", "HTTP 429", response.status);
      if (!response.ok) throw new PublicVenueAdapterError(this.venue, "http", `HTTP ${response.status}`, response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw validation("response is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("response envelope must be an object");
      const envelope = parsed as { code?: unknown; msg?: unknown; data?: unknown };
      if (envelope.code !== "0") {
        const message = typeof envelope.msg === "string" && envelope.msg ? envelope.msg : `exchange code ${String(envelope.code)}`;
        throw new PublicVenueAdapterError(this.venue, "exchange", message);
      }
      if (!Array.isArray(envelope.data)) throw validation("response data must be an array");
      return envelope.data;
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

function exactlyOneMatchingRow(rows: unknown[], instrumentId: string, label: string) {
  const matching = rows.filter((row) => rawInstrumentId(row) === instrumentId);
  if (matching.length !== 1) throw validation(`${label} response must contain exactly one ${instrumentId} row`);
  return matching[0];
}

function rawInstrumentId(row: unknown) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const value = (row as { instId?: unknown }).instId;
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
  return new PublicVenueAdapterError("okx", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("okx", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
