import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicTickerSnapshot, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { dydxTopBook, normalizeDydxDepth, normalizeDydxFunding, normalizeDydxInstruments } from "./normalize.js";
import { DydxIndexerTransport, type DydxIndexerTransportOptions } from "./transport.js";
import type { DydxFundingSchedule, DydxIndexerDepthSnapshot, DydxIndexerTopBook, DydxInstrumentSnapshot } from "./types.js";
import { errorMessage, safeInteger, ticker } from "./validation.js";

export const DYDX_PUBLIC_CAPABILITIES = Object.freeze({
  venue: "dydx",
  publicData: true,
  spot: false,
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
  demoEnvironment: true,
  scopes: [{ product: "perpetual", operation: "public-data", status: "implemented" }]
} satisfies VenueCapabilityManifest);

export interface DydxPublicAdapterOptions extends DydxIndexerTransportOptions {
  now?: () => number;
  transport?: DydxIndexerTransport;
}

/** Public Indexer adapter. It has no wallet, signing, account or node mutation surface. */
export class DydxPublicAdapter implements PublicVenueAdapter {
  readonly venue = "dydx";
  private readonly transport: DydxIndexerTransport;
  private readonly now: () => number;

  constructor(options: DydxPublicAdapterOptions = {}) {
    this.transport = options.transport ?? new DydxIndexerTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(DYDX_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<DydxInstrumentSnapshot> {
    requirePerpetual(marketType);
    const raw = await this.transport.getPerpetualMarkets(signal);
    const receivedAt = safeInteger(this.now(), "receivedAt", 1);
    const normalized = normalizeDydxInstruments(raw);
    return {
      venue: "dydx",
      network: this.transport.network,
      marketType: "perpetual",
      receivedAt,
      ...normalized
    };
  }

  async tickers(marketType: VenueMarketType, _signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    requirePerpetual(marketType);
    throw new PublicVenueAdapterError("dydx", "unsupported", "dYdX has no bounded bulk executable-book endpoint; request one exact Indexer research book");
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<DydxIndexerTopBook> {
    requirePerpetual(marketType);
    const normalizedId = ticker(instrumentId, "instrumentId");
    const raw = await this.transport.getOrderbook(normalizedId, signal);
    return dydxTopBook(normalizeDydxDepth(raw, { instrumentId: normalizedId, limit: 1 }, this.now()));
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<DydxIndexerDepthSnapshot> {
    requirePerpetual(request.marketType);
    const instrumentId = ticker(request.instrumentId, "instrumentId");
    const limit = safeInteger(request.limit ?? 50, "depth limit", 1, 500);
    const raw = await this.transport.getOrderbook(instrumentId, signal);
    return normalizeDydxDepth(raw, { instrumentId, limit }, this.now());
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<DydxFundingSchedule> {
    const normalizedId = ticker(instrumentId, "instrumentId");
    const historyLimit = safeInteger(options.historyLimit ?? 24, "historyLimit", 1, 100);
    const marketsRequest = this.transport.getPerpetualMarkets(options.signal);
    const historyRequest = this.transport.getHistoricalFunding(normalizedId, historyLimit, options.signal);
    const [marketsResult, historyResult] = await Promise.allSettled([marketsRequest, historyRequest]);
    if (options.signal?.aborted) throw cancelled();
    if (marketsResult.status === "rejected") throw marketsResult.reason;
    const historyRaw = historyResult.status === "fulfilled" ? historyResult.value : { historicalFunding: [] };
    const errors = historyResult.status === "rejected" ? [`historicalFunding: ${errorMessage(historyResult.reason)}`] : [];
    return normalizeDydxFunding(marketsResult.value, historyRaw, normalizedId, this.transport.network, this.now(), historyLimit, errors);
  }
}

function requirePerpetual(value: VenueMarketType): asserts value is "perpetual" {
  if (value !== "perpetual") {
    throw new PublicVenueAdapterError("dydx", "unsupported", `unsupported market type ${value}`);
  }
}

function cancelled(): PublicVenueAdapterError {
  return new PublicVenueAdapterError("dydx", "cancelled", "request was cancelled");
}
