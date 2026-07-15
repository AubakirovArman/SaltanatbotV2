import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { ArbitrageDepthService } from "../src/arbitrage/depth.js";
import { BinanceDepthReconstructor, parseBinanceDepthDelta, parseBinanceDepthSnapshot } from "../src/arbitrage/upstream/l2/binanceProtocol.js";
import { BoundedL2Book } from "../src/arbitrage/upstream/l2/boundedBook.js";
import { BybitDepthReconstructor, parseBybitDepthEvent } from "../src/arbitrage/upstream/l2/bybitProtocol.js";
import { SequenceVerifiedL2Feed } from "../src/arbitrage/upstream/l2/feed.js";
import { SequenceVerifiedL2Hub } from "../src/arbitrage/upstream/l2/hub.js";
import type { SequenceVerifiedL2Book, SequenceVerifiedL2Callbacks } from "../src/arbitrage/upstream/l2/types.js";

describe("sequence-verified arbitrage L2", () => {
  it("keeps absolute price maps bounded and rejects a crossed publication", () => {
    const book = new BoundedL2Book(2);
    book.reset(
      [
        [100, 1],
        [99, 2],
        [98, 3]
      ],
      [
        [101, 1],
        [102, 2],
        [103, 3]
      ]
    );
    expect(book.sizes()).toEqual({ bids: 2, asks: 2 });
    expect(book.snapshot()).toEqual({ bids: [[100, 1], [99, 2]], asks: [[101, 1], [102, 2]] });
    book.apply([[102, 1]], []);
    expect(() => book.snapshot()).toThrow(/crossed or locked/);
  });

  it("bridges Binance Spot at snapshot+1, applies overlaps and fails closed on a gap", () => {
    const reconstructor = new BinanceDepthReconstructor("spot", "BTCUSDT", { maxLevels: 10, publishLevels: 10 });
    expect(reconstructor.push(binanceDelta("spot", 101, 102, { bids: [[100, 2]], exchangeTs: 1_010 }))).toEqual({ kind: "buffered" });
    const snapshot = parseBinanceDepthSnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "2"]] }, 1_005);
    expect(snapshot).toBeDefined();
    const bridged = reconstructor.applySnapshot(snapshot!);
    expect(bridged).toMatchObject({ kind: "ready", book: { sequence: 102, sequenceVerified: true, exchangeTs: 1_010, bids: [[100, 2], [99, 1]] } });

    const overlapping = reconstructor.push(binanceDelta("spot", 102, 103, { asks: [[101, 0], [102, 4]], exchangeTs: 1_020 }));
    expect(overlapping).toMatchObject({ kind: "ready", book: { sequence: 103, asks: [[102, 4]] } });
    expect(reconstructor.push(binanceDelta("spot", 105, 105, { exchangeTs: 1_030 }))).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected update 104/) });
    expect(reconstructor.isReady()).toBe(false);
  });

  it("retains bounded Binance deltas while retrying an old REST snapshot", () => {
    const reconstructor = new BinanceDepthReconstructor("spot", "BTCUSDT", { maxBufferedEvents: 2 });
    reconstructor.push(binanceDelta("spot", 105, 105));
    expect(reconstructor.applySnapshot(parseBinanceDepthSnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "1"]] }, 1_000)!)).toMatchObject({ kind: "retry-snapshot" });
    expect(reconstructor.bufferedEvents()).toBe(1);
    expect(reconstructor.applySnapshot(parseBinanceDepthSnapshot({ lastUpdateId: 104, bids: [["99", "1"]], asks: [["101", "1"]] }, 1_001)!)).toMatchObject({ kind: "ready", book: { sequence: 105 } });

    const bounded = new BinanceDepthReconstructor("spot", "BTCUSDT", { maxBufferedEvents: 1 });
    expect(bounded.push(binanceDelta("spot", 1, 1))).toEqual({ kind: "buffered" });
    expect(bounded.push(binanceDelta("spot", 2, 2))).toMatchObject({ kind: "gap", reason: expect.stringMatching(/hard bound/) });
  });

  it("uses Binance USD-M pu chaining instead of the Spot successor rule", () => {
    const reconstructor = new BinanceDepthReconstructor("perpetual", "BTCUSDT", { maxLevels: 10 });
    const bridge = binanceDelta("perpetual", 99, 101, { previousFinalUpdateId: 98, exchangeTs: 1_010 });
    reconstructor.push(bridge);
    expect(reconstructor.applySnapshot(parseBinanceDepthSnapshot({ lastUpdateId: 100, bids: [["103", "1"]], asks: [["104", "1"]] }, 1_005)!)).toMatchObject({ kind: "ready", book: { sequence: 101 } });
    expect(reconstructor.push(binanceDelta("perpetual", 102, 103, { previousFinalUpdateId: 101, exchangeTs: 1_020 }))).toMatchObject({ kind: "ready", book: { sequence: 103 } });
    expect(reconstructor.push(binanceDelta("perpetual", 104, 104, { previousFinalUpdateId: 102, exchangeTs: 1_030 }))).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected pu 103/) });

    const spot = parseBinanceDepthDelta({ e: "depthUpdate", E: 10, s: "BTCUSDT", U: 1, u: 1, b: [], a: [] }, "spot", 20);
    const futuresWithoutPu = parseBinanceDepthDelta({ e: "depthUpdate", E: 10, T: 9, s: "BTCUSDT", U: 1, u: 1, b: [], a: [] }, "perpetual", 20);
    expect(spot).toMatchObject({ exchangeTimestampSource: "event-time", exchangeTs: 10 });
    expect(futuresWithoutPu).toBeUndefined();
    expect(parseBinanceDepthDelta({ e: "depthUpdate", E: 10, T: 9, s: "BTCUSDT", U: 1, u: 1, pu: 0, b: [], a: [] }, "perpetual", 20)).toMatchObject({ exchangeTimestampSource: "matching-engine-time", exchangeTs: 9 });
    expect(parseBinanceDepthDelta({ e: "depthUpdate", E: 10, T: 9, st: 2, s: "BTCUSDT", U: 1, u: 1, pu: 0, b: [], a: [] }, "perpetual", 20)).toBeUndefined();
  });

  it("resets Bybit from a new snapshot and rejects u or cross-sequence gaps", () => {
    const reconstructor = new BybitDepthReconstructor("spot", "BTCUSDT", { maxLevels: 10 });
    const snapshot = bybitEvent("snapshot", 10, 100, { bids: [[99, 2]], asks: [[101, 2]], cts: 990 });
    expect(reconstructor.push(snapshot)).toMatchObject({ kind: "ready", book: { sequence: 10, exchangeTs: 990, exchangeTimestampSource: "matching-engine-time" } });
    expect(reconstructor.push(bybitEvent("delta", 11, 105, { bids: [[100, 1]] }))).toMatchObject({ kind: "ready", book: { bids: [[100, 1], [99, 2]] } });
    expect(reconstructor.push(bybitEvent("delta", 13, 106))).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected u 12/) });
    expect(reconstructor.isReady()).toBe(false);
    expect(reconstructor.push(bybitEvent("snapshot", 1, 200, { bids: [[98, 1]], asks: [[102, 1]] }))).toMatchObject({ kind: "ready", book: { sequence: 1, bids: [[98, 1]] } });
    expect(reconstructor.push(bybitEvent("delta", 2, 199))).toMatchObject({ kind: "gap", reason: expect.stringMatching(/regressed/) });
  });

  it("buffers Binance socket deltas before REST and invalidates immediately on a live gap", async () => {
    let socket: FakeSocket | undefined;
    let resolveSnapshot: ((response: Response) => void) | undefined;
    const books: SequenceVerifiedL2Book[] = [];
    const invalidations: string[] = [];
    const feed = new SequenceVerifiedL2Feed(
      "binance",
      "spot",
      "BTCUSDT",
      { onBook: (book) => books.push(book), onInvalidate: (reason) => invalidations.push(reason), onStatus: () => undefined },
      {
        createSocket: () => {
          socket = new FakeSocket();
          return socket as unknown as WebSocket;
        },
        fetch: async () => await new Promise<Response>((resolve) => { resolveSnapshot = resolve; }),
        now: (() => {
          let now = 1_000;
          return () => ++now;
        })(),
        random: () => 0
      }
    );
    feed.start();
    socket?.emit("open");
    socket?.emit("message", Buffer.from(JSON.stringify({ e: "depthUpdate", E: 995, s: "BTCUSDT", U: 101, u: 101, b: [["100", "2"]], a: [] })));
    resolveSnapshot?.(json({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["101", "2"]] }));
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(books[0]).toMatchObject({ source: "websocket-reconstructed", sequenceVerified: true, sequence: 101 });

    socket?.emit("message", Buffer.from(JSON.stringify({ e: "depthUpdate", E: 997, s: "BTCUSDT", U: 103, u: 103, b: [], a: [] })));
    expect(invalidations.some((reason) => /expected update 102/.test(reason))).toBe(true);
    expect(socket?.terminated).toBe(true);
    feed.close();
  });

  it("shares one bounded feed and withdraws cached books after invalidation", async () => {
    let callbacks: SequenceVerifiedL2Callbacks | undefined;
    let starts = 0;
    let closes = 0;
    const hub = new SequenceVerifiedL2Hub({
      feedFactory: (_exchange, _market, _symbol, next) => {
        callbacks = next;
        return { start: () => { starts += 1; }, close: () => { closes += 1; } };
      },
      now: () => 1_000,
      waitTimeoutMs: 1_000,
      idleTtlMs: 1_000
    });
    const first = hub.getBook("binance", "spot", "BTCUSDT");
    const second = hub.getBook("binance", "spot", "BTCUSDT");
    expect(starts).toBe(1);
    callbacks?.onBook(sequenceBook("binance", "spot", 1));
    const firstBook = await first;
    expect(firstBook).toMatchObject({ sequence: 1 });
    expect(hub.isCurrent(firstBook)).toBe(true);
    await expect(second).resolves.toMatchObject({ sequence: 1 });
    callbacks?.onInvalidate("gap");
    expect(hub.isCurrent(firstBook)).toBe(false);
    const controller = new AbortController();
    const unavailable = hub.getBook("binance", "spot", "BTCUSDT", controller.signal);
    controller.abort();
    await expect(unavailable).rejects.toMatchObject({ name: "AbortError" });
    hub.close();
    expect(closes).toBe(1);
  });

  it("fails closed immediately when a venue rejects the depth subscription", () => {
    let socket: FakeSocket | undefined;
    const invalidations: string[] = [];
    const feed = new SequenceVerifiedL2Feed(
      "bybit",
      "spot",
      "BTCUSDT",
      { onBook: () => undefined, onInvalidate: (reason) => invalidations.push(reason), onStatus: () => undefined },
      {
        createSocket: () => {
          socket = new FakeSocket();
          return socket as unknown as WebSocket;
        },
        random: () => 0
      }
    );
    feed.start();
    socket?.emit("open");
    socket?.emit("message", Buffer.from(JSON.stringify({ success: false, op: "subscribe", ret_msg: "topic rejected" })));
    expect(socket?.terminated).toBe(true);
    expect(invalidations.some((reason) => /topic rejected/.test(reason))).toBe(true);
    feed.close();
  });

  it("rejects a distinct book when every bounded hub slot has an active waiter", async () => {
    const controller = new AbortController();
    const hub = new SequenceVerifiedL2Hub({
      maxBooks: 1,
      waitTimeoutMs: 1_000,
      feedFactory: () => ({ start: () => undefined, close: () => undefined })
    });
    const first = hub.getBook("binance", "spot", "BTCUSDT", controller.signal);
    await expect(hub.getBook("binance", "spot", "ETHUSDT")).rejects.toThrow(/stream limit reached/);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    hub.close();
  });

  it("lets only two reconstructed books satisfy depth completeness", async () => {
    const registry = depthRegistry();
    const live = new ArbitrageDepthService({
      now: () => 1_000,
      registry,
      fetch: async () => { throw new Error("REST must not be used"); },
      sequenceBooks: {
        getBook: async (exchange, market) => sequenceBook(exchange, market, market === "spot" ? 10 : 20),
        isCurrent: () => true
      }
    });
    await expect(live.analyze({ symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", notionalUsd: 100 })).resolves.toMatchObject({
      complete: true,
      timing: {
        quality: "fresh",
        sequenceContinuityVerified: true,
        spot: { source: "websocket-reconstructed", sequenceVerified: true, sequence: 10 },
        perpetual: { source: "websocket-reconstructed", sequenceVerified: true, sequence: 20 }
      }
    });

    const rest = new ArbitrageDepthService({
      now: () => 1_000,
      registry,
      sequenceBooks: { getBook: async () => { throw new Error("not synchronized"); }, isCurrent: () => false },
      fetch: async (input) => String(input).includes("category=linear")
        ? json({ retCode: 0, result: { b: [["103", "2"]], a: [["104", "2"]], ts: 1_000, seq: 20 } })
        : json({ E: 1_000, lastUpdateId: 10, bids: [["99", "2"]], asks: [["100", "2"]] })
    });
    await expect(rest.analyze({ symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", notionalUsd: 100 })).resolves.toMatchObject({
      complete: false,
      timing: { quality: "unverified", sequenceContinuityVerified: false, spot: { source: "rest-snapshot", sequenceVerified: false }, perpetual: { source: "rest-snapshot", sequenceVerified: false } }
    });
  });

  it("rejects a reconstructed-book lease invalidated during two-leg analysis", async () => {
    const service = new ArbitrageDepthService({
      now: () => 1_000,
      registry: depthRegistry(),
      fetch: async () => { throw new Error("REST must not be used after a successful strict-book read"); },
      sequenceBooks: {
        getBook: async (exchange, market) => sequenceBook(exchange, market, market === "spot" ? 10 : 20),
        isCurrent: () => false
      }
    });
    await expect(service.analyze({ symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", notionalUsd: 100 })).rejects.toThrow(/invalidated while depth analysis/);
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.terminated = true; this.close(); }
}

function binanceDelta(market: "spot" | "perpetual", firstUpdateId: number, finalUpdateId: number, overrides: { previousFinalUpdateId?: number; bids?: Array<[number, number]>; asks?: Array<[number, number]>; exchangeTs?: number } = {}) {
  return {
    symbol: "BTCUSDT",
    firstUpdateId,
    finalUpdateId,
    ...(market === "perpetual" ? { previousFinalUpdateId: overrides.previousFinalUpdateId ?? firstUpdateId - 1 } : {}),
    bids: overrides.bids ?? [],
    asks: overrides.asks ?? [],
    exchangeTs: overrides.exchangeTs ?? 1_000,
    exchangeTimestampSource: market === "perpetual" ? "matching-engine-time" as const : "event-time" as const,
    receivedAt: (overrides.exchangeTs ?? 1_000) + 1
  };
}

function bybitEvent(type: "snapshot" | "delta", updateId: number, crossSequence: number, overrides: { bids?: Array<[number, number]>; asks?: Array<[number, number]>; cts?: number } = {}) {
  return parseBybitDepthEvent({
    topic: "orderbook.200.BTCUSDT",
    type,
    ts: 1_000,
    ...(overrides.cts === undefined ? {} : { cts: overrides.cts }),
    data: { s: "BTCUSDT", u: updateId, seq: crossSequence, b: overrides.bids ?? [], a: overrides.asks ?? [] }
  }, 1_001)!;
}

function sequenceBook(exchange: "binance" | "bybit", market: "spot" | "perpetual", sequence: number): SequenceVerifiedL2Book {
  return {
    exchange,
    market,
    symbol: "BTCUSDT",
    bids: [[market === "spot" ? 99 : 103, 2]],
    asks: [[market === "spot" ? 100 : 104, 2]],
    sequence,
    sequenceVerified: true,
    exchangeTs: 1_000,
    exchangeTimestampSource: "event-time",
    receivedAt: 1_000,
    source: "websocket-reconstructed",
    retainedDepth: 200,
    connectionGeneration: 1
  };
}

function depthRegistry() {
  const rows = [instrument("binance", "spot"), instrument("bybit", "perpetual")];
  return { get: async (venue: string, marketType: string, symbol: string) => rows.find((row) => row.venue === venue && row.marketType === marketType && row.venueSymbol === symbol) };
}

function instrument(venue: "binance" | "bybit", marketType: "spot" | "perpetual"): RegistryInstrument {
  return {
    id: `${venue}:${marketType}:BTCUSDT`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.01,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading"
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
