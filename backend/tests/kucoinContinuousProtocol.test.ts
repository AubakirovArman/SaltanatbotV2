import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairwiseBookFromContinuous } from "../src/arbitrage/upstream/publicFeeds/discovery.js";
import { ContinuousPublicFeed } from "../src/arbitrage/upstream/publicFeeds/feed.js";
import { KucoinContinuousProtocol, parseKucoinPublicJson } from "../src/arbitrage/upstream/publicFeeds/kucoinProtocol.js";
import { PUBLIC_STREAM_SOURCES } from "../src/arbitrage/upstream/publicFeeds/process.js";
import { createContinuousVenueProtocol } from "../src/arbitrage/upstream/publicFeeds/protocolFactory.js";
import { CONTINUOUS_PUBLIC_VENUES, type ContinuousFeedCallbacks, type ContinuousFeedInstrument, type ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/governor.js";

const RECEIVED_AT = 1_784_023_200_500;
const SNAPSHOT = fixture("obu-snapshot.json");
const DELTA = fixture("obu-delta.json");

afterEach(() => vi.useRealTimers());

describe("KuCoin continuous public protocol", () => {
  it("waits for the public welcome, then subscribes only to post-retirement Increment Best 500", () => {
    const protocol = new KucoinContinuousProtocol(instrument("BTC-USDT", "spot", "base"));
    const socket = new FakeSocket();

    expect(protocol.url).toBe("wss://x-push-spot.kucoin.com");
    protocol.subscribe(socket as unknown as WebSocket, RECEIVED_AT);
    expect(socket.sent).toEqual([]);
    expect(protocol.push(welcome(), RECEIVED_AT)).toEqual({ kind: "accepted" });
    expect(socket.sent).toEqual([
      '{"id":"saltanat-public-book","action":"SUBSCRIBE","channel":"obu","tradeType":"SPOT","symbol":"BTC-USDT","depth":"increment@10ms","rpiFilter":0}'
    ]);
    expect(socket.sent.join(" ")).not.toMatch(/api.?key|secret|signature|"depth":"increment"/i);
    expect(protocol.push({ id: "saltanat-public-book", result: true }, RECEIVED_AT + 1)).toEqual({ kind: "accepted" });

    protocol.heartbeat(socket as unknown as WebSocket, RECEIVED_AT + 2);
    expect(socket.sent.at(-1)).toBe('{"id":"saltanat-public-ping","type":"ping"}');
    expect(protocol.push({ id: "saltanat-public-ping", type: "pong", ts: "1784023200000000000" }, RECEIVED_AT + 3)).toEqual({ kind: "heartbeat" });
  });

  it("publishes only a self-seeded snapshot/range proof and applies overlapping absolute deltas", () => {
    const protocol = readyProtocol(instrument("BTC-USDT", "spot", "base"));
    const seeded = protocol.push(SNAPSHOT, RECEIVED_AT);
    expect(seeded).toMatchObject({
      kind: "book",
      book: {
        venue: "kucoin",
        bids: [
          [100, 1],
          [99, 4]
        ],
        asks: [
          [101, 2],
          [102, 3]
        ],
        continuity: { kind: "sequence-verified", sequence: 1_000, protocol: "kucoin-obu-range" },
        retainedDepth: 500
      }
    });
    const updated = protocol.push(DELTA, RECEIVED_AT + 10);
    expect(updated).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100, 1.5],
          [99, 4]
        ],
        asks: [
          [101.5, 5],
          [102, 3]
        ],
        continuity: { sequence: 1_003 }
      }
    });
    expect(protocol.push(DELTA, RECEIVED_AT + 20)).toEqual({ kind: "ignored" });
    if (updated.kind !== "book") throw new Error("expected KuCoin sequence-verified book");
    expect(pairwiseBookFromContinuous({ ...updated.book, connectionGeneration: 4 }, RECEIVED_AT + 10, 10_000)).toMatchObject({
      sequence: 1_003,
      sourceId: "kucoin:public-websocket:kucoin-obu-range:generation-4"
    });
  });

  it("coalesces materialization while checking every sequence and publishing the latest state", () => {
    const protocol = readyProtocol(instrument("BTC-USDT", "spot", "base"), { publishIntervalMs: 100 });
    expect(protocol.push(SNAPSHOT, RECEIVED_AT)).toMatchObject({ kind: "book", book: { continuity: { sequence: 1_000 } } });
    expect(protocol.push(DELTA, RECEIVED_AT + 10)).toEqual({ kind: "book-advanced" });

    const next = structuredClone(DELTA) as any;
    next.d.O = "1004";
    next.d.C = "1004";
    next.d.M = "1784023200100000000";
    next.d.a = [];
    next.d.b = [["100", "2"]];
    expect(protocol.push(next, RECEIVED_AT + 100)).toMatchObject({
      kind: "book",
      book: { bids: [[100, 2], [99, 4]], continuity: { sequence: 1_004 } }
    });

    const gapped = readyProtocol(instrument("BTC-USDT", "spot", "base"), { publishIntervalMs: 100 });
    expect(gapped.push(SNAPSHOT, RECEIVED_AT)).toMatchObject({ kind: "book" });
    const missing = structuredClone(DELTA) as any;
    missing.d.O = "1005";
    missing.d.C = "1005";
    expect(gapped.push(missing, RECEIVED_AT + 10)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/sequence gap/) });
  });

  it("fails closed on gaps, replacement snapshots, retired mode, time regression and unsafe sequence input", () => {
    const beforeSnapshot = readyProtocol(instrument("BTC-USDT", "spot", "base"));
    expect(beforeSnapshot.push(DELTA, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/before an increment@10ms snapshot/) });

    const replacement = readyProtocol(instrument("BTC-USDT", "spot", "base"));
    expect(replacement.push(SNAPSHOT, RECEIVED_AT)).toMatchObject({ kind: "book" });
    expect(replacement.push(SNAPSHOT, RECEIVED_AT + 1)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/replacement snapshot/) });

    const retired = structuredClone(SNAPSHOT) as any;
    retired.dp = "increment";
    expect(readyProtocol(instrument("BTC-USDT", "spot", "base")).push(retired, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/retired increment mode/) });

    const regressed = structuredClone(DELTA) as any;
    regressed.d.M = "1784023199999000000";
    const regressedProtocol = readyProtocol(instrument("BTC-USDT", "spot", "base"));
    regressedProtocol.push(SNAPSHOT, RECEIVED_AT);
    expect(regressedProtocol.push(regressed, RECEIVED_AT + 1)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/timestamp regressed/) });

    const unsafe = structuredClone(SNAPSHOT) as any;
    unsafe.d.O = Number.MAX_SAFE_INTEGER + 1;
    unsafe.d.C = Number.MAX_SAFE_INTEGER + 1;
    expect(readyProtocol(instrument("BTC-USDT", "spot", "base")).push(unsafe, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/safe integer or an exact decimal string/) });

    const exactButUnsupported = structuredClone(SNAPSHOT) as any;
    exactButUnsupported.d.O = "9007199254740992";
    exactButUnsupported.d.C = "9007199254740992";
    expect(readyProtocol(instrument("BTC-USDT", "spot", "base")).push(exactButUnsupported, RECEIVED_AT)).toMatchObject({
      kind: "gap",
      reason: expect.stringMatching(/positive safe sequence proof/)
    });
  });

  it("preserves native integer lexemes before exact sequence and nanosecond parsing", () => {
    const raw = '{"T":"obu.FUTURES","dp":"increment@10ms","t":"delta","P":1781666796660937177,"d":{"a":[],"b":[["65739","14"]],"C":1743938538056,"s":"XBTUSDTM","M":1781666796658000000,"O":1743938538050}}';
    const parsed = parseKucoinPublicJson(raw) as any;
    expect(parsed.P).toBe("1781666796660937177");
    expect(parsed.d).toMatchObject({ O: "1743938538050", C: "1743938538056", M: "1781666796658000000" });
    expect(new KucoinContinuousProtocol(instrument("BTC-USDT", "spot", "base")).decodeBinary(new TextEncoder().encode(raw))).toEqual(parsed);
    expect(() => parseKucoinPublicJson(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(/message size is invalid/);
  });

  it("routes KuCoin binary-marked JSON through the shared feed without lossy UTF-8 replacement", () => {
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const invalidations: string[] = [];
    const feed = new ContinuousPublicFeed(instrument("BTC-USDT", "spot", "base"), callbacks(books, invalidations), {
      governor: governor(),
      createSocket: () => socket(sockets),
      now: () => RECEIVED_AT,
      publishIntervalMs: 0
    });

    feed.start();
    sockets[0]!.open();
    sockets[0]!.binary(welcome());
    sockets[0]!.binary({ id: "saltanat-public-book", result: true });
    sockets[0]!.binary(SNAPSHOT);
    sockets[0]!.binary(DELTA);

    expect(books).toHaveLength(2);
    expect(books[1]).toMatchObject({ continuity: { protocol: "kucoin-obu-range", sequence: 1_003 }, connectionGeneration: 1 });
    expect(invalidations.some((reason) => /Unexpected binary frame/.test(reason))).toBe(false);
    feed.close();
  });

  it("fails binary KuCoin JSON closed on malformed UTF-8 and the hard frame cap", () => {
    const protocol = new KucoinContinuousProtocol(instrument("BTC-USDT", "spot", "base"));
    expect(() => protocol.decodeBinary(Uint8Array.of(0xc3, 0x28))).toThrow(/not valid UTF-8/);
    expect(() => protocol.decodeBinary(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow(/between 1 and 2097152 bytes/);

    const sockets: FakeSocket[] = [];
    const invalidations: string[] = [];
    const feed = new ContinuousPublicFeed(instrument("BTC-USDT", "spot", "base"), callbacks([], invalidations), {
      governor: governor(),
      createSocket: () => socket(sockets),
      now: () => RECEIVED_AT
    });
    feed.start();
    sockets[0]!.open();
    sockets[0]!.binaryBytes(Uint8Array.of(0xc3, 0x28));
    expect(sockets[0]!.terminated).toBe(true);
    expect(invalidations.some((reason) => /Malformed binary.*not valid UTF-8/.test(reason))).toBe(true);
    feed.close();
  });

  it("registers Spot/Futures endpoints and bounded process admission without implying private execution", () => {
    expect(CONTINUOUS_PUBLIC_VENUES).toContain("kucoin");
    expect(PUBLIC_STREAM_SOURCES.kucoin).toBe("kucoin.public-websocket");
    expect(createContinuousVenueProtocol(instrument("BTC-USDT", "spot", "base"))).toBeInstanceOf(KucoinContinuousProtocol);
    expect(createContinuousVenueProtocol(instrument("XBTUSDTM", "perpetual", "contract"))).toMatchObject({ url: "wss://x-push-futures.kucoin.com", needsBootstrap: false });
    expect(() => new KucoinContinuousProtocol({ ...instrument("BTC-USDT", "spot", "base"), quantityUnit: "contract" })).toThrow(/base-unit Spot/);
    expect(() => new KucoinContinuousProtocol(instrument("BTC-USDT", "spot", "base"), { maxLevels: 501 })).toThrow(/between 1 and 500/);
    expect(() => new KucoinContinuousProtocol(instrument("BTC-USDT", "spot", "base"), { maxLevels: 2, publishLevels: 3 })).toThrow(/between 1 and 2/);
  });

  it("withdraws a gapped connection generation and requires a new welcome plus snapshot", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const invalidations: string[] = [];
    const feed = new ContinuousPublicFeed(instrument("BTC-USDT", "spot", "base"), callbacks(books, invalidations), {
      governor: governor(),
      createSocket: () => socket(sockets),
      now: () => RECEIVED_AT,
      random: () => 0,
      heartbeatMs: 1_000,
      messageTimeoutMs: 5_000
    });

    feed.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.message(welcome());
    sockets[0]!.message({ id: "saltanat-public-book", result: true });
    sockets[0]!.message(SNAPSHOT);
    expect(books).toHaveLength(1);
    const firstGeneration = books[0]!.connectionGeneration;

    const gap = structuredClone(DELTA) as any;
    gap.d.O = "1005";
    gap.d.C = "1006";
    sockets[0]!.message(gap);
    expect(sockets[0]!.terminated).toBe(true);
    expect(invalidations.some((reason) => /sequence gap/.test(reason))).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message(welcome("generation-2"));
    sockets[1]!.message({ id: "saltanat-public-book", result: true });
    sockets[1]!.message(SNAPSHOT);
    expect(books).toHaveLength(2);
    expect(books[1]!.connectionGeneration).toBeGreaterThan(firstGeneration);
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

  ping() {
    this.sent.push("<transport-ping>");
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  binary(value: unknown) {
    this.binaryBytes(Buffer.from(JSON.stringify(value)));
  }

  binaryBytes(value: Uint8Array) {
    this.emit("message", Buffer.from(value), true);
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

function readyProtocol(value: ContinuousFeedInstrument, options: { publishIntervalMs?: number } = {}) {
  const protocol = new KucoinContinuousProtocol(value, options);
  const socket = new FakeSocket();
  protocol.subscribe(socket as unknown as WebSocket, RECEIVED_AT);
  expect(protocol.push(welcome(), RECEIVED_AT)).toEqual({ kind: "accepted" });
  expect(protocol.push({ id: "saltanat-public-book", result: true }, RECEIVED_AT + 1)).toEqual({ kind: "accepted" });
  return protocol;
}

function instrument(venueSymbol: string, marketType: "spot" | "perpetual", quantityUnit: "base" | "contract"): ContinuousFeedInstrument {
  return { venue: "kucoin", instrumentId: `kucoin:${marketType}:${venueSymbol}`, venueSymbol, marketType, quantityUnit };
}

function welcome(sessionId = "generation-1") {
  return { sessionId, message: "welcome", pingInterval: 30_000 };
}

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/kucoin/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function socket(values: FakeSocket[]) {
  const value = new FakeSocket();
  values.push(value);
  return value as unknown as WebSocket;
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

function governor() {
  return new UpstreamResourceGovernor({ "kucoin.public-websocket": { maxConcurrent: 2, failureThreshold: 2, cooldownMs: 1_000 } }, () => RECEIVED_AT);
}
