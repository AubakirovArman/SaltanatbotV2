import type { ArbitrageMarket } from "../../types.js";
import { BoundedL2Book, parseL2Levels } from "./boundedBook.js";
import type { L2ReconstructionResult, L2TimestampSource, MutableL2Level, SequenceVerifiedL2Book } from "./types.js";

const MAX_LEVELS_PER_PAYLOAD = 5_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 2_048;
const DEFAULT_MAX_BUFFERED_LEVEL_UPDATES = 200_000;

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  receivedAt: number;
}

export interface BinanceDepthDelta {
  symbol: string;
  firstUpdateId: number;
  finalUpdateId: number;
  previousFinalUpdateId?: number;
  bids: MutableL2Level[];
  asks: MutableL2Level[];
  exchangeTs: number;
  exchangeTimestampSource: L2TimestampSource;
  receivedAt: number;
}

interface BinanceReconstructorOptions {
  maxLevels?: number;
  publishLevels?: number;
  maxBufferedEvents?: number;
  maxBufferedLevelUpdates?: number;
}

/** Parses Spot and USD-M Futures diff-depth without conflating their sequence fields. */
export function parseBinanceDepthDelta(value: unknown, market: ArbitrageMarket, receivedAt = Date.now()): BinanceDepthDelta | undefined {
  const envelope = object(value);
  const row = object(envelope?.data ?? value);
  if (!row || (row.e !== undefined && row.e !== "depthUpdate")) return undefined;
  if (market === "perpetual" && row.st !== undefined && Number(row.st) !== 1) return undefined;
  const symbol = String(row.s ?? "").toUpperCase();
  const firstUpdateId = safePositiveInteger(row.U);
  const finalUpdateId = safePositiveInteger(row.u);
  const bids = parseL2Levels(row.b, MAX_LEVELS_PER_PAYLOAD);
  const asks = parseL2Levels(row.a, MAX_LEVELS_PER_PAYLOAD);
  if (!validSymbol(symbol) || firstUpdateId === undefined || finalUpdateId === undefined || firstUpdateId > finalUpdateId || !bids || !asks) return undefined;
  const previousFinalUpdateId = market === "perpetual" ? safeNonNegativeInteger(row.pu) : undefined;
  if (market === "perpetual" && previousFinalUpdateId === undefined) return undefined;
  const matchingEngineTime = market === "perpetual" ? safePositiveInteger(row.T) : undefined;
  const eventTime = safePositiveInteger(row.E);
  const exchangeTs = matchingEngineTime ?? eventTime;
  if (exchangeTs === undefined || !validReceiptTime(receivedAt)) return undefined;
  return {
    symbol,
    firstUpdateId,
    finalUpdateId,
    ...(previousFinalUpdateId === undefined ? {} : { previousFinalUpdateId }),
    bids,
    asks,
    exchangeTs,
    exchangeTimestampSource: matchingEngineTime === undefined ? "event-time" : "matching-engine-time",
    receivedAt
  };
}

export function parseBinanceDepthSnapshot(value: unknown, receivedAt = Date.now()): BinanceDepthSnapshot | undefined {
  const row = object(value);
  if (!row) return undefined;
  const lastUpdateId = safeNonNegativeInteger(row.lastUpdateId);
  const bids = parseL2Levels(row.bids, MAX_LEVELS_PER_PAYLOAD);
  const asks = parseL2Levels(row.asks, MAX_LEVELS_PER_PAYLOAD);
  if (lastUpdateId === undefined || !bids || !asks || !validReceiptTime(receivedAt) || bids.some((level) => level[1] === 0) || asks.some((level) => level[1] === 0)) return undefined;
  return { lastUpdateId, bids, asks, receivedAt };
}

/**
 * Binance Spot bridges with `lastUpdateId + 1` and then detects U > local+1.
 * USD-M Futures bridges a snapshot-covered event and then requires `pu === previous u`.
 */
export class BinanceDepthReconstructor {
  private readonly book: BoundedL2Book;
  private readonly publishLevels: number;
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedLevelUpdates: number;
  private buffered: BinanceDepthDelta[] = [];
  private bufferedLevelUpdates = 0;
  private sequence?: number;
  private ready = false;

  constructor(
    readonly market: ArbitrageMarket,
    readonly symbol: string,
    options: BinanceReconstructorOptions = {}
  ) {
    if (!validSymbol(symbol)) throw new Error("Invalid Binance L2 symbol");
    this.book = new BoundedL2Book(options.maxLevels);
    this.publishLevels = options.publishLevels ?? Math.min(200, this.book.maxLevels);
    if (!Number.isSafeInteger(this.publishLevels) || this.publishLevels < 1 || this.publishLevels > this.book.maxLevels) throw new Error("Invalid Binance publish depth");
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.maxBufferedLevelUpdates = options.maxBufferedLevelUpdates ?? DEFAULT_MAX_BUFFERED_LEVEL_UPDATES;
    if (!Number.isSafeInteger(this.maxBufferedEvents) || this.maxBufferedEvents < 1) throw new Error("Invalid Binance event buffer bound");
    if (!Number.isSafeInteger(this.maxBufferedLevelUpdates) || this.maxBufferedLevelUpdates < 1) throw new Error("Invalid Binance level buffer bound");
  }

  reset() {
    this.book.clear();
    this.buffered = [];
    this.bufferedLevelUpdates = 0;
    this.sequence = undefined;
    this.ready = false;
  }

  push(delta: BinanceDepthDelta): L2ReconstructionResult {
    if (delta.symbol !== this.symbol) return this.fail("Binance depth symbol changed inside one book stream");
    if (!this.ready && this.sequence !== undefined) {
      const result = this.applyBridge(delta);
      if (result.kind !== "retry-snapshot") return result;
      this.book.clear();
      this.sequence = undefined;
      if (!this.bufferWithoutResult(delta)) return this.fail("Binance depth bootstrap buffer exceeded its hard bound during snapshot retry");
      return result;
    }
    if (!this.ready) return this.buffer(delta);
    return this.applyLive(delta);
  }

  applySnapshot(snapshot: BinanceDepthSnapshot): L2ReconstructionResult {
    this.book.reset(snapshot.bids, snapshot.asks);
    this.sequence = snapshot.lastUpdateId;
    this.ready = false;
    const retained = this.buffered;
    this.buffered = [];
    this.bufferedLevelUpdates = 0;
    let latestReady: Extract<L2ReconstructionResult, { kind: "ready" }> | undefined;
    for (let index = 0; index < retained.length; index += 1) {
      const delta = retained[index] as BinanceDepthDelta;
      const result = this.ready ? this.applyLive(delta) : this.applyBridge(delta);
      if (result.kind === "gap") return result;
      if (result.kind === "ready") latestReady = result;
      if (result.kind === "retry-snapshot") {
        for (const pending of retained.slice(index)) {
          if (!this.bufferWithoutResult(pending)) return this.fail("Binance depth bootstrap buffer exceeded its hard bound during snapshot retry");
        }
        this.book.clear();
        this.sequence = undefined;
        return result;
      }
    }
    return latestReady ?? { kind: "buffered" };
  }

  isReady() {
    return this.ready;
  }

  bufferedEvents() {
    return this.buffered.length;
  }

  private buffer(delta: BinanceDepthDelta): L2ReconstructionResult {
    if (!this.bufferWithoutResult(delta)) return this.fail("Binance depth bootstrap buffer exceeded its hard bound");
    return { kind: "buffered" };
  }

  private bufferWithoutResult(delta: BinanceDepthDelta) {
    const levelUpdates = delta.bids.length + delta.asks.length;
    if (this.buffered.length >= this.maxBufferedEvents || this.bufferedLevelUpdates + levelUpdates > this.maxBufferedLevelUpdates) return false;
    this.buffered.push(delta);
    this.bufferedLevelUpdates += levelUpdates;
    return true;
  }

  private applyBridge(delta: BinanceDepthDelta): L2ReconstructionResult {
    const sequence = this.sequence;
    if (sequence === undefined) return this.fail("Binance depth snapshot sequence is absent");
    if (this.market === "spot") {
      if (delta.finalUpdateId <= sequence) return { kind: "ignored" };
      const target = sequence + 1;
      if (delta.firstUpdateId > target) return { kind: "retry-snapshot", reason: "Binance Spot REST snapshot is older than the first buffered delta" };
      if (delta.finalUpdateId < target) return { kind: "ignored" };
    } else {
      if (delta.finalUpdateId < sequence) return { kind: "ignored" };
      if (delta.firstUpdateId > sequence) return { kind: "retry-snapshot", reason: "Binance Futures REST snapshot is older than the first buffered delta" };
      if (delta.finalUpdateId < sequence) return { kind: "ignored" };
    }
    return this.applyAccepted(delta);
  }

  private applyLive(delta: BinanceDepthDelta): L2ReconstructionResult {
    const sequence = this.sequence;
    if (sequence === undefined) return this.fail("Binance live depth lost its sequence");
    if (delta.finalUpdateId <= sequence) return { kind: "ignored" };
    if (this.market === "spot") {
      if (delta.firstUpdateId > sequence + 1) return this.fail(`Binance Spot depth gap: expected update ${sequence + 1}, received ${delta.firstUpdateId}`);
      if (delta.finalUpdateId < sequence + 1) return { kind: "ignored" };
    } else if (delta.previousFinalUpdateId !== sequence) {
      return this.fail(`Binance Futures depth gap: expected pu ${sequence}, received ${delta.previousFinalUpdateId ?? "missing"}`);
    }
    return this.applyAccepted(delta);
  }

  private applyAccepted(delta: BinanceDepthDelta): L2ReconstructionResult {
    try {
      this.book.apply(delta.bids, delta.asks);
      this.sequence = delta.finalUpdateId;
      this.ready = true;
      return { kind: "ready", book: this.output(delta) };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Binance reconstructed depth is invalid");
    }
  }

  private output(delta: BinanceDepthDelta): SequenceVerifiedL2Book {
    const levels = this.book.snapshot(this.publishLevels);
    return {
      exchange: "binance",
      market: this.market,
      symbol: this.symbol,
      bids: levels.bids,
      asks: levels.asks,
      sequence: this.sequence as number,
      sequenceVerified: true,
      exchangeTs: delta.exchangeTs,
      exchangeTimestampSource: delta.exchangeTimestampSource,
      receivedAt: delta.receivedAt,
      source: "websocket-reconstructed",
      retainedDepth: this.book.maxLevels
    };
  }

  private fail(reason: string): L2ReconstructionResult {
    this.reset();
    return { kind: "gap", reason };
  }
}

function validSymbol(value: string) {
  return /^[A-Z0-9]{2,32}$/.test(value);
}

function safePositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeNonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function validReceiptTime(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
