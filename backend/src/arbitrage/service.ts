import type { ArbitrageExchange, ArbitrageMarket, ArbitrageOpportunity, ArbitrageScanResponse, ArbitrageSourceStatus, ArbitrageVenueQuote } from "./types.js";
import { instrumentRegistry, type InstrumentRegistry } from "../market/instrumentRegistry.js";
import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { reviewedBasisEconomicAssetId } from "../market/economicAssetIdentity.js";
import { readBoundedText } from "../http/boundedResponse.js";
import { linkedAbortSignal, SharedAbortableWork, throwIfAborted } from "./sharedAbortableWork.js";
import { processPublicUpstreamGovernor, publicUpstreamSource, type UpstreamResourceGovernor } from "./upstream/resourceGovernor/index.js";
import { basisIdentityCoverage } from "./identityCoverage.js";
import { refreshOpportunityQuality, type ArbitrageClockCalibration } from "./opportunityQuality.js";

export { MAX_ARBITRAGE_FUTURE_CLOCK_SKEW_MS, MAX_ARBITRAGE_LEG_SKEW_MS, MAX_ARBITRAGE_QUOTE_AGE_MS, refreshOpportunityQuality } from "./opportunityQuality.js";
export type { ArbitrageClockCalibration } from "./opportunityQuality.js";

const BINANCE_SPOT_BOOK = "https://api.binance.com/api/v3/ticker/bookTicker";
const BINANCE_FUTURES_BOOK = "https://fapi.binance.com/fapi/v1/ticker/bookTicker";
const BINANCE_FUNDING = "https://fapi.binance.com/fapi/v1/premiumIndex";
const BYBIT_SPOT_TICKERS = "https://api.bybit.com/v5/market/tickers?category=spot";
const BYBIT_LINEAR_TICKERS = "https://api.bybit.com/v5/market/tickers?category=linear";
const MAX_SCANNER_MARKET_PAYLOAD_BYTES = 16 * 1024 * 1024;
// A very large basis is more likely a ticker collision, redenomination or stale market than an
// executable arbitrage. Fail closed instead of ranking it as profit.
const MAX_SANE_ABSOLUTE_SPREAD_BPS = 2_000;

interface BinanceBookRow {
  symbol?: string;
  bidPrice?: string;
  bidQty?: string;
  askPrice?: string;
  askQty?: string;
  time?: number;
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
  fundingIntervalHour?: string;
}

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
  time?: number;
  result?: { list?: BybitTickerRow[] };
}

interface RawSnapshot {
  updatedAt: number;
  spot: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>;
  perpetual: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>;
  sources: ArbitrageSourceStatus[];
  identityCoverage: NonNullable<ArbitrageScanResponse["identityCoverage"]>;
}

interface ReceivedPayload<T> {
  payload: T;
  /** Local time immediately after this specific response body was decoded. */
  receivedAt: number;
}

interface ServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
  registry?: Pick<InstrumentRegistry, "snapshot">;
  clockCalibration?: ArbitrageClockCalibration;
  /** False keeps injected/offline fixtures outside the process-wide public REST budget. */
  governor?: UpstreamResourceGovernor | false;
}

export interface ArbitrageScanOptions {
  estimatedTotalCostBps: number;
  minSpreadBps: number;
  limit: number;
  minCapacityUsd?: number;
  sort?: "expected-profit" | "net-edge" | "capacity";
}

/** Aggregates public best bid/ask snapshots without requiring exchange credentials. */
export class ArbitrageScannerService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private readonly registry?: Pick<InstrumentRegistry, "snapshot">;
  private readonly clockCalibration?: ArbitrageClockCalibration;
  private readonly governor?: UpstreamResourceGovernor;
  private cached?: RawSnapshot;
  private readonly snapshotWork = new SharedAbortableWork<string, RawSnapshot>(1);

  constructor(options: ServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.maxStaleMs = options.maxStaleMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    // Custom fetch fixtures stay hermetic unless registry fixtures are injected too.
    this.registry = options.registry ?? (options.fetch ? undefined : instrumentRegistry);
    this.clockCalibration = options.clockCalibration;
    this.governor = options.governor === false ? undefined : (options.governor ?? (options.fetch ? undefined : processPublicUpstreamGovernor));
  }

  async scan(options: ArbitrageScanOptions, signal?: AbortSignal): Promise<ArbitrageScanResponse> {
    throwIfAborted(signal);
    const [{ snapshot, stale, reusedSnapshot }] = await Promise.all([this.getSnapshot(signal), this.clockCalibration?.snapshot(signal).catch(() => undefined) ?? Promise.resolve(undefined)]);
    throwIfAborted(signal);
    const evaluatedAt = this.now();
    const candidates = buildOpportunities(snapshot, options.estimatedTotalCostBps)
      .map((row) => {
        const refreshed = refreshOpportunityQuality(row, evaluatedAt, this.clockCalibration);
        return reusedSnapshot && refreshed.dataQuality === "fresh" ? { ...refreshed, dataQuality: "stale" as const } : refreshed;
      })
      .filter((row) => row.grossSpreadBps >= options.minSpreadBps && row.topBookCapacityUsd >= (options.minCapacityUsd ?? 0));
    const ranked = sortOpportunities(candidates, options.sort ?? "expected-profit");
    const opportunities = ranked.slice(0, options.limit);
    return {
      updatedAt: snapshot.updatedAt,
      stale,
      scannedSymbols: new Set(candidates.map((row) => row.symbol)).size,
      totalOpportunities: ranked.length,
      truncated: ranked.length > opportunities.length,
      estimatedTotalCostBps: options.estimatedTotalCostBps,
      opportunities,
      sources: snapshot.sources,
      identityCoverage: snapshot.identityCoverage
    };
  }

  private async getSnapshot(signal?: AbortSignal): Promise<{ snapshot: RawSnapshot; stale: boolean; reusedSnapshot: boolean }> {
    throwIfAborted(signal);
    if (this.cached && this.now() - this.cached.updatedAt <= this.cacheTtlMs) {
      return { snapshot: this.cached, stale: this.cached.sources.some((status) => !status.ok), reusedSnapshot: false };
    }
    const next = await this.snapshotWork.run("rest-snapshot", (sharedSignal) => this.fetchSnapshot(sharedSignal), signal);
    throwIfAborted(signal);
    const hasVerifiedRoute = verifiedRouteCount(next) > 0;
    if (!hasVerifiedRoute && this.cached && this.now() - this.cached.updatedAt <= this.maxStaleMs) {
      return { snapshot: { ...this.cached, sources: next.sources, identityCoverage: next.identityCoverage }, stale: true, reusedSnapshot: true };
    }
    this.cached = next;
    return { snapshot: next, stale: next.sources.some((status) => !status.ok), reusedSnapshot: false };
  }

  private async fetchSnapshot(signal?: AbortSignal): Promise<RawSnapshot> {
    const [requests, registrySnapshot] = await Promise.all([
      Promise.allSettled([
        this.fetchJson<BinanceBookRow[]>(BINANCE_SPOT_BOOK, "binance", signal),
        this.fetchJson<BinanceBookRow[]>(BINANCE_FUTURES_BOOK, "binance", signal),
        this.fetchJson<BinanceFundingRow[]>(BINANCE_FUNDING, "binance", signal),
        this.fetchJson<BybitEnvelope>(BYBIT_SPOT_TICKERS, "bybit", signal, assertBybitEnvelope),
        this.fetchJson<BybitEnvelope>(BYBIT_LINEAR_TICKERS, "bybit", signal, assertBybitEnvelope)
      ]),
      this.registry?.snapshot().catch(() => undefined) ?? Promise.resolve(undefined)
    ]);
    throwIfAborted(signal);
    const binanceSpot = result(requests[0]);
    const binanceFutures = result(requests[1]);
    const binanceFunding = result(requests[2]);
    const bybitSpot = result(requests[3]);
    const bybitLinear = result(requests[4]);
    const sources: ArbitrageSourceStatus[] = [source("binance", "spot", requests[0]), combinedSource("binance", "perpetual", requests[1], requests[2]), source("bybit", "spot", requests[3]), source("bybit", "perpetual", requests[4])];
    const updatedAt = this.now();
    const spot = {
      binance: normalizeBinance(binanceSpot?.payload ?? [], "spot", binanceSpot?.receivedAt ?? updatedAt),
      bybit: normalizeBybit(bybitSpot?.payload, "spot", bybitSpot?.receivedAt ?? updatedAt)
    };
    const perpetual = {
      // Price freshness belongs to the book-ticker payload. Funding is separate
      // provenance and must never rejuvenate an older executable quote.
      binance: normalizeBinancePerpetual(binanceFutures?.payload ?? [], binanceFunding?.payload ?? [], binanceFutures?.receivedAt ?? updatedAt),
      bybit: normalizeBybit(bybitLinear?.payload, "perpetual", bybitLinear?.receivedAt ?? updatedAt)
    };
    if (registrySnapshot) enrichQuotes(spot, perpetual, registrySnapshot.verifiedInstruments);
    return {
      updatedAt,
      spot: {
        binance: spot.binance,
        bybit: spot.bybit
      },
      perpetual: {
        binance: perpetual.binance,
        bybit: perpetual.bybit
      },
      sources,
      identityCoverage: basisIdentityCoverage(registrySnapshot)
    };
  }

  private fetchJson<T>(url: string, exchange: ArbitrageExchange, signal?: AbortSignal, validate?: (value: ReceivedPayload<T>) => ReceivedPayload<T>): Promise<ReceivedPayload<T>> {
    const load = async () => {
      const linked = linkedAbortSignal(signal, this.timeoutMs, "Arbitrage market-data request timed out");
      try {
        const response = await this.fetcher(url, { signal: linked.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await readBoundedText(response, MAX_SCANNER_MARKET_PAYLOAD_BYTES, () => new Error("Arbitrage market-data response is too large"));
        throwIfAborted(linked.signal);
        const value = { payload: JSON.parse(body) as T, receivedAt: this.now() };
        return validate?.(value) ?? value;
      } finally {
        linked.cleanup();
      }
    };
    const source = publicUpstreamSource(exchange);
    if (!this.governor || !source) return load();
    return this.governor.run(source, load, { classifyError: () => (signal?.aborted ? "aborted" : "failure") });
  }
}

export function buildOpportunities(snapshot: RawSnapshot, estimatedTotalCostBps: number): ArbitrageOpportunity[] {
  const capturedAt = snapshot.updatedAt;
  const routes: Array<[ArbitrageExchange, ArbitrageExchange]> = [
    ["binance", "binance"],
    ["binance", "bybit"],
    ["bybit", "binance"],
    ["bybit", "bybit"]
  ];
  const opportunities: ArbitrageOpportunity[] = [];
  for (const [spotExchange, futuresExchange] of routes) {
    for (const [symbol, spot] of snapshot.spot[spotExchange]) {
      const futures = snapshot.perpetual[futuresExchange].get(symbol);
      if (!futures) continue;
      const identity = resolveRouteIdentity(spot, futures);
      if (!identity) continue;
      const grossSpreadBps = ((futures.bid - spot.ask) / spot.ask) * 10_000;
      if (Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) continue;
      const topBookMatchedQuantity = Math.min(spot.askSize, futures.bidSize);
      const topBookCapacityUsd = topBookMatchedQuantity * spot.ask;
      const netEdgeBps = grossSpreadBps - estimatedTotalCostBps;
      const opportunity = refreshOpportunityQuality(
        {
          id: `${symbol}:${spotExchange}:${futuresExchange}`,
          strategyKind: "cash-and-carry",
          edgeKind: "projected",
          identityScope: identity.scope,
          symbol,
          assetId: identity.assetId,
          spotInstrumentId: identity.spotInstrumentId,
          futuresInstrumentId: identity.futuresInstrumentId,
          spotExchange,
          futuresExchange,
          spotBid: spot.bid,
          spotAsk: spot.ask,
          spotAskSize: spot.askSize,
          futuresBid: futures.bid,
          futuresAsk: futures.ask,
          futuresBidSize: futures.bidSize,
          grossSpreadBps,
          estimatedTotalCostBps,
          netEdgeBps,
          topBookCapacityUsd,
          topBookMatchedQuantity,
          expectedNetProfitUsd: (topBookCapacityUsd * netEdgeBps) / 10_000,
          fundingRate: futures.fundingRate ?? 0,
          nextFundingTime: futures.nextFundingTime,
          fundingIntervalMinutes: futures.fundingIntervalMinutes,
          fundingScheduleVerified: futures.fundingScheduleVerified === true,
          ...(spot.exchangeTs === undefined ? {} : { spotExchangeTs: spot.exchangeTs }),
          spotExchangeTimestampVerified: spot.exchangeTimestampVerified,
          spotReceivedAt: spot.receivedAt,
          ...(futures.exchangeTs === undefined ? {} : { futuresExchangeTs: futures.exchangeTs }),
          futuresExchangeTimestampVerified: futures.exchangeTimestampVerified,
          futuresReceivedAt: futures.receivedAt,
          quoteAgeMs: 0,
          legSkewMs: 0,
          dataQuality: "unverified",
          capturedAt
        },
        capturedAt
      );
      // Discovery may retain an explicitly unverified candidate so that a
      // timestamped stream event can promote it without inventing venue time.
      // Alerts, history and paper/live gates still require fresh evidence.
      opportunities.push(opportunity);
    }
  }
  return opportunities;
}

export function sortOpportunities(rows: ArbitrageOpportunity[], sort: NonNullable<ArbitrageScanOptions["sort"]>) {
  return [...rows].sort((left, right) => {
    const quality = opportunityQualityRank(right.dataQuality) - opportunityQualityRank(left.dataQuality);
    if (quality) return quality;
    if (sort === "capacity") return right.topBookCapacityUsd - left.topBookCapacityUsd || right.netEdgeBps - left.netEdgeBps;
    if (sort === "net-edge") return right.netEdgeBps - left.netEdgeBps || right.topBookCapacityUsd - left.topBookCapacityUsd;
    return right.expectedNetProfitUsd - left.expectedNetProfitUsd || right.topBookCapacityUsd - left.topBookCapacityUsd;
  });
}

function opportunityQualityRank(quality: ArbitrageOpportunity["dataQuality"]) {
  return quality === "fresh" ? 3 : quality === "unverified" ? 2 : quality === "skewed" ? 1 : 0;
}

function normalizeBinance(rows: BinanceBookRow[], market: ArbitrageMarket, receivedAt: number): Map<string, ArbitrageVenueQuote> {
  return normalizeRows(rows, "binance", market, receivedAt, (row) => ({
    symbol: row.symbol,
    bid: row.bidPrice,
    bidSize: row.bidQty,
    ask: row.askPrice,
    askSize: row.askQty,
    exchangeTs: row.time
  }));
}

function normalizeBinancePerpetual(rows: BinanceBookRow[], fundingRows: BinanceFundingRow[], receivedAt: number): Map<string, ArbitrageVenueQuote> {
  const funding = new Map(fundingRows.filter((row) => row.symbol && finite(row.nextFundingTime) > 0 && row.lastFundingRate !== "").map((row) => [row.symbol as string, row]));
  return normalizeRows(
    rows.filter((row) => row.symbol && funding.has(row.symbol)),
    "binance",
    "perpetual",
    receivedAt,
    (row) => {
      const rate = funding.get(row.symbol ?? "");
      return {
        symbol: row.symbol,
        bid: row.bidPrice,
        bidSize: row.bidQty,
        ask: row.askPrice,
        askSize: row.askQty,
        fundingRate: rate?.lastFundingRate,
        nextFundingTime: rate?.nextFundingTime,
        exchangeTs: row.time
      };
    }
  );
}

function normalizeBybit(envelope: BybitEnvelope | undefined, market: ArbitrageMarket, receivedAt: number): Map<string, ArbitrageVenueQuote> {
  if (!envelope) return new Map();
  const rows = envelope.result?.list ?? [];
  const perpetualRows = market === "perpetual" ? rows.filter((row) => finite(row.nextFundingTime) > 0 && row.fundingRate !== "") : rows;
  return normalizeRows(perpetualRows, "bybit", market, receivedAt, (row) => ({
    symbol: row.symbol,
    bid: row.bid1Price,
    bidSize: row.bid1Size,
    ask: row.ask1Price,
    askSize: row.ask1Size,
    fundingRate: row.fundingRate,
    nextFundingTime: row.nextFundingTime,
    fundingIntervalMinutes: row.fundingIntervalHour === undefined ? undefined : finite(row.fundingIntervalHour) * 60,
    exchangeTs: envelope.time
  }));
}

function normalizeRows<T>(rows: T[], exchange: ArbitrageExchange, market: ArbitrageMarket, receivedAt: number, read: (row: T) => Record<string, unknown>): Map<string, ArbitrageVenueQuote> {
  const output = new Map<string, ArbitrageVenueQuote>();
  for (const row of rows) {
    const value = read(row);
    const symbol = String(value.symbol ?? "").toUpperCase();
    const bid = finite(value.bid);
    const ask = finite(value.ask);
    const bidSize = finite(value.bidSize);
    const askSize = finite(value.askSize);
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol) || bid <= 0 || ask <= 0 || bid >= ask || bidSize <= 0 || askSize <= 0) continue;
    const venueTimestamp = finite(value.exchangeTs) > 0 ? finite(value.exchangeTs) : undefined;
    output.set(symbol, {
      symbol,
      exchange,
      market,
      bid,
      bidSize,
      ask,
      askSize,
      fundingRate: value.fundingRate === undefined ? undefined : finite(value.fundingRate),
      nextFundingTime: value.nextFundingTime === undefined ? undefined : finite(value.nextFundingTime),
      fundingIntervalMinutes: value.fundingIntervalMinutes === undefined ? undefined : finite(value.fundingIntervalMinutes),
      fundingScheduleVerified: finite(value.fundingIntervalMinutes) > 0,
      ...(venueTimestamp === undefined ? {} : { exchangeTs: venueTimestamp }),
      exchangeTimestampVerified: venueTimestamp !== undefined,
      receivedAt
    });
  }
  return output;
}

function enrichQuotes(spot: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>, perpetual: Record<ArbitrageExchange, Map<string, ArbitrageVenueQuote>>, instruments: RegistryInstrument[]) {
  const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
  for (const exchange of ["binance", "bybit"] as const) {
    for (const [market, quotes] of [
      ["spot", spot[exchange]],
      ["perpetual", perpetual[exchange]]
    ] as const) {
      for (const quote of quotes.values()) {
        const expectedId = `${exchange}:${market}:${quote.symbol}`;
        const instrument = byId.get(expectedId);
        if (!isEligibleRegistryInstrument(instrument, expectedId, exchange, market, quote.symbol)) continue;
        quote.instrumentId = instrument.id;
        quote.registryIdentity = {
          nativeAssetId: instrument.assetId,
          baseAsset: instrument.baseAsset,
          quoteAsset: instrument.quoteAsset,
          settleAsset: instrument.settleAsset
        };
        const reviewedEconomicAssetId = reviewedBasisEconomicAssetId({
          venue: instrument.venue,
          marketType: instrument.marketType,
          symbol: instrument.venueSymbol,
          baseAsset: instrument.baseAsset,
          quoteAsset: instrument.quoteAsset,
          settleAsset: instrument.settleAsset
        });
        if (reviewedEconomicAssetId && instrument.economicAssetId === reviewedEconomicAssetId) {
          quote.economicAssetId = reviewedEconomicAssetId;
        }
        if (market === "perpetual" && instrument.fundingIntervalMinutes) {
          quote.fundingIntervalMinutes = instrument.fundingIntervalMinutes;
          quote.fundingScheduleVerified = true;
        }
      }
    }
  }
}

function result<T>(settled: PromiseSettledResult<T>): T | undefined {
  return settled.status === "fulfilled" ? settled.value : undefined;
}

function source(exchange: ArbitrageExchange, market: ArbitrageMarket, settled: PromiseSettledResult<unknown>): ArbitrageSourceStatus {
  return settled.status === "fulfilled" ? { exchange, market, ok: true } : { exchange, market, ok: false, message: errorMessage(settled.reason) };
}

function combinedSource(exchange: ArbitrageExchange, market: ArbitrageMarket, ...settled: PromiseSettledResult<unknown>[]): ArbitrageSourceStatus {
  const failed = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
  return failed ? { exchange, market, ok: false, message: errorMessage(failed.reason) } : { exchange, market, ok: true };
}

function verifiedRouteCount(snapshot: RawSnapshot): number {
  let count = 0;
  for (const spotExchange of ["binance", "bybit"] as const) {
    for (const futuresExchange of ["binance", "bybit"] as const) {
      for (const [symbol, spot] of snapshot.spot[spotExchange]) {
        const futures = snapshot.perpetual[futuresExchange].get(symbol);
        if (futures && resolveRouteIdentity(spot, futures)) count += 1;
      }
    }
  }
  return count;
}

function hasVerifiedNativeIdentity(quote: ArbitrageVenueQuote): quote is ArbitrageVenueQuote & {
  instrumentId: string;
  registryIdentity: NonNullable<ArbitrageVenueQuote["registryIdentity"]>;
} {
  const expectedId = `${quote.exchange}:${quote.market}:${quote.symbol}`;
  const identity = quote.registryIdentity;
  return Boolean(quote.instrumentId === expectedId && identity && validNativeAssetId(identity.nativeAssetId) && validNativeAssetId(identity.baseAsset) && validNativeAssetId(identity.quoteAsset) && validNativeAssetId(identity.settleAsset));
}

function resolveRouteIdentity(spot: ArbitrageVenueQuote, futures: ArbitrageVenueQuote): { assetId: string; scope: ArbitrageOpportunity["identityScope"]; spotInstrumentId: string; futuresInstrumentId: string } | undefined {
  if (!hasVerifiedNativeIdentity(spot) || !hasVerifiedNativeIdentity(futures)) return undefined;
  if (spot.exchange === futures.exchange) {
    const left = spot.registryIdentity;
    const right = futures.registryIdentity;
    if (left.nativeAssetId !== right.nativeAssetId || left.baseAsset !== right.baseAsset || left.quoteAsset !== right.quoteAsset || left.settleAsset !== right.settleAsset) return undefined;
    return {
      assetId: `${spot.exchange}:${left.nativeAssetId.toLowerCase()}`,
      scope: "venue-native",
      spotInstrumentId: spot.instrumentId,
      futuresInstrumentId: futures.instrumentId
    };
  }
  if (!validEconomicAssetId(spot.economicAssetId) || spot.economicAssetId !== futures.economicAssetId) return undefined;
  return {
    assetId: spot.economicAssetId,
    scope: "cross-venue-reviewed",
    spotInstrumentId: spot.instrumentId,
    futuresInstrumentId: futures.instrumentId
  };
}

function isEligibleRegistryInstrument(instrument: RegistryInstrument | undefined, expectedId: string, exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string): instrument is RegistryInstrument {
  return Boolean(
    instrument &&
      instrument.id === expectedId &&
      instrument.venue === exchange &&
      instrument.marketType === market &&
      instrument.venueSymbol === symbol &&
      instrument.venueSymbol === `${instrument.baseAsset}${instrument.quoteAsset}` &&
      instrument.assetId === instrument.baseAsset &&
      instrument.quoteAsset === "USDT" &&
      instrument.settleAsset === "USDT" &&
      instrument.status === "trading" &&
      validNativeAssetId(instrument.assetId) &&
      validNativeAssetId(instrument.baseAsset) &&
      validNativeAssetId(instrument.quoteAsset) &&
      validNativeAssetId(instrument.settleAsset) &&
      instrument.quantityUnit === "base" &&
      instrument.contractMultiplier === 1 &&
      (market === "spot" ? instrument.contractDirection === undefined : instrument.contractDirection === "linear")
  );
}

function validNativeAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value);
}

function validEconomicAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Market data unavailable");
}

function assertBybitEnvelope(envelope: ReceivedPayload<BybitEnvelope>): ReceivedPayload<BybitEnvelope> {
  if (envelope.payload.retCode !== 0) throw new Error(`Bybit market data: ${envelope.payload.retMsg ?? envelope.payload.retCode}`);
  return envelope;
}
