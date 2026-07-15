import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { readBoundedText } from "../../../http/boundedResponse.js";
import { instrumentRegistry, type InstrumentRegistry } from "../../../market/instrumentRegistry.js";
import { SharedAbortableWork } from "../../sharedAbortableWork.js";
import { TriangularArbitrageEngine } from "./engine.js";
import { buildTriangularGraphCooperative } from "./graph.js";
import type { TriangularBookUpdate, TriangularMarketMetadata, TriangularOpportunity } from "./types.js";

const BINANCE_BOOK = "https://api.binance.com/api/v3/ticker/bookTicker";
const BYBIT_BOOK = "https://api.bybit.com/v5/market/tickers?category=spot";
const MAX_MARKET_PAYLOAD_BYTES = 8 * 1024 * 1024;
const TRIANGULAR_CPU_YIELD_EVERY = 64;
const processTriangularScanWork = new SharedAbortableWork<string, TriangularScanResponse>(2);
let isolatedServiceSequence = 0;

interface BinanceTicker {
  symbol?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
}

interface BybitTicker {
  symbol?: string;
  bid1Price?: string;
  bid1Size?: string;
  ask1Price?: string;
  ask1Size?: string;
}

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
  time?: number;
  result?: { list?: BybitTicker[] };
}

interface ServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  registry?: Pick<InstrumentRegistry, "snapshot">;
}

export interface TriangularScanOptions {
  venue: "binance" | "bybit";
  startAsset: string;
  startQuantity: number;
  takerFeeBps: number;
  minimumNetReturnBps: number;
  limit: number;
}

export interface TriangularScanResponse {
  updatedAt: number;
  venue: "binance" | "bybit";
  startAsset: string;
  requestedStartQuantity: number;
  scannedMarkets: number;
  scannedCycles: number;
  totalOpportunities: number;
  truncated: boolean;
  marketDataMode: "rest-top-book";
  snapshotSource: "rest-snapshot";
  executionStatus: "non-executable-candidate";
  sequenceVerified: false;
  opportunities: TriangularOpportunity[];
}

interface CachedBooks {
  expiresAt: number;
  books: Map<string, TriangularBookUpdate>;
}

/** Public, read-only triangular discovery backed by venue-wide best bid/ask snapshots. */
export class TriangularScannerService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly registry: Pick<InstrumentRegistry, "snapshot">;
  private readonly scanScope: string;
  private readonly cache = new Map<string, CachedBooks>();
  private readonly bookWork = new SharedAbortableWork<"binance" | "bybit", CachedBooks>(2);

  constructor(options: ServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 3_000;
    this.registry = options.registry ?? instrumentRegistry;
    this.scanScope = defaultServiceOptions(options) ? "public-default" : `isolated-${++isolatedServiceSequence}`;
  }

  async scan(options: TriangularScanOptions, signal?: AbortSignal): Promise<TriangularScanResponse> {
    const normalized = normalizeScanOptions(options);
    return processTriangularScanWork.run(`${this.scanScope}:${scanKey(normalized)}`, (sharedSignal) => this.scanOnce(normalized, sharedSignal), signal);
  }

  private async scanOnce(options: TriangularScanOptions, signal?: AbortSignal): Promise<TriangularScanResponse> {
    throwIfAborted(signal);
    const startAsset = options.startAsset;
    const [registrySnapshot, snapshot] = await Promise.all([abortable(this.registry.snapshot(), signal), this.books(options.venue, signal)]);
    throwIfAborted(signal);
    const evaluatedAt = this.now();
    const metadata = triangularMetadata(registrySnapshot.verifiedInstruments, options.venue, options.takerFeeBps);
    await yieldToEventLoop(signal);
    const graph = await buildTriangularGraphCooperative(metadata, new Set([startAsset]), signal);
    const engine = new TriangularArbitrageEngine(metadata, {
      startQuantities: { [startAsset]: options.startQuantity },
      minNetReturnBps: options.minimumNetReturnBps,
      maxQuoteAgeMs: Math.max(10_000, this.cacheTtlMs * 4),
      maxLegSkewMs: 3_000,
      now: () => evaluatedAt,
      marketDataMode: "rest-top-book-candidate"
    }, graph);
    let scannedMarkets = 0;
    for (const [index, market] of metadata.entries()) {
      if ((index + 1) % TRIANGULAR_CPU_YIELD_EVERY === 0) await yieldToEventLoop(signal);
      if (engine.affectedCycles(market.marketId).length === 0) continue;
      const book = snapshot.books.get(market.marketId);
      if (!book) continue;
      engine.updateBook(book);
      scannedMarkets += 1;
    }
    throwIfAborted(signal);
    const all = engine.opportunities().map(withSnapshotRisks);
    const opportunities = all.slice(0, options.limit);
    return {
      updatedAt: evaluatedAt,
      venue: options.venue,
      startAsset,
      requestedStartQuantity: options.startQuantity,
      scannedMarkets,
      scannedCycles: engine.cycles.length,
      totalOpportunities: all.length,
      truncated: all.length > opportunities.length,
      marketDataMode: "rest-top-book",
      snapshotSource: "rest-snapshot",
      executionStatus: "non-executable-candidate",
      sequenceVerified: false,
      opportunities
    };
  }

  private async books(venue: "binance" | "bybit", signal?: AbortSignal) {
    throwIfAborted(signal);
    const cached = this.cache.get(venue);
    if (cached && cached.expiresAt >= this.now()) return cached;
    return this.bookWork.run(
      venue,
      async (sharedSignal) => {
        const refreshed = this.cache.get(venue);
        if (refreshed && refreshed.expiresAt >= this.now()) return refreshed;
        const snapshot = venue === "binance" ? await this.binanceBooks(sharedSignal) : await this.bybitBooks(sharedSignal);
        const value = { expiresAt: snapshot.receivedAt + this.cacheTtlMs, books: snapshot.books };
        this.cache.set(venue, value);
        return value;
      },
      signal
    );
  }

  private async binanceBooks(signal?: AbortSignal) {
    const { payload: rows, receivedAt } = await this.fetchJson<BinanceTicker[]>(BINANCE_BOOK, signal);
    const books = new Map(
      rows.flatMap((row) => {
        const book = tickerBook("binance", row.symbol, row.bidPrice, row.bidQty, row.askPrice, row.askQty, undefined, receivedAt);
        return book ? [[book.marketId, book] as const] : [];
      })
    );
    return { books, receivedAt };
  }

  private async bybitBooks(signal?: AbortSignal) {
    const { payload: envelope, receivedAt } = await this.fetchJson<BybitEnvelope>(BYBIT_BOOK, signal);
    if (envelope.retCode !== 0) throw new Error(`Bybit market data: ${envelope.retMsg ?? envelope.retCode}`);
    const exchangeTs = positive(envelope.time);
    const books = new Map(
      (envelope.result?.list ?? []).flatMap((row) => {
        const book = tickerBook("bybit", row.symbol, row.bid1Price, row.bid1Size, row.ask1Price, row.ask1Size, exchangeTs, receivedAt);
        return book ? [[book.marketId, book] as const] : [];
      })
    );
    return { books, receivedAt };
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<{ payload: T; receivedAt: number }> {
    throwIfAborted(signal);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason ?? abortError("Triangular scan cancelled"));
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(abortError(`Triangular market data timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Triangular market data HTTP ${response.status}`);
      const body = await readBoundedText(response, MAX_MARKET_PAYLOAD_BYTES, () => new Error("Triangular market-data response is too large"));
      let payload: T;
      try {
        payload = JSON.parse(body) as T;
      } catch {
        throw new Error("Triangular market data is not valid JSON");
      }
      throwIfAborted(signal);
      return { payload, receivedAt: this.now() };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError("Triangular scan cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? abortError("Triangular scan cancelled");
}

function abortError(message: string) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function triangularMetadata(instruments: RegistryInstrument[], venue: "binance" | "bybit", takerFeeBps: number): TriangularMarketMetadata[] {
  return instruments
    .filter((instrument) => instrument.venue === venue && instrument.marketType === "spot" && instrument.status === "trading" && instrument.quantityStep > 0 && instrument.minimumQuantity > 0 && instrument.minimumNotional > 0)
    .map((instrument) => ({
      marketId: `${venue}:spot:${instrument.venueSymbol}`,
      venue,
      symbol: instrument.venueSymbol,
      baseAsset: instrument.baseAsset,
      quoteAsset: instrument.quoteAsset,
      quantityStep: instrument.quantityStep,
      minimumQuantity: instrument.minimumQuantity,
      minimumNotional: instrument.minimumNotional,
      takerFeeBps
    }));
}

function tickerBook(venue: "binance" | "bybit", rawSymbol: unknown, rawBid: unknown, rawBidSize: unknown, rawAsk: unknown, rawAskSize: unknown, exchangeTs: number | undefined, receivedAt: number): TriangularBookUpdate | undefined {
  const symbol = String(rawSymbol ?? "").toUpperCase();
  const bid = positive(rawBid);
  const bidSize = positive(rawBidSize);
  const ask = positive(rawAsk);
  const askSize = positive(rawAskSize);
  if (!/^[A-Z0-9_-]{2,40}$/.test(symbol) || !bid || !bidSize || !ask || !askSize || bid >= ask) return undefined;
  return {
    marketId: `${venue}:spot:${symbol}`,
    bids: [[bid, bidSize]],
    asks: [[ask, askSize]],
    ...(exchangeTs === undefined ? {} : { exchangeTs }),
    exchangeTimestampVerified: exchangeTs !== undefined,
    receivedAt,
    complete: true,
    sequenceVerified: false
  };
}

function withSnapshotRisks(opportunity: TriangularOpportunity): TriangularOpportunity {
  return {
    ...opportunity,
    edgeKind: "non-executable-candidate",
    executionStatus: "non-executable-candidate",
    marketDataMode: "rest-top-book",
    sequenceVerified: false,
    riskFlags: [...new Set([...opportunity.riskFlags, "top-book-only" as const, "rest-snapshot" as const, "unsequenced" as const, "non-executable-candidate" as const])]
  };
}

function normalizeScanOptions(options: TriangularScanOptions): TriangularScanOptions {
  return { ...options, startAsset: options.startAsset.trim().toUpperCase() };
}

function scanKey(options: TriangularScanOptions) {
  return JSON.stringify([options.venue, options.startAsset, options.startQuantity, options.takerFeeBps, options.minimumNetReturnBps, options.limit]);
}

function defaultServiceOptions(options: ServiceOptions) {
  return options.fetch === undefined && options.now === undefined && options.timeoutMs === undefined && options.cacheTtlMs === undefined && options.registry === undefined;
}

async function yieldToEventLoop(signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function positive(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
