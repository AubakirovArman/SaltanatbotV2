import type { RegistryInstrument, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook } from "../publicTypes.js";

export type HyperliquidNetwork = "mainnet" | "testnet";
export type HyperliquidMarketType = Extract<VenueMarketType, "spot" | "perpetual">;

export type HyperliquidInfoRequest =
  | { type: "spotMetaAndAssetCtxs" }
  | { type: "metaAndAssetCtxs" }
  | { type: "l2Book"; coin: string }
  | { type: "candleSnapshot"; req: { coin: string; interval: string; startTime: number; endTime: number } }
  | { type: "predictedFundings" }
  | { type: "fundingHistory"; coin: string; startTime: number; endTime: number };

export interface HyperliquidPriceRules {
  /** Hyperliquid does not publish one static tick valid at every price magnitude. */
  staticTickSize: false;
  maxSignificantFigures: 5;
  maxDecimals: number;
  integerPricesAlwaysAllowed: true;
}

export interface HyperliquidTokenIdentity {
  index: number;
  tokenId: string;
  nativeName: string;
  sizeDecimals: number;
  canonical: boolean;
}

export interface HyperliquidReferenceContext {
  source: "hypercore-asset-context";
  /** Mark/oracle/mid fields are references and are never an executable top book. */
  executable: false;
  timestampSource: "local-receive";
  observedAt: number;
  midPrice?: number;
  markPrice?: number;
  oraclePrice?: number;
  currentFundingRate?: number;
  openInterest?: number;
  notionalVolume24h?: number;
  baseVolume24h?: number;
  previousDayPrice?: number;
}

export interface HyperliquidInstrument extends RegistryInstrument {
  network: HyperliquidNetwork;
  dataPlane: "hypercore-info";
  dex: "";
  /** Exact `coin` value accepted by public info calls. */
  apiCoin: string;
  /** Perp universe index, or 10000 + spot pair index. Network-specific. */
  assetIndex: number;
  pairIndex?: number;
  pairCanonical?: boolean;
  baseToken?: HyperliquidTokenIdentity;
  quoteToken?: HyperliquidTokenIdentity;
  sizeDecimals: number;
  priceRules: HyperliquidPriceRules;
  delistState: "active" | "delisted" | "not-published-for-spot";
  delistStateVerified: boolean;
  referenceContext: HyperliquidReferenceContext;
}

export interface HyperliquidInstrumentSnapshot extends Omit<PublicInstrumentSnapshot, "instruments"> {
  network: HyperliquidNetwork;
  instruments: HyperliquidInstrument[];
}

export interface HyperliquidTopBook extends PublicTopBook {
  source: "l2Book";
  executable: true;
  sequenceAvailable: false;
}

export interface HyperliquidTickerSnapshot extends Omit<PublicTickerSnapshot, "tickers"> {
  network: HyperliquidNetwork;
  tickers: HyperliquidTopBook[];
}

export interface HyperliquidDepthSnapshot extends PublicDepthSnapshot {
  source: "l2Book";
  sequence: 0;
  sequenceVerified: false;
}

export interface HyperliquidFundingPoint extends PublicFundingPoint {
  realizedRate: number;
  premium?: number;
  method: "settled-hourly";
}

export interface HyperliquidFundingSchedule extends Omit<PublicFundingSchedule, "history"> {
  network: HyperliquidNetwork;
  currentEstimateSource: "predictedFundings:HlPerp";
  timestampSource: "local-receive";
  history: HyperliquidFundingPoint[];
}
