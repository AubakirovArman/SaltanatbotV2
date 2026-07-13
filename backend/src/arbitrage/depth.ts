import type { ArbitrageDepthLeg, ArbitrageDepthResponse, ArbitrageExchange, ArbitrageMarket } from "./types.js";

type Level = [number, number];
type OrderBook = { bids: Level[]; asks: Level[] };
const MAX_SANE_ABSOLUTE_SPREAD_BPS = 2_000;

interface BinanceDepth { bids?: Array<[string, string]>; asks?: Array<[string, string]> }
interface BybitDepth { retCode?: number; retMsg?: string; result?: { b?: Array<[string, string]>; a?: Array<[string, string]>; ts?: number } }

interface DepthOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; cacheTtlMs?: number }
export interface DepthRequest { symbol: string; spotExchange: ArbitrageExchange; futuresExchange: ArbitrageExchange; notionalUsd: number }

/** Reads bounded public order-book snapshots and estimates VWAP for both arbitrage legs. */
export class ArbitrageDepthService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { expiresAt: number; value: ArbitrageDepthResponse }>();
  private readonly bookCache = new Map<string, { expiresAt: number; value: OrderBook }>();
  private readonly bookInFlight = new Map<string, Promise<OrderBook>>();

  constructor(options: DepthOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 1_500;
  }

  async analyze(input: DepthRequest): Promise<ArbitrageDepthResponse> {
    const key = `${input.symbol}:${input.spotExchange}:${input.futuresExchange}:${input.notionalUsd}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt >= this.now()) return cached.value;
    const capturedAt = this.now();
    const [spotBook, perpetualBook] = await Promise.all([
      this.book(input.spotExchange, "spot", input.symbol),
      this.book(input.futuresExchange, "perpetual", input.symbol)
    ]);
    const spot = walkDepth(input.spotExchange, "spot", "buy", spotBook.asks, input.notionalUsd, capturedAt);
    const perpetual = walkDepth(input.futuresExchange, "perpetual", "sell", perpetualBook.bids, input.notionalUsd, capturedAt);
    const grossSpreadBps = spot.averagePrice > 0 && perpetual.averagePrice > 0
      ? ((perpetual.averagePrice - spot.averagePrice) / spot.averagePrice) * 10_000
      : 0;
    if (Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) throw new Error("Order-book basis exceeds the safety boundary");
    const value = { symbol: input.symbol, requestedNotionalUsd: input.notionalUsd, spot, perpetual, grossSpreadBps, complete: spot.complete && perpetual.complete, capturedAt };
    this.cache.set(key, { expiresAt: capturedAt + this.cacheTtlMs, value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value ?? "");
    return value;
  }

  private async book(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string): Promise<OrderBook> {
    const key = `${exchange}:${market}:${symbol}`;
    const cached = this.bookCache.get(key);
    if (cached && cached.expiresAt >= this.now()) return cached.value;
    let pending = this.bookInFlight.get(key);
    pending ??= this.fetchBook(exchange, market, symbol).finally(() => this.bookInFlight.delete(key));
    this.bookInFlight.set(key, pending);
    const value = await pending;
    this.bookCache.set(key, { expiresAt: this.now() + this.cacheTtlMs, value });
    if (this.bookCache.size > 400) this.bookCache.delete(this.bookCache.keys().next().value ?? "");
    return value;
  }

  private async fetchBook(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string): Promise<OrderBook> {
    const url = exchange === "binance"
      ? `${market === "spot" ? "https://api.binance.com/api/v3/depth" : "https://fapi.binance.com/fapi/v1/depth"}?symbol=${encodeURIComponent(symbol)}&limit=100`
      : `https://api.bybit.com/v5/market/orderbook?category=${market === "spot" ? "spot" : "linear"}&symbol=${encodeURIComponent(symbol)}&limit=100`;
    const payload = await this.fetchJson<BinanceDepth | BybitDepth>(url);
    if (exchange === "bybit") {
      const envelope = payload as BybitDepth;
      if (envelope.retCode !== 0) throw new Error(`Bybit order book: ${envelope.retMsg ?? envelope.retCode}`);
      return { bids: levels(envelope.result?.b), asks: levels(envelope.result?.a) };
    }
    const book = payload as BinanceDepth;
    return { bids: levels(book.bids), asks: levels(book.asks) };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Order book HTTP ${response.status}`);
      return await response.json() as T;
    } finally { clearTimeout(timer); }
  }
}

export function walkDepth(exchange: ArbitrageExchange, market: ArbitrageMarket, side: "buy" | "sell", book: Level[], requestedNotionalUsd: number, capturedAt: number): ArbitrageDepthLeg {
  let remaining = requestedNotionalUsd;
  let quantity = 0;
  let filledNotionalUsd = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableQuantity] of book) {
    if (remaining <= 1e-8) break;
    const takeNotional = Math.min(remaining, price * availableQuantity);
    const takeQuantity = takeNotional / price;
    quantity += takeQuantity;
    filledNotionalUsd += takeNotional;
    remaining -= takeNotional;
    worstPrice = price;
    levelsUsed += 1;
  }
  const topPrice = book[0]?.[0] ?? 0;
  const averagePrice = quantity > 0 ? filledNotionalUsd / quantity : 0;
  const directionalMove = side === "buy" ? averagePrice - topPrice : topPrice - averagePrice;
  return {
    exchange, market, side, requestedNotionalUsd, filledNotionalUsd, quantity, averagePrice, worstPrice, topPrice,
    slippageBps: topPrice > 0 ? Math.max(0, directionalMove / topPrice * 10_000) : 0,
    levelsUsed, complete: remaining <= Math.max(0.01, requestedNotionalUsd * 1e-8), capturedAt
  };
}

function levels(input: Array<[string, string]> | undefined): Level[] {
  return (input ?? []).map(([price, quantity]) => [Number(price), Number(quantity)] as Level)
    .filter(([price, quantity]) => Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity > 0);
}
