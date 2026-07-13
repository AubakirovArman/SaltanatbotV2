import type {
  ArbitrageExchange,
  ArbitrageMarket,
  ArbitrageOpportunity,
  ArbitrageScanResponse,
  ArbitrageSourceStatus,
  ArbitrageVenueQuote
} from "./types.js";

const BINANCE_SPOT_BOOK = "https://api.binance.com/api/v3/ticker/bookTicker";
const BINANCE_FUTURES_BOOK = "https://fapi.binance.com/fapi/v1/ticker/bookTicker";
const BINANCE_FUNDING = "https://fapi.binance.com/fapi/v1/premiumIndex";
const BYBIT_SPOT_TICKERS = "https://api.bybit.com/v5/market/tickers?category=spot";
const BYBIT_LINEAR_TICKERS = "https://api.bybit.com/v5/market/tickers?category=linear";
// A very large basis is more likely a ticker collision, redenomination or stale market than an
// executable arbitrage. Fail closed instead of ranking it as profit.
const MAX_SANE_ABSOLUTE_SPREAD_BPS = 2_000;

interface BinanceBookRow {
  symbol?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
}

interface BinanceFundingRow {
  symbol?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

interface BybitTickerRow {
  symbol?: string;
  bid1Price?: string;
  bid1Size?: string;
  ask1Price?: string;
  ask1Size?: string;
  fundingRate?: string;
  nextFundingTime?: string;
}

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
  result?: { list?: BybitTickerRow[] };
}

interface RawSnapshot {
  updatedAt: number;
  spot: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>;
  perpetual: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>;
  sources: ArbitrageSourceStatus[];
}

interface ServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
}

export interface ArbitrageScanOptions {
  estimatedTotalCostBps: number;
  minSpreadBps: number;
  limit: number;
}

/** Aggregates public best bid/ask snapshots without requiring exchange credentials. */
export class ArbitrageScannerService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private cached?: RawSnapshot;
  private inFlight?: Promise<RawSnapshot>;

  constructor(options: ServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.maxStaleMs = options.maxStaleMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async scan(options: ArbitrageScanOptions): Promise<ArbitrageScanResponse> {
    const { snapshot, stale } = await this.getSnapshot();
    const candidates = buildOpportunities(snapshot, options.estimatedTotalCostBps);
    const opportunities = candidates
      .filter((row) => row.grossSpreadBps >= options.minSpreadBps)
      .slice(0, options.limit);
    return {
      updatedAt: snapshot.updatedAt,
      stale,
      scannedSymbols: new Set(candidates.map((row) => row.symbol)).size,
      estimatedTotalCostBps: options.estimatedTotalCostBps,
      opportunities,
      sources: snapshot.sources
    };
  }

  private async getSnapshot(): Promise<{ snapshot: RawSnapshot; stale: boolean }> {
    if (this.cached && this.now() - this.cached.updatedAt <= this.cacheTtlMs) return { snapshot: this.cached, stale: false };
    this.inFlight ??= this.fetchSnapshot().finally(() => { this.inFlight = undefined; });
    const next = await this.inFlight;
    const hasCrossVenueRoute = routeCount(next) > 0;
    if (!hasCrossVenueRoute && this.cached && this.now() - this.cached.updatedAt <= this.maxStaleMs) {
      return { snapshot: { ...this.cached, sources: next.sources }, stale: true };
    }
    this.cached = next;
    return { snapshot: next, stale: false };
  }

  private async fetchSnapshot(): Promise<RawSnapshot> {
    const requests = await Promise.allSettled([
      this.fetchJson<BinanceBookRow[]>(BINANCE_SPOT_BOOK),
      this.fetchJson<BinanceBookRow[]>(BINANCE_FUTURES_BOOK),
      this.fetchJson<BinanceFundingRow[]>(BINANCE_FUNDING),
      this.fetchJson<BybitEnvelope>(BYBIT_SPOT_TICKERS).then(assertBybitEnvelope),
      this.fetchJson<BybitEnvelope>(BYBIT_LINEAR_TICKERS).then(assertBybitEnvelope)
    ]);
    const binanceSpot = result(requests[0]);
    const binanceFutures = result(requests[1]);
    const binanceFunding = result(requests[2]);
    const bybitSpot = result(requests[3]);
    const bybitLinear = result(requests[4]);
    const sources: ArbitrageSourceStatus[] = [
      source("binance", "spot", requests[0]),
      combinedSource("binance", "perpetual", requests[1], requests[2]),
      source("bybit", "spot", requests[3]),
      source("bybit", "perpetual", requests[4])
    ];
    return {
      updatedAt: this.now(),
      spot: {
        binance: normalizeBinance(binanceSpot ?? [], "spot"),
        bybit: normalizeBybit(bybitSpot, "spot")
      },
      perpetual: {
        binance: normalizeBinancePerpetual(binanceFutures ?? [], binanceFunding ?? []),
        bybit: normalizeBybit(bybitLinear, "perpetual")
      },
      sources
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildOpportunities(snapshot: RawSnapshot, estimatedTotalCostBps: number): ArbitrageOpportunity[] {
  const capturedAt = snapshot.updatedAt;
  const routes: Array<[ArbitrageExchange, ArbitrageExchange]> = [["binance", "bybit"], ["bybit", "binance"]];
  const opportunities: ArbitrageOpportunity[] = [];
  for (const [spotExchange, futuresExchange] of routes) {
    for (const [symbol, spot] of snapshot.spot[spotExchange]) {
      const futures = snapshot.perpetual[futuresExchange].get(symbol);
      if (!futures) continue;
      const grossSpreadBps = ((futures.bid - spot.ask) / spot.ask) * 10_000;
      if (Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) continue;
      opportunities.push({
        id: `${symbol}:${spotExchange}:${futuresExchange}`,
        symbol,
        spotExchange,
        futuresExchange,
        spotAsk: spot.ask,
        spotAskSize: spot.askSize,
        futuresBid: futures.bid,
        futuresBidSize: futures.bidSize,
        grossSpreadBps,
        estimatedTotalCostBps,
        netEdgeBps: grossSpreadBps - estimatedTotalCostBps,
        topBookCapacityUsd: Math.min(spot.ask * spot.askSize, futures.bid * futures.bidSize),
        fundingRate: futures.fundingRate ?? 0,
        nextFundingTime: futures.nextFundingTime,
        capturedAt
      });
    }
  }
  return opportunities.sort((left, right) => right.netEdgeBps - left.netEdgeBps || right.topBookCapacityUsd - left.topBookCapacityUsd);
}

function normalizeBinance(rows: BinanceBookRow[], market: ArbitrageMarket): Map<string, ArbitrageVenueQuote> {
  return normalizeRows(rows, "binance", market, (row) => ({
    symbol: row.symbol,
    bid: row.bidPrice,
    bidSize: row.bidQty,
    ask: row.askPrice,
    askSize: row.askQty
  }));
}

function normalizeBinancePerpetual(rows: BinanceBookRow[], fundingRows: BinanceFundingRow[]): Map<string, ArbitrageVenueQuote> {
  const funding = new Map(fundingRows
    .filter((row) => row.symbol && finite(row.nextFundingTime) > 0 && row.lastFundingRate !== "")
    .map((row) => [row.symbol as string, row]));
  return normalizeRows(rows.filter((row) => row.symbol && funding.has(row.symbol)), "binance", "perpetual", (row) => {
    const rate = funding.get(row.symbol ?? "");
    return {
      symbol: row.symbol,
      bid: row.bidPrice,
      bidSize: row.bidQty,
      ask: row.askPrice,
      askSize: row.askQty,
      fundingRate: rate?.lastFundingRate,
      nextFundingTime: rate?.nextFundingTime
    };
  });
}

function normalizeBybit(envelope: BybitEnvelope | undefined, market: ArbitrageMarket): Map<string, ArbitrageVenueQuote> {
  if (!envelope) return new Map();
  const rows = envelope.result?.list ?? [];
  const perpetualRows = market === "perpetual"
    ? rows.filter((row) => finite(row.nextFundingTime) > 0 && row.fundingRate !== "")
    : rows;
  return normalizeRows(perpetualRows, "bybit", market, (row) => ({
    symbol: row.symbol,
    bid: row.bid1Price,
    bidSize: row.bid1Size,
    ask: row.ask1Price,
    askSize: row.ask1Size,
    fundingRate: row.fundingRate,
    nextFundingTime: row.nextFundingTime
  }));
}

function normalizeRows<T>(rows: T[], exchange: ArbitrageExchange, market: ArbitrageMarket, read: (row: T) => Record<string, unknown>): Map<string, ArbitrageVenueQuote> {
  const output = new Map<string, ArbitrageVenueQuote>();
  for (const row of rows) {
    const value = read(row);
    const symbol = String(value.symbol ?? "").toUpperCase();
    const bid = finite(value.bid);
    const ask = finite(value.ask);
    const bidSize = finite(value.bidSize);
    const askSize = finite(value.askSize);
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || bid <= 0 || ask <= 0 || bidSize <= 0 || askSize <= 0) continue;
    output.set(symbol, {
      symbol, exchange, market, bid, bidSize, ask, askSize,
      fundingRate: value.fundingRate === undefined ? undefined : finite(value.fundingRate),
      nextFundingTime: value.nextFundingTime === undefined ? undefined : finite(value.nextFundingTime)
    });
  }
  return output;
}

function result<T>(settled: PromiseSettledResult<T>): T | undefined {
  return settled.status === "fulfilled" ? settled.value : undefined;
}

function source(exchange: ArbitrageExchange, market: ArbitrageMarket, settled: PromiseSettledResult<unknown>): ArbitrageSourceStatus {
  return settled.status === "fulfilled"
    ? { exchange, market, ok: true }
    : { exchange, market, ok: false, message: errorMessage(settled.reason) };
}

function combinedSource(exchange: ArbitrageExchange, market: ArbitrageMarket, ...settled: PromiseSettledResult<unknown>[]): ArbitrageSourceStatus {
  const failed = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
  return failed ? { exchange, market, ok: false, message: errorMessage(failed.reason) } : { exchange, market, ok: true };
}

function routeCount(snapshot: RawSnapshot): number {
  let count = 0;
  for (const symbol of snapshot.spot.binance.keys()) if (snapshot.perpetual.bybit.has(symbol)) count += 1;
  for (const symbol of snapshot.spot.bybit.keys()) if (snapshot.perpetual.binance.has(symbol)) count += 1;
  return count;
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Market data unavailable");
}

function assertBybitEnvelope(envelope: BybitEnvelope): BybitEnvelope {
  if (envelope.retCode !== 0) throw new Error(`Bybit market data: ${envelope.retMsg ?? envelope.retCode}`);
  return envelope;
}
