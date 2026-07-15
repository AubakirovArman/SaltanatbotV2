import type { RegistryInstrument, VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook, PublicVenueAdapter } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { definePublicVenueAdapterPlugin } from "./descriptor.js";
import { PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION, type PublicOnlyCapabilityManifest, type PublicVenueCertificationFixture, type PublicVenueCertificationHarness, type PublicVenueFailureInjection } from "./types.js";

export const FAKE_VENUE_NOW = 1_784_035_200_000;

export const FAKE_PUBLIC_CAPABILITIES = deepFreeze({
  venue: "fake",
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
  demoEnvironment: true,
  scopes: [
    { product: "spot", operation: "public-data", status: "implemented" },
    { product: "perpetual", operation: "public-data", status: "implemented" }
  ]
} satisfies PublicOnlyCapabilityManifest<"fake">);

export interface FakePublicVenueAdapterOptions {
  readonly failure?: PublicVenueFailureInjection;
  readonly now?: () => number;
}

/** Deterministic credential-free venue used only by the conformance suite. */
export class FakePublicVenueAdapter implements PublicVenueAdapter {
  readonly venue = "fake" as const;
  private readonly failure?: PublicVenueFailureInjection;
  private readonly now: () => number;

  constructor(options: FakePublicVenueAdapterOptions = {}) {
    this.failure = options.failure;
    this.now = options.now ?? (() => FAKE_VENUE_NOW);
  }

  capabilities(): VenueCapabilityManifest {
    return structuredClone(FAKE_PUBLIC_CAPABILITIES);
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    this.enter("instruments", marketType, signal);
    const normalizedMarket = supportedMarket(marketType);
    return immutable({
      venue: this.venue,
      marketType: normalizedMarket,
      receivedAt: this.timestamp(),
      instruments: [instrument(normalizedMarket)],
      rejectedRows: []
    });
  }

  async tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    this.enter("tickers", marketType, signal);
    const normalizedMarket = supportedMarket(marketType);
    return immutable({
      venue: this.venue,
      marketType: normalizedMarket,
      receivedAt: this.timestamp(),
      tickers: [topBook(normalizedMarket, this.timestamp())],
      rejectedRows: []
    });
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    this.enter("ticker", marketType, signal);
    const normalizedMarket = supportedMarket(marketType);
    requireInstrument(instrumentId, normalizedMarket);
    return immutable(topBook(normalizedMarket, this.timestamp()));
  }

  async depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot> {
    this.enter("depth", request.marketType, signal);
    const marketType = supportedMarket(request.marketType);
    requireInstrument(request.instrumentId, marketType);
    if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 20)) {
      throw error("validation", "depth limit must be an integer from 1 to 20");
    }
    const now = this.timestamp();
    return immutable({
      venue: this.venue,
      instrumentId: nativeId(marketType),
      marketType,
      quantityUnit: "base",
      bids: [
        [99, 2],
        [98, 3]
      ],
      asks: [
        [101, 1.5],
        [102, 4]
      ],
      sequence: 42,
      exchangeTs: now - 10,
      receivedAt: now,
      complete: true
    });
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    this.enter("funding", "perpetual", options.signal);
    requireInstrument(instrumentId, "perpetual");
    if (options.historyLimit !== undefined && (!Number.isSafeInteger(options.historyLimit) || options.historyLimit < 1 || options.historyLimit > 24)) {
      throw error("validation", "historyLimit must be an integer from 1 to 24");
    }
    const now = this.timestamp();
    return immutable({
      venue: this.venue,
      instrumentId: nativeId("perpetual"),
      currentEstimateRate: 0.0001,
      fundingTime: now + 3_600_000,
      nextFundingTime: now + 7_200_000,
      intervalMinutes: 60,
      scheduleVerified: true,
      exchangeTs: now - 10,
      receivedAt: now,
      history: [
        { instrumentId: nativeId("perpetual"), fundingTime: now - 3_600_000, fundingRate: 0.00008, realizedRate: 0.00008 },
        { instrumentId: nativeId("perpetual"), fundingTime: now - 7_200_000, fundingRate: -0.00002, realizedRate: -0.00002 }
      ],
      sourceErrors: []
    });
  }

  private enter(operation: PublicVenueFailureInjection["operation"], marketType: VenueMarketType, signal?: AbortSignal) {
    if (signal?.aborted) throw error("cancelled", "request was cancelled by the caller");
    if (this.failure?.operation === operation && this.failure.marketType === marketType) {
      throw error(this.failure.kind, `deterministic injected ${this.failure.kind} failure`);
    }
  }

  private timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value <= 7_200_000) throw error("validation", "fake clock must be a positive safe-integer timestamp");
    return value;
  }
}

export const FAKE_PUBLIC_VENUE_PLUGIN = definePublicVenueAdapterPlugin({
  pluginId: "org.saltanatbotv2/fake-public",
  venue: "fake",
  authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
  adapterVersion: "1.0.0",
  contractVersion: PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION,
  officialDocsReviewedAt: "2026-07-14",
  capabilities: FAKE_PUBLIC_CAPABILITIES,
  operations: [
    { operation: "instruments", marketTypes: ["spot", "perpetual"], maxItems: 10 },
    { operation: "tickers", marketTypes: ["spot", "perpetual"], maxItems: 10 },
    { operation: "ticker", marketTypes: ["spot", "perpetual"], maxItems: 1 },
    { operation: "depth", marketTypes: ["spot", "perpetual"], maxItems: 20 },
    { operation: "funding", marketTypes: ["perpetual"], maxItems: 24 }
  ],
  createAdapter: () => new FakePublicVenueAdapter()
} as const);

export const FAKE_PUBLIC_CERTIFICATION_FIXTURES = deepFreeze([
  fixture("instruments", "spot"),
  fixture("instruments", "perpetual"),
  fixture("tickers", "spot"),
  fixture("tickers", "perpetual"),
  fixture("ticker", "spot"),
  fixture("ticker", "perpetual"),
  { ...fixture("depth", "spot"), depthLimit: 20 },
  { ...fixture("depth", "perpetual"), depthLimit: 20 },
  { ...fixture("funding", "perpetual"), historyLimit: 24 }
] as const satisfies readonly PublicVenueCertificationFixture[]);

export function createFakePublicVenueCertificationHarness(): PublicVenueCertificationHarness {
  return {
    fixtures: FAKE_PUBLIC_CERTIFICATION_FIXTURES,
    createAdapter: (failure) => new FakePublicVenueAdapter({ failure }),
    now: () => FAKE_VENUE_NOW
  };
}

function fixture(operation: PublicVenueCertificationFixture["operation"], marketType: "spot" | "perpetual") {
  return { operation, marketType, ...(operation === "ticker" || operation === "depth" || operation === "funding" ? { instrumentId: nativeId(marketType) } : {}) };
}

function instrument(marketType: "spot" | "perpetual"): RegistryInstrument {
  return {
    id: `fake:${marketType}:${nativeId(marketType)}`,
    assetId: "BTC",
    economicAssetId: "BTC",
    venue: "fake",
    venueSymbol: nativeId(marketType),
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    contractDirection: marketType === "perpetual" ? "linear" : undefined,
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading",
    ...(marketType === "perpetual" ? { fundingIntervalMinutes: 60 } : {})
  };
}

function topBook(marketType: "spot" | "perpetual", now: number): PublicTopBook {
  return {
    venue: "fake",
    instrumentId: nativeId(marketType),
    marketType,
    quantityUnit: "base",
    bid: 99,
    bidSize: 2,
    ask: 101,
    askSize: 1.5,
    last: 100,
    lastSize: 0.5,
    volume24h: 1_000,
    volumeCurrency24h: 100_000,
    exchangeTs: now - 10,
    receivedAt: now
  };
}

function nativeId(marketType: "spot" | "perpetual") {
  return marketType === "spot" ? "BTC_USDT" : "BTC_USDT_PERP";
}

function supportedMarket(value: VenueMarketType): "spot" | "perpetual" {
  if (value === "spot" || value === "perpetual") return value;
  throw error("unsupported", `unsupported fake market ${value}`);
}

function requireInstrument(value: string, marketType: "spot" | "perpetual") {
  if (value !== nativeId(marketType)) throw error("validation", `unexpected ${marketType} instrument`);
}

function error(kind: ConstructorParameters<typeof PublicVenueAdapterError>[1], message: string) {
  return new PublicVenueAdapterError("fake", kind, message, kind === "rate-limit" ? 429 : undefined);
}

function immutable<T>(value: T): T {
  return deepFreeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
