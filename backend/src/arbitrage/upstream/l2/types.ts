import type { ArbitrageExchange, ArbitrageMarket } from "../../types.js";

export type L2Level = readonly [price: number, quantity: number];
export type MutableL2Level = [price: number, quantity: number];

export type L2TimestampSource = "event-time" | "matching-engine-time";

/**
 * A public book which is safe to consume as sequenced market data. `sequenceVerified`
 * is deliberately a literal: REST-only snapshots and partial-depth streams cannot
 * accidentally satisfy this contract.
 */
export interface SequenceVerifiedL2Book {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  symbol: string;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  sequence: number;
  sequenceVerified: true;
  exchangeTs: number;
  exchangeTimestampSource: L2TimestampSource;
  receivedAt: number;
  source: "websocket-reconstructed";
  /** Maximum retained levels per side, not a claim that the venue has no deeper levels. */
  retainedDepth: number;
  /** Assigned by the socket lifecycle; absent only in pure protocol-unit output. */
  connectionGeneration?: number;
}

export type L2ReconstructionResult =
  | { kind: "buffered" | "ignored" }
  | { kind: "ready"; book: SequenceVerifiedL2Book }
  | { kind: "retry-snapshot"; reason: string }
  | { kind: "gap"; reason: string };

export type L2FeedState = "connecting" | "syncing" | "live" | "gap" | "reconnecting" | "stopped" | "error";

export interface L2FeedStatus {
  exchange: ArbitrageExchange;
  market: ArbitrageMarket;
  symbol: string;
  state: L2FeedState;
  message: string;
}

export interface SequenceVerifiedL2Callbacks {
  onBook(book: SequenceVerifiedL2Book): void;
  /** Called before reconnect/resync so no previous book remains executable. */
  onInvalidate(reason: string): void;
  onStatus(status: L2FeedStatus): void;
}

export interface SequenceVerifiedL2Subscription {
  close(): void;
}

export interface SequenceVerifiedBookProvider {
  getBook(exchange: ArbitrageExchange, market: ArbitrageMarket, symbol: string, signal?: AbortSignal): Promise<SequenceVerifiedL2Book>;
  /** Synchronous lease check used immediately before a derived response is released. */
  isCurrent(book: SequenceVerifiedL2Book): boolean;
}
