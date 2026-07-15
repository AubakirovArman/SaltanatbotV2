import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { mexcMarketType, normalizeMexcDepth, normalizeMexcFunding, normalizeMexcInstruments, normalizeMexcSpotTicker, topBookFromMexcDepth } from "./normalize.js";
import { MexcPublicTransport, type MexcTransportOptions } from "./transport.js";
import { errorMessage, instrumentId, record, validation } from "./validation.js";

const MAX_DEPTH_LEVELS = 500;
const MAX_INSTRUMENT_ROWS = 10_000;
const MAX_TICKER_ROWS = 10_000;
const MAX_FUNDING_HISTORY = 100;

export const MEXC_PUBLIC_CAPABILITIES = Object.freeze({
  venue: "mexc",
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

export interface MexcPublicAdapterOptions extends MexcTransportOptions {
  now?: () => number;
}

/** Public-only MEXC REST adapter; it never constructs signatures, keys or order requests. */
export class MexcPublicAdapter implements PublicVenueAdapter {
  readonly venue = "mexc";
  private readonly transport: MexcPublicTransport;
  private readonly now: () => number;

  constructor(options: MexcPublicAdapterOptions = {}) {
    this.transport = new MexcPublicTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(MEXC_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    const type = mexcMarketType(marketType);
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", type === "spot" ? "/api/v3/exchangeInfo" : "/api/v1/contract/detail", {}, signal);
    const rows = type === "spot" ? spotInstrumentRows(raw) : boundedRows(raw, "perpetual instruments", MAX_INSTRUMENT_ROWS);
    const normalized = normalizeMexcInstruments(rows, type);
    requireAtLeastOneValid(rows, normalized.instruments, `${type} instruments`);
    return { venue: this.venue, marketType: type, receivedAt: this.now(), ...normalized };
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    const type = mexcMarketType(marketType);
    if (type === "perpetual") {
      throw new PublicVenueAdapterError(this.venue, "unsupported", "MEXC perpetual bulk ticker omits executable bid/ask sizes; use ticker() backed by depth");
    }
    const raw = await this.transport.get("spot", "/api/v3/ticker/bookTicker", {}, signal);
    const rows = boundedRows(raw, "spot tickers", MAX_TICKER_ROWS);
    const receivedAt = this.now();
    const tickers: PublicTopBook[] = [];
    const rejectedRows: AdapterValidationIssue[] = [];
    rows.forEach((row, index) => {
      try {
        tickers.push(normalizeMexcSpotTicker(row, receivedAt));
      } catch (error) {
        rejectedRows.push({ index, instrumentId: rawSymbol(row), message: errorMessage(error) });
      }
    });
    requireAtLeastOneValid(rows, tickers, "spot tickers");
    return { venue: this.venue, marketType: "spot", receivedAt, tickers, rejectedRows };
  }

  async ticker(instrumentIdValue: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    const id = instrumentId(instrumentIdValue, "instrumentId");
    const type = mexcMarketType(marketType);
    if (type === "spot") {
      const raw = await this.transport.get("spot", "/api/v3/ticker/bookTicker", { symbol: id }, signal);
      const row = record(raw, "ticker");
      if (instrumentId(row.symbol, "ticker.symbol") !== id) throw validation("ticker symbol does not match request");
      return normalizeMexcSpotTicker(row, this.now());
    }
    const depth = await this.depth({ instrumentId: id, marketType: "perpetual", limit: 1 }, signal);
    return topBookFromMexcDepth(depth);
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    const id = instrumentId(request.instrumentId, "instrumentId");
    const type = mexcMarketType(request.marketType);
    const limit = boundedDepthLimit(request.limit);
    const path = type === "spot" ? "/api/v3/depth" : `/api/v1/contract/depth/${encodeURIComponent(id)}`;
    const query: Record<string, string> = type === "spot" ? { symbol: id, limit: String(limit) } : { limit: String(limit) };
    const raw = await this.transport.get(type === "spot" ? "spot" : "futures", path, query, signal);
    return normalizeMexcDepth(raw, { instrumentId: id, marketType: type, limit }, this.now());
  }

  async funding(instrumentIdValue: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const id = instrumentId(instrumentIdValue, "instrumentId");
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const [currentResult, historyResult] = await Promise.allSettled([
      this.transport.get("futures", `/api/v1/contract/funding_rate/${encodeURIComponent(id)}`, {}, options.signal),
      this.transport.get("futures", "/api/v1/contract/funding_rate/history", { symbol: id, page_num: "1", page_size: String(historyLimit) }, options.signal)
    ]);
    if (options.signal?.aborted) throw new PublicVenueAdapterError(this.venue, "cancelled", "request was cancelled");
    if (currentResult.status === "rejected") throw currentResult.reason;
    const historyRows = historyResult.status === "fulfilled" ? fundingHistoryRows(historyResult.value, historyLimit) : [];
    const historyErrors = historyResult.status === "rejected" ? [`funding history: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeMexcFunding(currentResult.value, historyRows, id, this.now(), historyErrors);
  }
}

function spotInstrumentRows(raw: unknown): unknown[] {
  const row = record(raw, "spot instruments");
  if (Array.isArray(row.symbols)) return boundedRows(row.symbols, "spot instruments.symbols", MAX_INSTRUMENT_ROWS);
  if (row.symbol !== undefined) return [row];
  throw validation("spot instruments response must contain symbols");
}

function fundingHistoryRows(raw: unknown, limit: number): unknown[] {
  const row = record(raw, "funding history");
  return boundedRows(row.resultList, "funding history.resultList", MAX_FUNDING_HISTORY).slice(0, limit);
}

function boundedRows(value: unknown, label: string, maximum: number): unknown[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : undefined;
  if (!rows) throw validation(`${label} response must be an array or object`);
  if (rows.length > maximum) throw validation(`${label} exceeds ${maximum} rows`);
  return rows;
}

function boundedDepthLimit(value: number | undefined): number {
  const parsed = value ?? 50;
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
