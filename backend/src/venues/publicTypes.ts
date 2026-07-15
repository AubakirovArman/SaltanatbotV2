import type { RegistryInstrument, VenueCapabilityManifest, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";

export type PublicVenueErrorKind = "timeout" | "cancelled" | "rate-limit" | "http" | "exchange" | "validation" | "unsupported";

export class PublicVenueAdapterError extends Error {
  constructor(
    readonly venue: string,
    readonly kind: PublicVenueErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(`${venue}: ${message}`);
    this.name = "PublicVenueAdapterError";
  }
}

export interface AdapterValidationIssue {
  index: number;
  instrumentId?: string;
  message: string;
}

export interface PublicInstrumentSnapshot {
  venue: string;
  marketType: VenueMarketType;
  receivedAt: number;
  instruments: RegistryInstrument[];
  rejectedRows: AdapterValidationIssue[];
}

export interface PublicTopBook {
  venue: string;
  instrumentId: string;
  marketType: VenueMarketType;
  quantityUnit: VenueQuantityUnit;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  last?: number;
  lastSize?: number;
  volume24h?: number;
  volumeCurrency24h?: number;
  exchangeTs: number;
  receivedAt: number;
}

export interface PublicTickerSnapshot {
  venue: string;
  marketType: VenueMarketType;
  receivedAt: number;
  tickers: PublicTopBook[];
  rejectedRows: AdapterValidationIssue[];
}

export type PublicDepthLevel = readonly [price: number, quantity: number, orderCount?: number];

export interface PublicDepthSnapshot {
  venue: string;
  instrumentId: string;
  marketType: VenueMarketType;
  quantityUnit: VenueQuantityUnit;
  bids: readonly PublicDepthLevel[];
  asks: readonly PublicDepthLevel[];
  sequence: number;
  exchangeTs: number;
  receivedAt: number;
  complete: true;
}

export interface PublicFundingPoint {
  instrumentId: string;
  fundingTime: number;
  fundingRate: number;
  realizedRate?: number;
  formulaType?: string;
  method?: string;
}

export interface PublicFundingSchedule {
  venue: string;
  instrumentId: string;
  /** Current venue estimate for the settlement at fundingTime. Positive means longs pay shorts. */
  currentEstimateRate: number;
  fundingTime: number;
  nextFundingTime: number;
  intervalMinutes?: number;
  scheduleVerified: boolean;
  nextEstimateRate?: number;
  settledRate?: number;
  minimumRate?: number;
  maximumRate?: number;
  formulaType?: string;
  method?: string;
  exchangeTs: number;
  receivedAt: number;
  history: PublicFundingPoint[];
  sourceErrors: string[];
}

export interface PublicVenueAdapter {
  readonly venue: string;
  capabilities(): VenueCapabilityManifest;
  instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot>;
  tickers(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTickerSnapshot>;
  ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook>;
  depth(request: { instrumentId: string; marketType: VenueMarketType; limit?: number }, signal?: AbortSignal): Promise<PublicDepthSnapshot>;
  funding(instrumentId: string, options?: { historyLimit?: number; signal?: AbortSignal }): Promise<PublicFundingSchedule>;
}
