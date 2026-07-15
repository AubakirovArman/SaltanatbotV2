import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { MutableL2Level } from "../l2/types.js";

export const CONTINUOUS_PUBLIC_VENUES = ["okx", "gate", "hyperliquid", "deribit", "kraken", "coinbase", "dydx", "kucoin", "mexc"] as const;
export type ContinuousPublicVenue = (typeof CONTINUOUS_PUBLIC_VENUES)[number];

export interface ContinuousFeedInstrument {
  venue: ContinuousPublicVenue;
  /** Stable registry identity used by research engines. */
  instrumentId: string;
  /** Exact public subscription symbol understood by the venue. */
  venueSymbol: string;
  marketType: Extract<VenueMarketType, "spot" | "perpetual" | "future">;
  quantityUnit: VenueQuantityUnit;
}

export type BookContinuityProof =
  | {
      kind: "sequence-verified";
      sequence: number;
      protocol: "okx-seqid" | "gate-update-id" | "deribit-change-id" | "coinbase-advanced-sequence" | "kucoin-obu-range" | "mexc-spot-version" | "mexc-futures-version";
    }
  | {
      /**
       * Kraken Spot v2 has no numeric venue sequence. Its CRC32 proves the fully applied top-book
       * state; `sequence` is a connection-local update ordinal and is scoped by
       * `connectionGeneration`.
       */
      kind: "checksum-verified";
      sequence: number;
      checksum: number;
      protocol: "kraken-spot-crc32";
    }
  | {
      /** The protocol exposes useful ordering but remains non-route-ready for the stated reason. */
      kind: "sequence-observed";
      sequence: number;
      protocol: "kraken-futures-seq" | "dydx-indexer-message-id";
      sequenceVerified: false;
    }
  | {
      kind: "atomic-snapshot";
      protocol: "hyperliquid-block-snapshot";
      /** Explicitly false: a full replacement is not a delta-continuity proof. */
      sequenceVerified: false;
    };

export interface ContinuousPublicBook {
  venue: ContinuousPublicVenue;
  instrumentId: string;
  venueSymbol: string;
  marketType: ContinuousFeedInstrument["marketType"];
  quantityUnit: VenueQuantityUnit;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  exchangeTs: number;
  receivedAt: number;
  complete: true;
  continuity: BookContinuityProof;
  source: "public-websocket";
  connectionGeneration: number;
  retainedDepth: number;
}

export interface ContinuousTopBook {
  venue: ContinuousPublicVenue;
  instrumentId: string;
  marketType: ContinuousFeedInstrument["marketType"];
  quantityUnit: VenueQuantityUnit;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  exchangeTs: number;
  receivedAt: number;
  continuity: BookContinuityProof;
  connectionGeneration: number;
}

export interface ContinuousFundingObservation {
  venue: ContinuousPublicVenue;
  instrumentId: string;
  currentEstimateRate: number;
  nextEstimateRate?: number;
  nextFundingTime?: number;
  intervalMinutes?: number;
  /** True only when the public message proves both the next settlement and interval. */
  scheduleVerified: boolean;
  exchangeTs?: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
  source: "public-websocket";
  connectionGeneration: number;
}

export type ContinuousFeedState = "connecting" | "syncing" | "live" | "gap" | "reconnecting" | "stopped" | "overloaded" | "error";

export interface ContinuousFeedStatus {
  venue: ContinuousPublicVenue;
  instrumentId: string;
  state: ContinuousFeedState;
  message: string;
  generation: number;
}

export interface ContinuousFeedCallbacks {
  onBook(book: ContinuousPublicBook): void;
  onTopBook(book: ContinuousTopBook): void;
  onFunding(funding: ContinuousFundingObservation): void;
  /** Called before every resync/reconnect so stale generations cannot remain route-ready. */
  onInvalidate(reason: string): void;
  onStatus(status: ContinuousFeedStatus): void;
}

export interface ContinuousFeedSubscription {
  close(): void;
}

export interface ContinuousFeedSnapshot {
  instrument: ContinuousFeedInstrument;
  status: ContinuousFeedStatus;
  /** Last accepted transport observation, retained across invalidation for diagnostics only. */
  lastReceive?: {
    at: number;
    kind: "book" | "top-book" | "funding";
    connectionGeneration: number;
  };
  /** Last accepted book proof, retained across invalidation and never treated as a current book. */
  lastBookEvidence?: {
    receivedAt: number;
    connectionGeneration: number;
    continuity: BookContinuityProof;
  };
  book?: ContinuousPublicBook;
  topBook?: ContinuousTopBook;
  funding?: ContinuousFundingObservation;
}

export function continuousFeedInstrument(value: RegistryInstrument): ContinuousFeedInstrument | undefined {
  if (!CONTINUOUS_PUBLIC_VENUES.includes(value.venue as ContinuousPublicVenue)) return undefined;
  if (value.marketType !== "spot" && value.marketType !== "perpetual" && value.marketType !== "future") return undefined;
  if (!value.quantityUnit) return undefined;
  return {
    venue: value.venue as ContinuousPublicVenue,
    instrumentId: value.id,
    venueSymbol: value.venueSymbol,
    marketType: value.marketType,
    quantityUnit: value.quantityUnit
  };
}
