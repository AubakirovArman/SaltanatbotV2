import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicTickerSnapshot, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { normalizeHyperliquidDepth, normalizeHyperliquidFunding, normalizeHyperliquidInstruments, normalizeHyperliquidTopBook } from "./normalize.js";
import { HyperliquidInfoTransport } from "./transport.js";
import type { HyperliquidTransportOptions } from "./transport.js";
import type { HyperliquidDepthSnapshot, HyperliquidFundingSchedule, HyperliquidInstrumentSnapshot, HyperliquidMarketType, HyperliquidTopBook } from "./types.js";

const HOUR_MS = 60 * 60_000;

export const HYPERLIQUID_PUBLIC_CAPABILITIES: VenueCapabilityManifest = Object.freeze({
  venue: "hyperliquid",
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
  demoEnvironment: true
});

export interface HyperliquidPublicAdapterOptions extends HyperliquidTransportOptions {
  now?: () => number;
}

/** Public HyperCore `/info` adapter. It has no wallet, signing or `/exchange` code path. */
export class HyperliquidPublicAdapter implements PublicVenueAdapter {
  readonly venue = "hyperliquid";
  private readonly transport: HyperliquidInfoTransport;
  private readonly now: () => number;

  constructor(options: HyperliquidPublicAdapterOptions = {}) {
    this.transport = new HyperliquidInfoTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return { ...HYPERLIQUID_PUBLIC_CAPABILITIES };
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<HyperliquidInstrumentSnapshot> {
    const normalizedMarket = supportedMarket(marketType);
    const request = normalizedMarket === "spot" ? ({ type: "spotMetaAndAssetCtxs" } as const) : ({ type: "metaAndAssetCtxs" } as const);
    const raw = await this.transport.post(request, signal);
    const receivedAt = timestamp(this.now(), "receivedAt");
    const normalized = normalizeHyperliquidInstruments(raw, normalizedMarket, this.transport.network, receivedAt);
    if (normalized.instruments.length === 0) throw validation(`${normalizedMarket} metadata contains no valid instruments`);
    return {
      venue: this.venue,
      network: this.transport.network,
      marketType: normalizedMarket,
      receivedAt,
      instruments: normalized.instruments,
      rejectedRows: normalized.rejectedRows
    };
  }

  async tickers(marketType: VenueMarketType, _signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    supportedMarket(marketType);
    throw new PublicVenueAdapterError(
      this.venue,
      "unsupported",
      "Hyperliquid has no bounded bulk executable-book endpoint; use ticker() for one exact instrument"
    );
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<HyperliquidTopBook> {
    const normalizedMarket = supportedMarket(marketType);
    const coin = requestCoin(instrumentId, normalizedMarket);
    const raw = await this.transport.post({ type: "l2Book", coin }, signal);
    return normalizeHyperliquidTopBook(raw, { instrumentId: coin, marketType: normalizedMarket }, timestamp(this.now(), "receivedAt"));
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<HyperliquidDepthSnapshot> {
    const marketType = supportedMarket(request.marketType);
    const instrumentId = requestCoin(request.instrumentId, marketType);
    const limit = request.limit ?? 20;
    boundedInteger(limit, "depth limit", 1, 20);
    const raw = await this.transport.post({ type: "l2Book", coin: instrumentId }, signal);
    return normalizeHyperliquidDepth(raw, { instrumentId, marketType, limit }, timestamp(this.now(), "receivedAt"));
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<HyperliquidFundingSchedule> {
    const coin = requestCoin(instrumentId, "perpetual");
    const historyLimit = boundedHistoryLimit(options.historyLimit);
    const receivedAt = timestamp(this.now(), "receivedAt");
    const startTime = Math.max(0, receivedAt - (historyLimit + 2) * HOUR_MS);
    const predictionRequest = this.transport.post({ type: "predictedFundings" }, options.signal);
    const historyRequest = this.transport.post({ type: "fundingHistory", coin, startTime, endTime: receivedAt }, options.signal);
    const [predictionResult, historyResult] = await Promise.allSettled([predictionRequest, historyRequest]);
    if (options.signal?.aborted) throw cancelled();
    if (predictionResult.status === "rejected") throw predictionResult.reason;
    const historyRaw = historyResult.status === "fulfilled" ? historyResult.value : [];
    const historyErrors = historyResult.status === "rejected" ? [`fundingHistory: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeHyperliquidFunding(predictionResult.value, historyRaw, coin, this.transport.network, timestamp(this.now(), "receivedAt"), historyLimit, historyErrors);
  }
}

function supportedMarket(value: VenueMarketType): HyperliquidMarketType {
  if (value === "spot" || value === "perpetual") return value;
  throw new PublicVenueAdapterError("hyperliquid", "unsupported", `unsupported market type ${value}`);
}

function requestCoin(value: string, marketType: HyperliquidMarketType) {
  const coin = value.trim();
  if (marketType === "spot") {
    if (coin === "PURR/USDC" || /^@[0-9]{1,6}$/.test(coin)) return coin;
    throw validation("spot instrumentId must be PURR/USDC or the native @pair-index coin");
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(coin)) return coin;
  throw validation("perpetual instrumentId must be an exact first-DEX coin name");
}

function boundedHistoryLimit(value: number | undefined) {
  if (value === undefined) return 24;
  if (!Number.isFinite(value)) throw validation("historyLimit must be finite");
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw validation(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function timestamp(value: number, label: string) {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function validation(message: string) {
  return new PublicVenueAdapterError("hyperliquid", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("hyperliquid", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
