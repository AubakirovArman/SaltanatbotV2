import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { normalizeCoinbaseDepth, normalizeCoinbaseProducts, normalizeCoinbaseTopBook } from "./normalize.js";
import { CoinbasePublicTransport, type CoinbaseTransportOptions } from "./transport.js";
import { instrumentId, validation } from "./validation.js";

const MAX_DEPTH_LEVELS = 500;

export const COINBASE_PUBLIC_CAPABILITIES = Object.freeze({
  venue: "coinbase",
  publicData: true,
  spot: true,
  margin: false,
  perpetual: false,
  datedFuture: false,
  option: false,
  nativeSpread: false,
  topBook: true,
  depth: true,
  publicTrades: false,
  funding: false,
  borrow: false,
  depositWithdrawal: false,
  privateExecution: false,
  demoEnvironment: false,
  scopes: [{ product: "spot", operation: "public-data", status: "implemented" }]
} satisfies VenueCapabilityManifest);

export interface CoinbasePublicAdapterOptions extends CoinbaseTransportOptions {
  now?: () => number;
}

/** Public Coinbase Exchange market-data adapter. It has no JWT or private request surface. */
export class CoinbasePublicAdapter implements PublicVenueAdapter {
  readonly venue = "coinbase";
  private readonly transport: CoinbasePublicTransport;
  private readonly now: () => number;

  constructor(options: CoinbasePublicAdapterOptions = {}) {
    this.transport = new CoinbasePublicTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(COINBASE_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    requireSpot(marketType);
    const raw = await this.transport.get("/products", {}, signal);
    if (!Array.isArray(raw)) throw validation("products response must be an array");
    const normalized = normalizeCoinbaseProducts(raw);
    if (raw.length === 0) throw validation("products response is empty");
    if (normalized.instruments.length === 0) throw validation("products response contains no valid rows");
    return { venue: this.venue, marketType, receivedAt: this.now(), ...normalized };
  }

  async tickers(marketType: VenueMarketType, _signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    requireSpot(marketType);
    throw new PublicVenueAdapterError(this.venue, "unsupported", "Coinbase Exchange has no bounded bulk BBO endpoint; use ticker() for a selected product");
  }

  async ticker(productId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    requireSpot(marketType);
    const id = instrumentId(productId, "productId");
    const book = await this.transport.get(`/products/${encodeURIComponent(id)}/book`, { level: "1" }, signal);
    return normalizeCoinbaseTopBook(book, id, this.now());
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    requireSpot(request.marketType);
    const id = instrumentId(request.instrumentId, "productId");
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DEPTH_LEVELS) {
      throw validation(`depth limit must be an integer between 1 and ${MAX_DEPTH_LEVELS}`);
    }
    const book = await this.transport.get(`/products/${encodeURIComponent(id)}/book`, { level: "2" }, signal);
    return normalizeCoinbaseDepth(book, { productId: id, limit }, this.now());
  }

  async funding(_instrumentId: string, _options?: { historyLimit?: number; signal?: AbortSignal }): Promise<PublicFundingSchedule> {
    throw new PublicVenueAdapterError(this.venue, "unsupported", "funding is not available for Coinbase Exchange spot products");
  }
}

function requireSpot(value: VenueMarketType): asserts value is "spot" {
  if (value !== "spot") throw new PublicVenueAdapterError("coinbase", "unsupported", `unsupported market type ${value}`);
}
