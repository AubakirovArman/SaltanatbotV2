import type { RegistryInstrument, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTopBook } from "../publicTypes.js";

export type DydxNetwork = "mainnet" | "testnet";
export type DydxMarketType = Extract<VenueMarketType, "perpetual">;

export interface DydxInstrument extends RegistryInstrument {
  venue: "dydx";
  marketType: "perpetual";
  clobPairId: number;
  dataPlane: "indexer";
  marketStatus: string;
  oraclePrice?: number;
  nextFundingRate?: number;
  initialMarginFraction: number;
  maintenanceMarginFraction: number;
}

export interface DydxInstrumentSnapshot extends Omit<PublicInstrumentSnapshot, "instruments"> {
  venue: "dydx";
  network: DydxNetwork;
  instruments: DydxInstrument[];
}

/**
 * Indexer books are useful research observations, not the canonical proposer mempool.
 * Receipt time is explicit because the REST payload has no exchange timestamp.
 */
export interface DydxIndexerDepthSnapshot extends PublicDepthSnapshot {
  venue: "dydx";
  dataPlane: "indexer-rest";
  sequence: 0;
  sequenceAvailable: false;
  canonical: false;
  executable: false;
  executionStatus: "research-only";
  timestampSource: "local-receive";
}

export interface DydxIndexerTopBook extends PublicTopBook {
  venue: "dydx";
  dataPlane: "indexer-rest";
  sequenceAvailable: false;
  canonical: false;
  executable: false;
  executionStatus: "research-only";
  timestampSource: "local-receive";
}

export interface DydxFundingPoint extends PublicFundingPoint {
  effectiveAtHeight: number;
  price: number;
  realizedRate: number;
  method: "indexer-settled";
}

export interface DydxFundingSchedule extends Omit<PublicFundingSchedule, "history"> {
  venue: "dydx";
  network: DydxNetwork;
  estimateSource: "perpetualMarkets.nextFundingRate";
  timestampSource: "local-receive";
  history: DydxFundingPoint[];
}

export interface DydxIndexerPriceLevelInput {
  price: string | number;
  size: string | number;
  offset?: string | number;
}

export type DydxIndexerPriceLevelUpdate = DydxIndexerPriceLevelInput | readonly [price: string | number, size: string | number, offset?: string | number];

export interface DydxIndexerBookMessage {
  type: "subscribed" | "channel_data";
  connectionId: string;
  instrumentId: string;
  messageId: number;
  bids?: readonly DydxIndexerPriceLevelUpdate[];
  asks?: readonly DydxIndexerPriceLevelUpdate[];
}

export interface DydxIndexerBookView {
  status: "awaiting-snapshot" | "ready" | "invalidated";
  instrumentId: string;
  connectionId?: string;
  lastMessageId?: number;
  sequenceVerified: boolean;
  canonical: false;
  routeReady: false;
  executionStatus: "research-only";
  rawCrossed: boolean;
  uncrossed: boolean;
  bids: readonly (readonly [price: number, quantity: number, logicalOffset: string])[];
  asks: readonly (readonly [price: number, quantity: number, logicalOffset: string])[];
  invalidReason?: string;
}

export type DydxNodeExecMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 100 | 101 | 102;
export type DydxNodeBookSide = "bid" | "ask";

export interface DydxNodeOrder {
  orderId: string;
  clobPairId: number;
  side: DydxNodeBookSide;
  price: number;
  initialQuantums: number;
  filledQuantums: number;
}

export type DydxNodeBookOperation = { kind: "place"; order: DydxNodeOrder } | { kind: "fill"; orderId: string; totalFilledQuantums: number } | { kind: "remove"; orderId: string };

export interface DydxNodeBookBatch {
  blockHeight: number;
  execMode: DydxNodeExecMode;
  snapshot: boolean;
  operations: readonly DydxNodeBookOperation[];
}

export interface DydxNodeBookView {
  status: "awaiting-snapshot" | "optimistic" | "finalized" | "invalidated";
  routeReady: boolean;
  blockHeight?: number;
  finalizedHeight?: number;
  execMode?: DydxNodeExecMode;
  orderCount: number;
  bids: readonly (readonly [price: number, remainingQuantums: number, orderCount: number])[];
  asks: readonly (readonly [price: number, remainingQuantums: number, orderCount: number])[];
  invalidReason?: string;
}
