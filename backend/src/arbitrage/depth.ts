import type { ArbitrageDepthLeg, ArbitrageDepthResponse, ArbitrageExchange, ArbitrageMarket } from "./types.js";
import { instrumentRegistry, type InstrumentRegistry } from "../market/instrumentRegistry.js";
import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { reviewedBasisEconomicAssetId } from "../market/economicAssetIdentity.js";
import { readBoundedText } from "../http/boundedResponse.js";
import { ArbitrageOverloadError, linkedAbortSignal, SharedAbortableWork, throwIfAborted } from "./sharedAbortableWork.js";
import { depthRouteIdentity } from "./depthIdentity.js";
import { sequenceVerifiedL2Hub } from "./upstream/l2/hub.js";
import type { SequenceVerifiedBookProvider } from "./upstream/l2/types.js";
import { processPublicUpstreamGovernor, publicUpstreamSource, UpstreamCircuitOpenError, type UpstreamResourceGovernor, UpstreamSourceOverloadError } from "./upstream/resourceGovernor/index.js";
import { buildDepthTiming, refreshDepthTiming as refreshDepthTimingValue } from "./depthTiming.js";
import { type ArbitrageOrderBook, type DepthLevel, validateOrderBook } from "./depthBook.js";
export { MAX_ARBITRAGE_DEPTH_AGE_MS, MAX_ARBITRAGE_DEPTH_FUTURE_CLOCK_SKEW_MS, MAX_ARBITRAGE_DEPTH_LEG_SKEW_MS, refreshDepthTiming } from "./depthTiming.js";
export type { ArbitrageOrderBook, DepthLevel } from "./depthBook.js";
const MAX_SANE_ABSOLUTE_SPREAD_BPS = 2_000;
const FALLBACK_QUANTITY_STEP = 1e-8;
const MAX_DEPTH_PAYLOAD_BYTES = 512 * 1024;
const MAX_STEP_DECIMALS = 12;
interface BinanceDepth {
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
  E?: number;
  T?: number;
  lastUpdateId?: number;
}
interface BybitDepth {
  retCode?: number;
  retMsg?: string;
  result?: { b?: Array<[string, string]>; a?: Array<[string, string]>; ts?: number; u?: number; seq?: number };
}

interface DepthOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxConcurrentBookFetches?: number;
  registry?: Pick<InstrumentRegistry, "get">;
  /** False keeps injected/offline fixtures on the explicit REST research path. */
  sequenceBooks?: SequenceVerifiedBookProvider | false;
  /** False keeps offline fixtures outside the process-wide public REST budget. */
  governor?: UpstreamResourceGovernor | false;
}
export interface DepthRequest {
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  notionalUsd: number;
  direction?: "entry" | "exit";
  /** Exact open base quantity required when simulating an exit. */
  quantity?: number;
  /** Optional until the instrument registry supplies venue LOT_SIZE/qtyStep metadata. */
  spotQuantityStep?: number;
  /** Optional until the instrument registry supplies venue LOT_SIZE/qtyStep metadata. */
  perpetualQuantityStep?: number;
  /** Full registry records are required before a result can be marked executable. */
  spotInstrument?: RegistryInstrument;
  perpetualInstrument?: RegistryInstrument;
}

/** Reads bounded public order-book snapshots and estimates VWAP for both arbitrage legs. */
export class ArbitrageDepthService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly registry?: Pick<InstrumentRegistry, "get">;
  private readonly sequenceBooks?: SequenceVerifiedBookProvider;
  private readonly governor?: UpstreamResourceGovernor;
  private readonly cache = new Map<string, { expiresAt: number; value: ArbitrageDepthResponse }>();
  private readonly bookCache = new Map<string, { expiresAt: number; value: ArbitrageOrderBook }>();
  private readonly bookWork: SharedAbortableWork<string, ArbitrageOrderBook>;

  constructor(options: DepthOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 1_500;
    this.bookWork = new SharedAbortableWork(options.maxConcurrentBookFetches ?? 8);
    // Injected fetch fixtures remain hermetic unless they also inject registry metadata.
    this.registry = options.registry ?? (options.fetch ? undefined : instrumentRegistry);
    this.sequenceBooks = options.sequenceBooks === false ? undefined : (options.sequenceBooks ?? (options.fetch ? undefined : sequenceVerifiedL2Hub));
    this.governor = options.governor === false ? undefined : (options.governor ?? (options.fetch ? undefined : processPublicUpstreamGovernor));
  }

  async analyze(input: DepthRequest, signal?: AbortSignal): Promise<ArbitrageDepthResponse> {
    throwIfAborted(signal);
    const [spotInstrument, perpetualInstrument] = this.registry ? await Promise.all([this.registry.get(input.spotExchange, "spot", input.symbol), this.registry.get(input.futuresExchange, "perpetual", input.symbol)]) : [undefined, undefined];
    throwIfAborted(signal);
    const enriched = {
      ...input,
      spotQuantityStep: input.spotQuantityStep ?? spotInstrument?.quantityStep,
      perpetualQuantityStep: input.perpetualQuantityStep ?? perpetualInstrument?.quantityStep,
      spotInstrument,
      perpetualInstrument
    };
    const metadataFailures = depthMetadataFailures(enriched);
    if (metadataFailures.length > 0) throw new Error(`Instrument metadata verification failed: ${metadataFailures.join(", ")}`);
    const key = `${input.symbol}:${input.spotExchange}:${input.futuresExchange}:${input.direction ?? "entry"}:${input.notionalUsd}:${input.quantity ?? "budget"}:${instrumentConstraintKey(spotInstrument)}:${instrumentConstraintKey(perpetualInstrument)}`;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt >= now) {
      throwIfAborted(signal);
      return refreshDepthTimingValue(cached.value, now);
    }
    throwIfAborted(signal);
    const analysisController = new AbortController();
    const abortAnalysis = () => analysisController.abort(signal?.reason);
    if (signal?.aborted) abortAnalysis();
    else signal?.addEventListener("abort", abortAnalysis, { once: true });
    try {
      const [spotBook, perpetualBook] = await Promise.all([this.book(input.spotExchange, "spot", input.symbol, analysisController.signal), this.book(input.futuresExchange, "perpetual", input.symbol, analysisController.signal)]);
      throwIfAborted(signal);
      const capturedAt = this.now();
      this.assertCurrentSequenceBooks(spotBook, perpetualBook);
      const value = matchOrderBookDepth(enriched, spotBook, perpetualBook, capturedAt);
      this.assertCurrentSequenceBooks(spotBook, perpetualBook);
      if (!value.timing.sequenceContinuityVerified) {
        this.cache.set(key, { expiresAt: capturedAt + this.cacheTtlMs, value });
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value ?? "");
      }
      return value;
    } catch (error) {
      analysisController.abort(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortAnalysis);
    }
  }

  private async book(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, signal?: AbortSignal): Promise<ArbitrageOrderBook> {
    const key = `${exchange}:${market}:${symbol}`;
    const cached = this.bookCache.get(key);
    if (cached && cached.expiresAt >= this.now()) return cached.value;
    let value: ArbitrageOrderBook;
    try {
      value = await this.bookWork.run(key, (sharedSignal) => this.loadBook(exchange, market, symbol, sharedSignal), signal);
    } catch (error) {
      if (this.governor && error instanceof ArbitrageOverloadError && !(error instanceof UpstreamSourceOverloadError) && !(error instanceof UpstreamCircuitOpenError)) {
        const source = publicUpstreamSource(exchange);
        if (source) this.governor.recordExternalOverload(source);
      }
      throw error;
    }
    if (!value.sequenceVerified) {
      this.bookCache.set(key, { expiresAt: value.receivedAt + this.cacheTtlMs, value });
      if (this.bookCache.size > 400) this.bookCache.delete(this.bookCache.keys().next().value ?? "");
    }
    return value;
  }

  private async loadBook(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, signal?: AbortSignal): Promise<ArbitrageOrderBook> {
    if (this.sequenceBooks) {
      try {
        const book = await this.sequenceBooks.getBook(exchange, market, symbol, signal);
        return {
          bids: book.bids,
          asks: book.asks,
          source: "websocket-reconstructed",
          sequenceVerified: true,
          exchangeTs: book.exchangeTs,
          receivedAt: book.receivedAt,
          sequence: book.sequence,
          sequenceProof: book
        };
      } catch {
        // Public discovery remains available as a visibly unverified REST
        // fallback. It can never satisfy the execution/paper completeness gate.
        throwIfAborted(signal);
      }
    }
    return await this.fetchBook(exchange, market, symbol, signal);
  }

  private assertCurrentSequenceBooks(...books: ArbitrageOrderBook[]) {
    for (const book of books) {
      if (!book.sequenceVerified) continue;
      if (!this.sequenceBooks || !book.sequenceProof || !this.sequenceBooks.isCurrent(book.sequenceProof)) {
        throw new Error("Sequence-verified L2 was invalidated while depth analysis was in progress");
      }
    }
  }

  private async fetchBook(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, signal?: AbortSignal): Promise<ArbitrageOrderBook> {
    const load = async () => {
      const url =
        exchange === "binance"
          ? `${market === "spot" ? "https://api.binance.com/api/v3/depth" : "https://fapi.binance.com/fapi/v1/depth"}?symbol=${encodeURIComponent(symbol)}&limit=100`
          : `https://api.bybit.com/v5/market/orderbook?category=${market === "spot" ? "spot" : "linear"}&symbol=${encodeURIComponent(symbol)}&limit=100`;
      const { payload, receivedAt } = await this.fetchJson<BinanceDepth | BybitDepth>(url, signal);
      if (exchange === "bybit") {
        const envelope = payload as BybitDepth;
        if (envelope.retCode !== 0) throw new Error(`Bybit order book: ${envelope.retMsg ?? envelope.retCode}`);
        const value = {
          bids: levels(envelope.result?.b),
          asks: levels(envelope.result?.a),
          source: "rest-snapshot" as const,
          sequenceVerified: false,
          ...exchangeTimestamp(envelope.result?.ts),
          ...bookSequence(envelope.result?.seq ?? envelope.result?.u),
          receivedAt
        };
        validateOrderBook(value, `${exchange} ${market}`);
        return value;
      }
      const book = payload as BinanceDepth;
      const value = {
        bids: levels(book.bids),
        asks: levels(book.asks),
        source: "rest-snapshot" as const,
        sequenceVerified: false,
        ...exchangeTimestamp(book.T ?? book.E),
        ...bookSequence(book.lastUpdateId),
        receivedAt
      };
      validateOrderBook(value, `${exchange} ${market}`);
      return value;
    };
    const source = publicUpstreamSource(exchange);
    if (!this.governor || !source) return load();
    return this.governor.run(source, load, { classifyError: () => (signal?.aborted ? "aborted" : "failure") });
  }

  private async fetchJson<T>(url: string, signal?: AbortSignal): Promise<{ payload: T; receivedAt: number }> {
    const linked = linkedAbortSignal(signal, this.timeoutMs, "Order-book request timed out");
    try {
      const response = await this.fetcher(url, { signal: linked.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Order book HTTP ${response.status}`);
      const body = await readBoundedText(response, MAX_DEPTH_PAYLOAD_BYTES, () => new Error("Order-book response is too large"));
      throwIfAborted(linked.signal);
      const payload = JSON.parse(body) as T;
      return { payload, receivedAt: this.now() };
    } finally {
      linked.cleanup();
    }
  }
}

/**
 * Produces one base-asset quantity for both legs. The spot USD budget defines
 * the target; visible perpetual liquidity and the common venue lot step can
 * only reduce it. This keeps paper/execution consumers delta-neutral.
 */
export function matchOrderBookDepth(input: DepthRequest, spotBook: ArbitrageOrderBook, perpetualBook: ArbitrageOrderBook, capturedAt: number): ArbitrageDepthResponse {
  if (input.direction === "exit") return matchExitOrderBookDepth(input, spotBook, perpetualBook, capturedAt);
  validateOrderBook(spotBook, "spot");
  validateOrderBook(perpetualBook, "perpetual");
  const timing = buildDepthTiming(spotBook, perpetualBook, capturedAt);
  const spotBudget = walkDepth(input.spotExchange, "spot", "buy", spotBook.asks, input.notionalUsd, spotBook.receivedAt);
  const targetQuantity = spotBudget.quantity;
  const perpetualAvailableQuantity = totalQuantity(perpetualBook.bids);
  const precisionVerified = verifiedInstrumentSteps(input);
  const quantityStep = commonQuantityStep(input.spotQuantityStep ?? FALLBACK_QUANTITY_STEP, input.perpetualQuantityStep ?? FALLBACK_QUANTITY_STEP);
  const rawMatchedQuantity = Math.min(targetQuantity, perpetualAvailableQuantity);
  const matchedQuantity = floorToStep(rawMatchedQuantity, quantityStep);
  const requestedRoundedQuantity = floorToStep(targetQuantity, quantityStep);
  const spot = walkDepthByQuantity(input.spotExchange, "spot", "buy", spotBook.asks, matchedQuantity, input.notionalUsd, spotBook.receivedAt);
  const perpetual = walkDepthByQuantity(input.futuresExchange, "perpetual", "sell", perpetualBook.bids, matchedQuantity, input.notionalUsd, perpetualBook.receivedAt);
  const rawResidualDeltaQuantity = spot.quantity - perpetual.quantity;
  const deltaTolerance = quantityTolerance(quantityStep, matchedQuantity);
  const residualDeltaQuantity = Math.abs(rawResidualDeltaQuantity) <= deltaTolerance ? 0 : rawResidualDeltaQuantity;
  const roundingDustQuantity = Math.max(0, rawMatchedQuantity - matchedQuantity);
  const liquidityShortfallQuantity = Math.max(0, requestedRoundedQuantity - matchedQuantity);
  const liquidityComplete = spotBudget.complete && matchedQuantity > 0 && matchedQuantity + deltaTolerance >= requestedRoundedQuantity && spot.complete && perpetual.complete && Math.abs(residualDeltaQuantity) <= deltaTolerance;
  const constraints = depthConstraints(input, spot, perpetual, matchedQuantity);
  const complete = liquidityComplete && constraints.verified && timing.exchangeTimestampsVerified && timing.sequenceContinuityVerified && timing.quality === "fresh";
  const grossSpreadBps = spot.averagePrice > 0 && perpetual.averagePrice > 0 ? ((perpetual.averagePrice - spot.averagePrice) / spot.averagePrice) * 10_000 : 0;
  if (Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) throw new Error("Order-book basis exceeds the safety boundary");
  return {
    ...depthRouteIdentity(input),
    symbol: input.symbol,
    direction: "entry",
    requestedNotionalUsd: input.notionalUsd,
    targetQuantity,
    matchedQuantity,
    quantityStep,
    quantityStepSource: precisionVerified ? "instrument" : "fallback",
    precisionVerified,
    roundingDustQuantity,
    liquidityShortfallQuantity,
    residualDeltaQuantity,
    spot,
    perpetual,
    timing,
    constraints,
    grossSpreadBps,
    complete,
    capturedAt
  };
}

/** Simulates closing the exact open base quantity: sell spot bids and buy perpetual asks. */
export function matchExitOrderBookDepth(input: DepthRequest, spotBook: ArbitrageOrderBook, perpetualBook: ArbitrageOrderBook, capturedAt: number): ArbitrageDepthResponse {
  validateOrderBook(spotBook, "spot");
  validateOrderBook(perpetualBook, "perpetual");
  const timing = buildDepthTiming(spotBook, perpetualBook, capturedAt);
  const targetQuantity = input.quantity ?? 0;
  if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) throw new Error("Exit quantity must be positive");
  const precisionVerified = verifiedInstrumentSteps(input);
  const quantityStep = commonQuantityStep(input.spotQuantityStep ?? FALLBACK_QUANTITY_STEP, input.perpetualQuantityStep ?? FALLBACK_QUANTITY_STEP);
  const requestedRoundedQuantity = floorToStep(targetQuantity, quantityStep);
  const rawMatchedQuantity = Math.min(requestedRoundedQuantity, totalQuantity(spotBook.bids), totalQuantity(perpetualBook.asks));
  const matchedQuantity = floorToStep(rawMatchedQuantity, quantityStep);
  const spot = walkDepthByQuantity(input.spotExchange, "spot", "sell", spotBook.bids, matchedQuantity, input.notionalUsd, spotBook.receivedAt);
  const perpetual = walkDepthByQuantity(input.futuresExchange, "perpetual", "buy", perpetualBook.asks, matchedQuantity, input.notionalUsd, perpetualBook.receivedAt);
  const rawResidualDeltaQuantity = spot.quantity - perpetual.quantity;
  const deltaTolerance = quantityTolerance(quantityStep, targetQuantity);
  const residualDeltaQuantity = Math.abs(rawResidualDeltaQuantity) <= deltaTolerance ? 0 : rawResidualDeltaQuantity;
  const roundingDustQuantity = Math.max(0, targetQuantity - requestedRoundedQuantity) + Math.max(0, rawMatchedQuantity - matchedQuantity);
  const liquidityShortfallQuantity = Math.max(0, requestedRoundedQuantity - matchedQuantity);
  const liquidityComplete = matchedQuantity > 0 && matchedQuantity + deltaTolerance >= targetQuantity && spot.complete && perpetual.complete && Math.abs(residualDeltaQuantity) <= deltaTolerance;
  const constraints = depthConstraints(input, spot, perpetual, matchedQuantity);
  const complete = liquidityComplete && constraints.verified && timing.exchangeTimestampsVerified && timing.sequenceContinuityVerified && timing.quality === "fresh";
  const grossSpreadBps = spot.averagePrice > 0 && perpetual.averagePrice > 0 ? ((perpetual.averagePrice - spot.averagePrice) / spot.averagePrice) * 10_000 : 0;
  if (Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) throw new Error("Order-book basis exceeds the safety boundary");
  return {
    ...depthRouteIdentity(input),
    symbol: input.symbol,
    direction: "exit",
    requestedNotionalUsd: input.notionalUsd,
    targetQuantity,
    matchedQuantity,
    quantityStep,
    quantityStepSource: precisionVerified ? "instrument" : "fallback",
    precisionVerified,
    roundingDustQuantity,
    liquidityShortfallQuantity,
    residualDeltaQuantity,
    spot,
    perpetual,
    timing,
    constraints,
    grossSpreadBps,
    complete,
    capturedAt
  };
}

function verifiedInstrumentSteps(input: DepthRequest) {
  return Boolean(input.spotInstrument && input.perpetualInstrument && validStep(input.spotInstrument.quantityStep) && validStep(input.perpetualInstrument.quantityStep) && input.spotQuantityStep === input.spotInstrument.quantityStep && input.perpetualQuantityStep === input.perpetualInstrument.quantityStep);
}

function depthConstraints(input: DepthRequest, spot: ArbitrageDepthLeg, perpetual: ArbitrageDepthLeg, matchedQuantity: number): ArbitrageDepthResponse["constraints"] {
  const failures = depthMetadataFailures(input);
  const spotInstrument = input.spotInstrument;
  const perpetualInstrument = input.perpetualInstrument;
  const metadataVerified = failures.length === 0;
  if (metadataVerified && spotInstrument && perpetualInstrument) {
    if (matchedQuantity + quantityTolerance(spotInstrument.quantityStep, matchedQuantity) < spotInstrument.minimumQuantity) failures.push("spot-below-minimum-quantity");
    if (matchedQuantity + quantityTolerance(perpetualInstrument.quantityStep, matchedQuantity) < perpetualInstrument.minimumQuantity) failures.push("perpetual-below-minimum-quantity");
    if (spot.filledNotionalUsd + notionalTolerance(spot.filledNotionalUsd) < spotInstrument.minimumNotional) failures.push("spot-below-minimum-notional");
    if (perpetual.filledNotionalUsd + notionalTolerance(perpetual.filledNotionalUsd) < perpetualInstrument.minimumNotional) failures.push("perpetual-below-minimum-notional");
  }
  const minimumsSatisfied = metadataVerified && failures.length === 0;
  return { metadataVerified, minimumsSatisfied, verified: metadataVerified && minimumsSatisfied, failures: [...new Set(failures)] };
}

function depthMetadataFailures(input: DepthRequest): string[] {
  const failures: string[] = [];
  const spot = input.spotInstrument;
  const perpetual = input.perpetualInstrument;
  validateInstrumentMetadata(spot, input.spotExchange, "spot", input.symbol, "spot", failures);
  validateInstrumentMetadata(perpetual, input.futuresExchange, "perpetual", input.symbol, "perpetual", failures);
  if (!spot || !perpetual) return [...new Set(failures)];
  if (spot.baseAsset !== perpetual.baseAsset) failures.push("base-asset-mismatch");
  if (spot.quoteAsset !== perpetual.quoteAsset || spot.quoteAsset !== "USDT") failures.push("quote-asset-mismatch");
  if (spot.settleAsset !== spot.quoteAsset || perpetual.settleAsset !== spot.quoteAsset) failures.push("settlement-asset-mismatch");
  if (input.spotExchange === input.futuresExchange) {
    if (spot.assetId !== perpetual.assetId) failures.push("venue-native-asset-mismatch");
  } else {
    const spotEconomicAssetId = reviewedEconomicAssetId(spot);
    const perpetualEconomicAssetId = reviewedEconomicAssetId(perpetual);
    if (!spotEconomicAssetId) failures.push("spot-economic-asset-unverified");
    if (!perpetualEconomicAssetId) failures.push("perpetual-economic-asset-unverified");
    if (!spotEconomicAssetId || spotEconomicAssetId !== perpetualEconomicAssetId) failures.push("economic-asset-mismatch");
  }
  return [...new Set(failures)];
}

function validateInstrumentMetadata(instrument: RegistryInstrument | undefined, exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, leg: "spot" | "perpetual", failures: string[]) {
  if (!instrument) {
    failures.push(`${leg}-instrument-metadata-missing`);
    return;
  }
  if (instrument.id !== `${exchange}:${market}:${symbol}` || instrument.venue !== exchange || instrument.marketType !== market || instrument.venueSymbol !== symbol) {
    failures.push(`${leg}-instrument-identity-mismatch`);
  }
  if (instrument.status !== "trading") failures.push(`${leg}-instrument-not-trading`);
  if (instrument.assetId !== instrument.baseAsset || instrument.venueSymbol !== `${instrument.baseAsset}${instrument.quoteAsset}`) {
    failures.push(`${leg}-native-identity-mismatch`);
  }
  if (instrument.quoteAsset !== "USDT" || instrument.settleAsset !== "USDT") failures.push(`${leg}-settlement-model-unsupported`);
  if (market === "perpetual" && instrument.contractDirection !== "linear") failures.push(`${leg}-contract-direction-unsupported`);
  if (market === "spot" && instrument.contractDirection !== undefined) failures.push(`${leg}-contract-direction-unsupported`);
  if (instrument.quantityUnit !== "base" || instrument.contractMultiplier !== 1) failures.push(`${leg}-quantity-model-unsupported`);
  if (!validStep(instrument.quantityStep)) failures.push(`${leg}-quantity-step-unverified`);
  if (!validStep(instrument.minimumQuantity)) failures.push(`${leg}-minimum-quantity-unverified`);
  if (!validStep(instrument.minimumNotional)) failures.push(`${leg}-minimum-notional-unverified`);
}

export function walkDepth(exchange: ArbitrageExchange, market: ArbitrageMarket, side: "buy" | "sell", book: DepthLevel[], requestedNotionalUsd: number, capturedAt: number): ArbitrageDepthLeg {
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
    exchange,
    market,
    side,
    requestedNotionalUsd,
    filledNotionalUsd,
    quantity,
    averagePrice,
    worstPrice,
    topPrice,
    slippageBps: topPrice > 0 ? Math.max(0, (directionalMove / topPrice) * 10_000) : 0,
    levelsUsed,
    complete: remaining <= Math.max(0.01, requestedNotionalUsd * 1e-8),
    capturedAt
  };
}

export function walkDepthByQuantity(exchange: ArbitrageExchange, market: ArbitrageMarket, side: "buy" | "sell", book: DepthLevel[], requestedQuantity: number, requestedNotionalUsd: number, capturedAt: number): ArbitrageDepthLeg {
  let remaining = requestedQuantity;
  let quantity = 0;
  let filledNotionalUsd = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableQuantity] of book) {
    if (remaining <= quantityTolerance(FALLBACK_QUANTITY_STEP, requestedQuantity)) break;
    const takeQuantity = Math.min(remaining, availableQuantity);
    quantity += takeQuantity;
    filledNotionalUsd += price * takeQuantity;
    remaining -= takeQuantity;
    worstPrice = price;
    levelsUsed += 1;
  }
  const topPrice = book[0]?.[0] ?? 0;
  const averagePrice = quantity > 0 ? filledNotionalUsd / quantity : 0;
  const directionalMove = side === "buy" ? averagePrice - topPrice : topPrice - averagePrice;
  return {
    exchange,
    market,
    side,
    requestedNotionalUsd,
    filledNotionalUsd,
    quantity,
    averagePrice,
    worstPrice,
    topPrice,
    slippageBps: topPrice > 0 ? Math.max(0, (directionalMove / topPrice) * 10_000) : 0,
    levelsUsed,
    complete: requestedQuantity > 0 && remaining <= quantityTolerance(FALLBACK_QUANTITY_STEP, requestedQuantity),
    capturedAt
  };
}

export function commonQuantityStep(spotStep: number, perpetualStep: number): number {
  if (!validStep(spotStep) || !validStep(perpetualStep)) throw new Error("Quantity steps must be finite positive numbers");
  const decimals = Math.max(decimalPlaces(spotStep), decimalPlaces(perpetualStep));
  const scale = 10n ** BigInt(decimals);
  const spotUnits = BigInt(Math.round(spotStep * Number(scale)));
  const perpetualUnits = BigInt(Math.round(perpetualStep * Number(scale)));
  if (spotUnits === 0n || perpetualUnits === 0n) throw new Error(`Quantity steps smaller than 1e-${MAX_STEP_DECIMALS} are unsupported`);
  const commonUnits = leastCommonMultiple(spotUnits, perpetualUnits);
  const result = Number(commonUnits) / Number(scale);
  if (!validStep(result)) throw new Error("Unable to derive a common quantity step");
  return result;
}

function floorToStep(quantity: number, step: number): number {
  if (!(quantity > 0) || !Number.isFinite(quantity)) return 0;
  const tolerance = quantityTolerance(step, quantity);
  const units = Math.floor((quantity + tolerance) / step);
  return Number((units * step).toFixed(decimalPlaces(step)));
}

function totalQuantity(levels: DepthLevel[]): number {
  return levels.reduce((total, [, quantity]) => total + quantity, 0);
}

function validStep(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function reviewedEconomicAssetId(instrument: RegistryInstrument): string | undefined {
  const reviewed = reviewedBasisEconomicAssetId({
    venue: instrument.venue,
    marketType: instrument.marketType,
    symbol: instrument.venueSymbol,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    settleAsset: instrument.settleAsset
  });
  return reviewed && instrument.economicAssetId === reviewed ? reviewed : undefined;
}

function decimalPlaces(value: number): number {
  const normalized = value.toExponential(MAX_STEP_DECIMALS);
  const [coefficient, exponentText] = normalized.split("e");
  const exponent = Number(exponentText);
  const significantDecimals = (coefficient?.split(".")[1] ?? "").replace(/0+$/, "").length;
  return Math.min(MAX_STEP_DECIMALS, Math.max(0, significantDecimals - exponent));
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  return (left / greatestCommonDivisor(left, right)) * right;
}

function quantityTolerance(step: number, quantity: number): number {
  return Math.max(step * 1e-9, Number.EPSILON * Math.max(1, Math.abs(quantity)) * 16);
}

function notionalTolerance(notional: number): number {
  return Math.max(1e-8, Number.EPSILON * Math.max(1, Math.abs(notional)) * 16);
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exchangeTimestamp(value: unknown): { exchangeTs?: number } {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? { exchangeTs: parsed } : {};
}

function validSequence(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function bookSequence(value: unknown): { sequence?: number } {
  const parsed = Number(value ?? 0);
  return validSequence(parsed) ? { sequence: parsed } : {};
}

function instrumentConstraintKey(instrument: RegistryInstrument | undefined) {
  if (!instrument) return "unverified";
  return [instrument.id, instrument.status, instrument.economicAssetId ?? "unknown", instrument.quantityUnit ?? "unknown", instrument.contractMultiplier, instrument.quantityStep, instrument.minimumQuantity, instrument.minimumNotional, instrument.settleAsset].join("|");
}

function levels(input: Array<[string, string]> | undefined): DepthLevel[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) throw new Error("Order book must contain at most 100 levels per side");
  return input.map((level, index) => {
    if (!Array.isArray(level) || level.length !== 2) throw new Error(`Order book level ${index} is malformed`);
    const parsed: DepthLevel = [Number(level[0]), Number(level[1])];
    if (!Number.isFinite(parsed[0]) || parsed[0] <= 0 || !Number.isFinite(parsed[1]) || parsed[1] <= 0) {
      throw new Error(`Order book level ${index} contains an invalid price or quantity`);
    }
    return parsed;
  });
}
