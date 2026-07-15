import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { derivativeMarketType, normalizeKrakenFuturesDepth, normalizeKrakenFuturesInstruments, normalizeKrakenFuturesTicker, normalizeKrakenInverseFunding } from "./normalizeFutures.js";
import { normalizeKrakenSpotDepth, normalizeKrakenSpotInstruments, normalizeKrakenSpotTicker } from "./normalizeSpot.js";
import { KrakenPublicTransport, type KrakenTransportOptions } from "./transport.js";
import type { KrakenFuturesTickerRow } from "./types.js";
import { errorMessage, instrumentId, isoTimestamp, record, validation } from "./validation.js";

const MAX_SPOT_DEPTH = 500;
const MAX_FUTURES_DEPTH = 500;

export const KRAKEN_PUBLIC_CAPABILITIES = Object.freeze({
  venue: "kraken",
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
  demoEnvironment: false,
  scopes: [
    { product: "spot", operation: "public-data", status: "implemented" },
    { product: "perpetual", operation: "public-data", status: "implemented" },
    { product: "future", operation: "public-data", status: "implemented" }
  ]
} satisfies VenueCapabilityManifest);

export interface KrakenPublicAdapterOptions extends KrakenTransportOptions {
  now?: () => number;
}

/** Credential-free Kraken Spot and Derivatives REST adapter. */
export class KrakenPublicAdapter implements PublicVenueAdapter {
  readonly venue = "kraken";
  private readonly transport: KrakenPublicTransport;
  private readonly now: () => number;

  constructor(options: KrakenPublicAdapterOptions = {}) {
    this.transport = new KrakenPublicTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(KRAKEN_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    if (marketType === "spot") {
      const result = await this.transport.spot("/0/public/AssetPairs", { assetVersion: "1", aclass_base: "currency", info: "info" }, signal);
      const normalized = normalizeKrakenSpotInstruments(result);
      requireAtLeastOneValid(Object.keys(result), normalized.instruments, "spot instruments");
      return { venue: this.venue, marketType, receivedAt: this.now(), ...normalized };
    }
    requireDerivativeMarketType(marketType);
    const envelope = await this.transport.futures("/derivatives/api/v3/instruments", { contractType: ["futures_inverse", "flexible_futures"] }, signal);
    const rows = arrayField(envelope, "instruments");
    const normalized = normalizeKrakenFuturesInstruments(rows, marketType);
    requireAtLeastOneValid(rows, normalized.instruments, `${marketType} instruments`);
    return { venue: this.venue, marketType, receivedAt: this.now(), ...normalized };
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    if (marketType === "spot") {
      const result = await this.transport.spot("/0/public/Ticker", { assetVersion: "1" }, signal);
      const receivedAt = this.now();
      const tickers: PublicTopBook[] = [];
      const rejectedRows: AdapterValidationIssue[] = [];
      Object.entries(result).forEach(([key, row], index) => {
        try {
          tickers.push(normalizeKrakenSpotTicker(row, canonicalSpotInstrumentId(key), receivedAt));
        } catch (error) {
          rejectedRows.push({ index, instrumentId: safeId(key), message: errorMessage(error) });
        }
      });
      requireAtLeastOneValid(Object.keys(result), tickers, "spot tickers");
      return { venue: this.venue, marketType, receivedAt, tickers, rejectedRows };
    }
    requireDerivativeMarketType(marketType);
    const envelope = await this.transport.futures("/derivatives/api/v3/tickers", { contractType: ["futures_inverse", "flexible_futures"] }, signal);
    return normalizeDerivativeTickers(envelope, marketType, this.now());
  }

  async ticker(instrument: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    if (marketType === "spot") {
      const normalizedId = canonicalSpotInstrumentId(instrument);
      const result = await this.transport.spot("/0/public/Ticker", { pair: normalizedId, assetVersion: "1" }, signal);
      const [key, row] = exactlyOneEntry(result, "Spot ticker");
      if (canonicalSpotInstrumentId(key) !== normalizedId) throw validation(`Spot ticker response does not match ${normalizedId}`);
      return normalizeKrakenSpotTicker(row, normalizedId, this.now());
    }
    requireDerivativeMarketType(marketType);
    const symbol = instrumentId(instrument, "instrumentId");
    const envelope = await this.transport.futures("/derivatives/api/v3/tickers", { symbol }, signal);
    const row = exactlyOneTicker(arrayField(envelope, "tickers"), symbol);
    return normalizeKrakenFuturesTicker(row, marketType, serverTime(envelope), this.now());
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    if (request.marketType === "spot") {
      const instrument = canonicalSpotInstrumentId(request.instrumentId);
      const limit = boundedDepth(request.limit, MAX_SPOT_DEPTH);
      const result = await this.transport.spot("/0/public/Depth", { pair: instrument, count: String(limit), assetVersion: "1" }, signal);
      const [key, row] = exactlyOneEntry(result, "Spot depth");
      if (canonicalSpotInstrumentId(key) !== instrument) throw validation(`Spot depth response does not match ${instrument}`);
      return normalizeKrakenSpotDepth(row, { instrumentId: instrument, limit }, this.now());
    }
    requireDerivativeMarketType(request.marketType);
    const instrument = instrumentId(request.instrumentId, "instrumentId");
    const limit = boundedDepth(request.limit, MAX_FUTURES_DEPTH);
    const envelope = await this.transport.futures("/derivatives/api/v3/orderbook", { symbol: instrument }, signal);
    return normalizeKrakenFuturesDepth(envelope.orderBook, { instrumentId: instrument, marketType: request.marketType, limit }, serverTime(envelope), this.now());
  }

  async funding(instrument: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const symbol = instrumentId(instrument, "instrumentId");
    if (!symbol.startsWith("PI_")) {
      throw new PublicVenueAdapterError(this.venue, "unsupported", "funding currently supports only inverse PI_ perpetuals with proven rate units");
    }
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const tickerRequest = this.transport.futures("/derivatives/api/v3/tickers", { symbol }, options.signal);
    const historyRequest = this.transport.futures("/derivatives/api/v3/historical-funding-rates", { symbol }, options.signal);
    const [tickerResult, historyResult] = await Promise.allSettled([tickerRequest, historyRequest]);
    if (options.signal?.aborted) throw cancelled();
    if (tickerResult.status === "rejected") throw tickerResult.reason;
    const ticker = exactlyOneTicker(arrayField(tickerResult.value, "tickers"), symbol);
    const historyRows = historyResult.status === "fulfilled" ? arrayField(historyResult.value, "rates") : [];
    const sourceErrors = historyResult.status === "rejected" ? [`funding history: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeKrakenInverseFunding(ticker, historyRows, symbol, serverTime(tickerResult.value), this.now(), historyLimit, sourceErrors);
  }
}

function normalizeDerivativeTickers(envelope: Record<string, unknown>, marketType: "perpetual" | "future", receivedAt: number): PublicTickerSnapshot {
  const rows = arrayField(envelope, "tickers");
  const exchangeTs = serverTime(envelope);
  const tickers: PublicTopBook[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      const row = record(raw, `ticker[${index}]`) as KrakenFuturesTickerRow;
      if (derivativeMarketType(row.symbol, row.tag, undefined) !== marketType) return;
      tickers.push(normalizeKrakenFuturesTicker(row, marketType, exchangeTs, receivedAt));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawTickerId(raw), message: errorMessage(error) });
    }
  });
  requireAtLeastOneValid(rows, tickers, `${marketType} tickers`);
  return { venue: "kraken", marketType, receivedAt, tickers, rejectedRows };
}

function arrayField(envelope: Record<string, unknown>, key: string): unknown[] {
  const value = envelope[key];
  if (!Array.isArray(value)) throw validation(`Futures ${key} must be an array`);
  return value;
}

function serverTime(envelope: Record<string, unknown>): number {
  return isoTimestamp(envelope.serverTime, "Futures serverTime");
}

function exactlyOneTicker(rows: unknown[], symbol: string): unknown {
  const matching = rows.filter((row) => rawTickerId(row) === symbol);
  if (matching.length !== 1) throw validation(`ticker response must contain exactly one ${symbol} row`);
  return matching[0];
}

function rawTickerId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const symbol = (value as KrakenFuturesTickerRow).symbol;
  return typeof symbol === "string" ? symbol.toUpperCase() : undefined;
}

function exactlyOneEntry(result: Record<string, unknown>, label: string): [string, unknown] {
  const entries = Object.entries(result);
  if (entries.length !== 1) throw validation(`${label} response must contain exactly one row`);
  return entries[0]!;
}

function canonicalSpotInstrumentId(value: string): string {
  const parsed = instrumentId(value, "instrumentId");
  const parts = parsed.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw validation("Spot instrumentId must be BASE/QUOTE");
  return `${parts[0] === "XBT" ? "BTC" : parts[0]}/${parts[1]}`;
}

function safeId(value: string): string | undefined {
  try {
    return canonicalSpotInstrumentId(value);
  } catch {
    return undefined;
  }
}

function requireDerivativeMarketType(value: VenueMarketType): asserts value is "perpetual" | "future" {
  if (value !== "perpetual" && value !== "future") throw new PublicVenueAdapterError("kraken", "unsupported", `unsupported market type ${value}`);
}

function boundedDepth(value: number | undefined, maximum: number): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw validation(`depth limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function boundedHistoryLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value)) throw validation("historyLimit must be finite");
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function requireAtLeastOneValid(source: unknown[], normalized: unknown[], label: string): void {
  if (source.length === 0) throw validation(`${label} response is empty`);
  if (normalized.length === 0) throw validation(`${label} response contains no valid rows`);
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("kraken", "cancelled", "request was cancelled");
}
