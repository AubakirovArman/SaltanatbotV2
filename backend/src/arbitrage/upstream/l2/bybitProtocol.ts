import type { ArbitrageMarket } from "../../types.js";
import { BoundedL2Book, parseL2Levels } from "./boundedBook.js";
import type { L2ReconstructionResult, L2TimestampSource, MutableL2Level, SequenceVerifiedL2Book } from "./types.js";

const MAX_LEVELS_PER_PAYLOAD = 1_000;

export interface BybitDepthEvent {
  type: "snapshot" | "delta";
  symbol: string;
  updateId: number;
  crossSequence: number;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  exchangeTs: number;
  exchangeTimestampSource: L2TimestampSource;
  receivedAt: number;
}

interface BybitReconstructorOptions {
  maxLevels?: number;
  publishLevels?: number;
}

export function parseBybitDepthEvent(value: unknown, receivedAt = Date.now()): BybitDepthEvent | undefined {
  const envelope = object(value);
  if (!envelope || (envelope.type !== "snapshot" && envelope.type !== "delta")) return undefined;
  const data = object(envelope.data);
  if (!data) return undefined;
  const topic = String(envelope.topic ?? "");
  const topicSymbol = topic.match(/^orderbook\.\d+\.([A-Z0-9-]{2,32})$/)?.[1];
  const symbol = String(data.s ?? topicSymbol ?? "").toUpperCase();
  const updateId = safePositiveInteger(data.u);
  const crossSequence = safePositiveInteger(data.seq);
  const bids = parseL2Levels(data.b, MAX_LEVELS_PER_PAYLOAD);
  const asks = parseL2Levels(data.a, MAX_LEVELS_PER_PAYLOAD);
  const matchingEngineTime = safePositiveInteger(envelope.cts);
  const systemTime = safePositiveInteger(envelope.ts);
  const exchangeTs = matchingEngineTime ?? systemTime;
  if (!validSymbol(symbol) || updateId === undefined || crossSequence === undefined || !bids || !asks || exchangeTs === undefined || !validReceiptTime(receivedAt)) return undefined;
  return {
    type: envelope.type,
    symbol,
    updateId,
    crossSequence,
    bids,
    asks,
    exchangeTs,
    exchangeTimestampSource: matchingEngineTime === undefined ? "event-time" : "matching-engine-time",
    receivedAt
  };
}

/**
 * Bybit Spot and Linear both start from the WebSocket snapshot mandated by V5.
 * `u` is checked as the contiguous per-book sequence; `seq` is only required to
 * advance because it is cross-product and is not expected to increment by one.
 */
export class BybitDepthReconstructor {
  private readonly book: BoundedL2Book;
  private readonly publishLevels: number;
  private updateId?: number;
  private crossSequence?: number;
  private ready = false;

  constructor(
    readonly market: ArbitrageMarket,
    readonly symbol: string,
    options: BybitReconstructorOptions = {}
  ) {
    if (!validSymbol(symbol)) throw new Error("Invalid Bybit L2 symbol");
    this.book = new BoundedL2Book(options.maxLevels ?? 200);
    this.publishLevels = options.publishLevels ?? Math.min(200, this.book.maxLevels);
    if (!Number.isSafeInteger(this.publishLevels) || this.publishLevels < 1 || this.publishLevels > this.book.maxLevels) throw new Error("Invalid Bybit publish depth");
  }

  reset() {
    this.book.clear();
    this.updateId = undefined;
    this.crossSequence = undefined;
    this.ready = false;
  }

  push(event: BybitDepthEvent): L2ReconstructionResult {
    if (event.symbol !== this.symbol) return this.fail("Bybit depth symbol changed inside one book stream");
    if (event.type === "snapshot") return this.applySnapshot(event);
    if (!this.ready || this.updateId === undefined || this.crossSequence === undefined) return this.fail("Bybit depth delta arrived before a WebSocket snapshot");
    if (event.updateId === this.updateId && event.crossSequence <= this.crossSequence) return { kind: "ignored" };
    if (event.updateId !== this.updateId + 1) return this.fail(`Bybit depth gap: expected u ${this.updateId + 1}, received ${event.updateId}`);
    if (event.crossSequence <= this.crossSequence) return this.fail(`Bybit cross sequence regressed from ${this.crossSequence} to ${event.crossSequence}`);
    return this.applyAccepted(event);
  }

  isReady() {
    return this.ready;
  }

  private applySnapshot(event: BybitDepthEvent): L2ReconstructionResult {
    try {
      this.book.reset(event.bids, event.asks);
      this.updateId = event.updateId;
      this.crossSequence = event.crossSequence;
      this.ready = true;
      return { kind: "ready", book: this.output(event) };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Bybit snapshot is invalid");
    }
  }

  private applyAccepted(event: BybitDepthEvent): L2ReconstructionResult {
    try {
      this.book.apply(event.bids, event.asks);
      this.updateId = event.updateId;
      this.crossSequence = event.crossSequence;
      return { kind: "ready", book: this.output(event) };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Bybit reconstructed depth is invalid");
    }
  }

  private output(event: BybitDepthEvent): SequenceVerifiedL2Book {
    const levels = this.book.snapshot(this.publishLevels);
    return {
      exchange: "bybit",
      market: this.market,
      symbol: this.symbol,
      bids: levels.bids,
      asks: levels.asks,
      sequence: event.updateId,
      sequenceVerified: true,
      exchangeTs: event.exchangeTs,
      exchangeTimestampSource: event.exchangeTimestampSource,
      receivedAt: event.receivedAt,
      source: "websocket-reconstructed",
      retainedDepth: this.book.maxLevels
    };
  }

  private fail(reason: string): L2ReconstructionResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

/** Explicit product factories keep Spot and Linear lifecycle selection visible at call sites. */
export function createBybitSpotDepthReconstructor(symbol: string, options?: BybitReconstructorOptions) {
  return new BybitDepthReconstructor("spot", symbol, options);
}

export function createBybitLinearDepthReconstructor(symbol: string, options?: BybitReconstructorOptions) {
  return new BybitDepthReconstructor("perpetual", symbol, options);
}

function validSymbol(value: string) {
  return /^[A-Z0-9-]{2,32}$/.test(value);
}

function safePositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validReceiptTime(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
