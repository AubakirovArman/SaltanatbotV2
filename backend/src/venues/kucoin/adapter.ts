import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { kucoinMarketType, normalizeKucoinDepth, normalizeKucoinFunding, normalizeKucoinInstruments, normalizeKucoinTicker } from "./normalize.js";
import { KucoinPublicTransport, type KucoinTransportOptions } from "./transport.js";
import { errorMessage, positiveMillis, record, validation, venueSymbol } from "./validation.js";

const MAX_DEPTH_LEVELS = 100;
const MAX_INSTRUMENT_ROWS = 10_000;
const MAX_TICKER_ROWS = 10_000;
const MAX_FUNDING_HISTORY = 100;

export const KUCOIN_PUBLIC_CAPABILITIES = Object.freeze({
  venue: "kucoin",
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
  demoEnvironment: false,
  scopes: [
    { product: "spot", operation: "public-data", status: "implemented" },
    { product: "perpetual", operation: "public-data", status: "implemented" }
  ]
} satisfies VenueCapabilityManifest);

export interface KucoinPublicAdapterOptions extends KucoinTransportOptions {
  now?: () => number;
}

/** Credential-free KuCoin Classic public REST adapter. Streaming reconstruction lives in orderBook.ts. */
export class KucoinPublicAdapter implements PublicVenueAdapter {
  readonly venue = "kucoin";
  private readonly transport: KucoinPublicTransport;
  private readonly now: () => number;

  constructor(options: KucoinPublicAdapterOptions = {}) {
    this.transport = new KucoinPublicTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(KUCOIN_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    const type = kucoinMarketType(marketType);
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", type === "spot" ? "/api/v2/symbols" : "/api/v1/contracts/active", {}, signal);
    const rows = boundedRows(raw, `${type} instruments`, MAX_INSTRUMENT_ROWS);
    const normalized = normalizeKucoinInstruments(rows, type);
    requireAtLeastOneValid(rows, normalized.instruments, `${type} instruments`);
    return { venue: this.venue, marketType: type, receivedAt: this.now(), ...normalized };
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    const type = kucoinMarketType(marketType);
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", type === "spot" ? "/api/v1/market/allTickers" : "/api/v1/allTickers", {}, signal);
    const receivedAt = this.now();
    const { rows, exchangeTs } = type === "spot" ? spotTickerRows(raw) : { rows: boundedRows(raw, "perpetual tickers", MAX_TICKER_ROWS), exchangeTs: undefined };
    const tickers: PublicTopBook[] = [];
    const rejectedRows: AdapterValidationIssue[] = [];
    rows.forEach((row, index) => {
      try {
        tickers.push(normalizeKucoinTicker(row, type, receivedAt, exchangeTs));
      } catch (error) {
        rejectedRows.push({ index, instrumentId: rawSymbol(row), message: errorMessage(error) });
      }
    });
    requireAtLeastOneValid(rows, tickers, `${type} tickers`);
    return { venue: this.venue, marketType: type, receivedAt, tickers, rejectedRows };
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    const id = venueSymbol(instrumentId, "instrumentId");
    const type = kucoinMarketType(marketType);
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", type === "spot" ? "/api/v1/market/orderbook/level1" : "/api/v1/ticker", { symbol: id }, signal);
    const row = record(raw, "ticker");
    if (row.symbol === undefined) row.symbol = id;
    else if (venueSymbol(row.symbol, "ticker.symbol") !== id) throw validation("ticker symbol does not match request");
    return normalizeKucoinTicker(row, type, this.now());
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    const instrumentId = venueSymbol(request.instrumentId, "instrumentId");
    const type = kucoinMarketType(request.marketType);
    const limit = boundedDepthLimit(request.limit);
    const sourceDepth = limit <= 20 ? 20 : 100;
    const path = type === "spot" ? `/api/v1/market/orderbook/level2_${sourceDepth}` : `/api/v1/level2/depth${sourceDepth}`;
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", path, { symbol: instrumentId }, signal);
    return normalizeKucoinDepth(raw, { instrumentId, marketType: type, limit }, this.now());
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const id = venueSymbol(instrumentId, "instrumentId");
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const current = await this.transport.get("futures", `/api/v1/funding-rate/${encodeURIComponent(id)}/current`, {}, options.signal);
    if (options.signal?.aborted) throw new PublicVenueAdapterError(this.venue, "cancelled", "request was cancelled");
    const receivedAt = this.now();
    const currentRow = record(current, "current funding");
    const granularity = Number(currentRow.granularity);
    const historyWindow = Number.isSafeInteger(granularity) && granularity > 0 ? Math.min(30 * 86_400_000, granularity * historyLimit * 2) : 30 * 86_400_000;
    const to = positiveMillis(receivedAt, "receivedAt");
    const from = Math.max(1, to - historyWindow);
    const historyResult = await Promise.allSettled([this.transport.get("futures", "/api/v1/contract/funding-rates", { symbol: id, from: String(from), to: String(to) }, options.signal)]);
    if (options.signal?.aborted) throw new PublicVenueAdapterError(this.venue, "cancelled", "request was cancelled");
    // The documented public endpoint returns newest settlement first.
    const historyRows = historyResult[0]!.status === "fulfilled" ? boundedRows(historyResult[0]!.value, "funding history", 2_000).slice(0, historyLimit) : [];
    const historyErrors = historyResult[0]!.status === "rejected" ? [`funding history: ${errorMessage(historyResult[0]!.reason)}`] : [];
    return normalizeKucoinFunding(current, historyRows, id, receivedAt, historyErrors);
  }
}

function spotTickerRows(raw: unknown): { rows: unknown[]; exchangeTs: number } {
  const envelope = record(raw, "spot tickers");
  const rows = boundedRows(envelope.ticker, "spot tickers.ticker", MAX_TICKER_ROWS);
  return { rows, exchangeTs: positiveMillis(envelope.time, "spot tickers.time") };
}

function boundedRows(value: unknown, label: string, maximum: number): unknown[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : undefined;
  if (!rows) throw validation(`${label} response must be an array or object`);
  if (rows.length > maximum) throw validation(`${label} exceeds ${maximum} rows`);
  return rows;
}

function boundedDepthLimit(value: number | undefined): number {
  const parsed = value ?? 20;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DEPTH_LEVELS) {
    throw validation(`depth limit must be an integer between 1 and ${MAX_DEPTH_LEVELS}`);
  }
  return parsed;
}

function boundedHistoryLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FUNDING_HISTORY) {
    throw validation(`historyLimit must be an integer between 1 and ${MAX_FUNDING_HISTORY}`);
  }
  return value;
}

function requireAtLeastOneValid(source: unknown[], normalized: unknown[], label: string): void {
  if (source.length === 0) throw validation(`${label} response is empty`);
  if (normalized.length === 0) throw validation(`${label} response contains no valid rows`);
}

function rawSymbol(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const symbol = (value as { symbol?: unknown }).symbol;
  return typeof symbol === "string" ? symbol.toUpperCase() : undefined;
}
