import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuousPublicFeed } from "../src/arbitrage/upstream/publicFeeds/feed.js";
import { MexcFuturesContinuousProtocol, MexcSpotContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/mexcProtocol.js";
import { createContinuousVenueProtocol } from "../src/arbitrage/upstream/publicFeeds/protocolFactory.js";
import { PUBLIC_STREAM_SOURCES } from "../src/arbitrage/upstream/publicFeeds/process.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";
import { CONTINUOUS_PUBLIC_VENUES } from "../src/arbitrage/upstream/publicFeeds/types.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/governor.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";

const NOW = 1_784_023_200_500;
const SPOT_DELTA = fixture("spot-protobuf-delta.json");
const FUTURES_DELTA = fixture("futures-book-delta.json");

afterEach(() => vi.useRealTimers());

describe("MEXC continuous public protocols", () => {
  it("routes Spot binary bytes through an injectable generated/explicit decoder and bridges REST exactly", () => {
    const decode = vi.fn(() => structuredClone(SPOT_DELTA) as any);
    const protocol = new MexcSpotContinuousProtocol(spotInstrument(), { mexcSpotDecoder: { decode }, maxLevels: 100, publishLevels: 2 });
    const socket = new FakeSocket();

    protocol.subscribe(socket as unknown as WebSocket);
    protocol.heartbeat(socket as unknown as WebSocket);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { method: "SUBSCRIPTION", params: ["spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT"] },
      { method: "PING" }
    ]);

    const bytes = Uint8Array.of(0, 255, 7);
    expect(protocol.decodeBinary(bytes)).toEqual(SPOT_DELTA);
    expect(decode).toHaveBeenCalledWith(bytes);
    expect(protocol.push(protocol.decodeBinary(bytes), NOW + 10)).toEqual({ kind: "bootstrap-required" });
    expect(protocol.applyBootstrap(spotSnapshot(1_000))).toMatchObject({
      kind: "book",
      book: {
        venue: "mexc",
        receivedAt: NOW + 10,
        bids: [
          [100, 2],
          [99, 4]
        ],
        asks: [
          [101.5, 3],
          [102, 3]
        ],
        continuity: { kind: "sequence-verified", sequence: 1_003, protocol: "mexc-spot-version" },
        retainedDepth: 100
      }
    });
    expect(protocol.push({ id: 0, code: 0, msg: "PONG" }, NOW + 20)).toEqual({ kind: "heartbeat" });
    expect(protocol.push({ id: 0, code: 0, msg: "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT" }, NOW + 21)).toEqual({ kind: "accepted" });
  });

  it("fails Spot closed on a version gap, decoder frame cap and changed acknowledgement scope", () => {
    const protocol = new MexcSpotContinuousProtocol(spotInstrument(), { mexcSpotMaxFrameBytes: 256 });
    protocol.applyBootstrap(spotSnapshot(1_000));
    const gap = structuredClone(SPOT_DELTA) as any;
    gap.publicAggreDepths.fromVersion = "1005";
    gap.publicAggreDepths.toVersion = "1005";
    expect(protocol.push(gap, NOW + 1)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/version gap/) });
    expect(() => protocol.decodeBinary(new Uint8Array(257))).toThrow(/exceeds 256 bytes/);
    expect(protocol.push({ id: 0, code: 0, msg: "different-topic" }, NOW + 2)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/changed scope/) });
  });

  it("buffers Futures deltas until REST and then requires strict version + 1", () => {
    const protocol = new MexcFuturesContinuousProtocol(futuresInstrument(), { maxLevels: 100, publishLevels: 2 });
    const socket = new FakeSocket();
    protocol.subscribe(socket as unknown as WebSocket);
    protocol.heartbeat(socket as unknown as WebSocket);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { method: "sub.depth", param: { symbol: "BTC_USDT", compress: false } },
      { method: "ping" }
    ]);
    expect(protocol.push({ channel: "rs.sub.depth", data: "success" }, NOW)).toEqual({ kind: "accepted" });
    expect(protocol.push(FUTURES_DELTA, NOW + 10)).toEqual({ kind: "bootstrap-required" });
    expect(protocol.applyBootstrap(futuresSnapshot(500))).toMatchObject({
      kind: "book",
      book: {
        receivedAt: NOW + 10,
        continuity: { kind: "sequence-verified", sequence: 501, protocol: "mexc-futures-version" },
        quantityUnit: "contract",
        retainedDepth: 100
      }
    });

    const next = structuredClone(FUTURES_DELTA) as any;
    next.data.version = 502;
    next.ts = NOW + 20;
    expect(protocol.push(next, NOW + 21)).toMatchObject({ kind: "book", book: { continuity: { sequence: 502 } } });
    next.data.version = 504;
    expect(protocol.push(next, NOW + 22)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected 503/) });

    const noDelta = new MexcFuturesContinuousProtocol(futuresInstrument());
    expect(noDelta.applyBootstrap(futuresSnapshot(500))).toEqual({ kind: "accepted" });
    expect(noDelta.push(FUTURES_DELTA, NOW + 30)).toMatchObject({ kind: "book", book: { continuity: { sequence: 501 } } });
  });

  it("coalesces Futures materialization without skipping native version gates", () => {
    const protocol = new MexcFuturesContinuousProtocol(futuresInstrument(), { maxLevels: 100, publishLevels: 2, publishIntervalMs: 100 });
    expect(protocol.push(FUTURES_DELTA, NOW + 10)).toEqual({ kind: "bootstrap-required" });
    expect(protocol.applyBootstrap(futuresSnapshot(500))).toMatchObject({ kind: "book", book: { continuity: { sequence: 501 } } });

    const version502 = structuredClone(FUTURES_DELTA) as any;
    version502.data.version = 502;
    version502.data.bids = [[100, 20, 3]];
    version502.ts = NOW + 20;
    expect(protocol.push(version502, NOW + 20)).toEqual({ kind: "book-advanced" });

    const version503 = structuredClone(version502);
    version503.data.version = 503;
    version503.data.bids = [[100, 25, 3]];
    version503.ts = NOW + 110;
    expect(protocol.push(version503, NOW + 110)).toMatchObject({
      kind: "book",
      book: { bids: [[100, 25], [99, 40]], continuity: { sequence: 503 } }
    });

    const missing504 = structuredClone(version503);
    missing504.data.version = 505;
    expect(protocol.push(missing504, NOW + 111)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected 504/) });
  });

  it("bounds Futures pre-snapshot events and registers exact Spot/perpetual factories", () => {
    const bounded = new MexcFuturesContinuousProtocol(futuresInstrument(), { maxBufferedEvents: 1, maxBufferedLevelUpdates: 10 });
    expect(bounded.push(FUTURES_DELTA, NOW)).toEqual({ kind: "bootstrap-required" });
    expect(bounded.push(FUTURES_DELTA, NOW + 1)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/hard bound/) });

    expect(createContinuousVenueProtocol(spotInstrument())).toBeInstanceOf(MexcSpotContinuousProtocol);
    expect(createContinuousVenueProtocol(futuresInstrument())).toBeInstanceOf(MexcFuturesContinuousProtocol);
    expect(CONTINUOUS_PUBLIC_VENUES).toContain("mexc");
    expect(PUBLIC_STREAM_SOURCES.mexc).toBe("mexc.public-websocket");
    expect(() => new MexcSpotContinuousProtocol({ ...spotInstrument(), quantityUnit: "contract" })).toThrow(/base-unit/);
    expect(() => new MexcFuturesContinuousProtocol({ ...futuresInstrument(), marketType: "future" })).toThrow(/perpetual/);
  });

  it("defers REST until the first depth delta, single-flights buffering and ignores stale reconnect bootstraps", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const invalidations: string[] = [];
    const pending: Array<{ resolve(value: ReturnType<typeof spotSnapshot>): void; signal: AbortSignal | undefined }> = [];
    const depth = vi.fn(async (_request, signal?: AbortSignal) => {
      return await new Promise<ReturnType<typeof spotSnapshot>>((resolve) => {
        pending.push({ resolve, signal });
      });
    });
    const next = structuredClone(SPOT_DELTA) as any;
    next.publicAggreDepths.fromVersion = "1004";
    next.publicAggreDepths.toVersion = "1004";
    next.publicAggreDepths.asks = [];
    next.publicAggreDepths.bids = [{ price: "100", quantity: "2.5" }];
    next.sendTime = NOW + 20;
    const decode = vi.fn((frame: Uint8Array) => structuredClone(frame[0] === 2 ? next : SPOT_DELTA));
    const feed = new ContinuousPublicFeed(spotInstrument(), callbacks(books, invalidations), {
      adapter: fakeAdapter(depth),
      governor: governor("mexc.public-websocket"),
      restGovernor: governor("mexc.public-rest"),
      createSocket: () => fakeSocket(sockets),
      mexcSpotDecoder: { decode },
      now: () => NOW,
      random: () => 0,
      heartbeatMs: 1_000,
      messageTimeoutMs: 5_000
    });

    feed.start();
    sockets[0]!.open();
    sockets[0]!.text({ id: 0, code: 0, msg: "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT" });
    expect(depth).not.toHaveBeenCalled();

    sockets[0]!.binary(Uint8Array.of(1));
    expect(depth).toHaveBeenCalledTimes(1);
    expect(books).toHaveLength(0);
    sockets[0]!.binary(Uint8Array.of(2));
    expect(depth).toHaveBeenCalledTimes(1);
    expect(books).toHaveLength(0);
    pending[0]!.resolve(spotSnapshot(1_000));
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(books[0]!.continuity).toMatchObject({ sequence: 1_004, protocol: "mexc-spot-version" });
    const firstGeneration = books[0]!.connectionGeneration;

    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.text({ id: 0, code: 0, msg: "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT" });
    expect(depth).toHaveBeenCalledTimes(1);
    sockets[1]!.binary(Uint8Array.of(1));
    expect(depth).toHaveBeenCalledTimes(2);
    expect(pending[1]!.signal?.aborted).toBe(false);
    sockets[1]!.close();
    expect(pending[1]!.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(800);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    sockets[2]!.binary(Uint8Array.of(1));
    expect(depth).toHaveBeenCalledTimes(3);
    pending[1]!.resolve(spotSnapshot(1_000));
    await Promise.resolve();
    await Promise.resolve();
    expect(books).toHaveLength(1);
    pending[2]!.resolve(spotSnapshot(1_000));
    await vi.waitFor(() => expect(books).toHaveLength(2));
    expect(books[1]!.connectionGeneration).toBeGreaterThan(firstGeneration);
    sockets[1]!.binary(Uint8Array.of(9));
    expect(decode).toHaveBeenCalledTimes(4);
    expect(invalidations.some((value) => /socket closed/.test(value))).toBe(true);
    feed.close();
  });
});

class FakeSocket extends EventEmitter {
  readyState = 0;
  terminated = false;
  sent: string[] = [];

  send(value: string) {
    this.sent.push(String(value));
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  binary(value: Uint8Array) {
    this.emit("message", Buffer.from(value), true);
  }

  text(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.close();
  }
}

function fakeSocket(values: FakeSocket[]) {
  const socket = new FakeSocket();
  values.push(socket);
  return socket as unknown as WebSocket;
}

function spotInstrument(): ContinuousFeedInstrument {
  return { venue: "mexc", instrumentId: "mexc:spot:BTCUSDT", venueSymbol: "BTCUSDT", marketType: "spot", quantityUnit: "base" };
}

function futuresInstrument(): ContinuousFeedInstrument {
  return { venue: "mexc", instrumentId: "mexc:perpetual:BTC_USDT", venueSymbol: "BTC_USDT", marketType: "perpetual", quantityUnit: "contract" };
}

function spotSnapshot(sequence: number) {
  return {
    venue: "mexc",
    instrumentId: "BTCUSDT",
    marketType: "spot" as const,
    quantityUnit: "base" as const,
    bids: [
      [100, 1],
      [99, 4]
    ] as const,
    asks: [
      [101, 2],
      [102, 3]
    ] as const,
    sequence,
    exchangeTs: NOW,
    receivedAt: NOW,
    complete: true as const
  };
}

function futuresSnapshot(sequence: number) {
  return {
    venue: "mexc",
    instrumentId: "BTC_USDT",
    marketType: "perpetual" as const,
    quantityUnit: "contract" as const,
    bids: [
      [100, 10, 2],
      [99, 40, 3]
    ] as const,
    asks: [
      [101, 20, 2],
      [102, 30, 1]
    ] as const,
    sequence,
    exchangeTs: NOW,
    receivedAt: NOW,
    complete: true as const
  };
}

function fakeAdapter(depth: PublicVenueAdapter["depth"]): PublicVenueAdapter {
  return {
    venue: "mexc",
    capabilities: () => ({ venue: "mexc", publicData: true, spot: true, margin: false, perpetual: true, datedFuture: false, option: false, nativeSpread: false, topBook: true, depth: true, publicTrades: false, funding: true, borrow: false, depositWithdrawal: false, privateExecution: false, demoEnvironment: false }),
    instruments: vi.fn(),
    tickers: vi.fn(),
    ticker: vi.fn(),
    depth,
    funding: vi.fn()
  };
}

function governor(source: string) {
  return new UpstreamResourceGovernor({ [source]: { maxConcurrent: 2, failureThreshold: 2, cooldownMs: 1_000 } }, () => NOW);
}

function callbacks(books: ContinuousPublicBook[], invalidations: string[]): ContinuousFeedCallbacks {
  return {
    onBook: (book) => books.push(book),
    onTopBook: () => undefined,
    onFunding: () => undefined,
    onInvalidate: (reason) => invalidations.push(reason),
    onStatus: () => undefined
  };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/mexc/${name}`, import.meta.url), "utf8"));
}
