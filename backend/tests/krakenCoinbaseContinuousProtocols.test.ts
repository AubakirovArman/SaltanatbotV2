import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuousPublicFeed } from "../src/arbitrage/upstream/publicFeeds/feed.js";
import { CoinbaseAdvancedContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/coinbaseProtocol.js";
import { pairwiseBookFromContinuous } from "../src/arbitrage/upstream/publicFeeds/discovery.js";
import { KrakenFuturesContinuousProtocol, KrakenSpotContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/krakenProtocol.js";
import { createContinuousVenueProtocol } from "../src/arbitrage/upstream/publicFeeds/protocolFactory.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/governor.js";

const RECEIVED_AT = 1_784_030_400_500;

afterEach(() => vi.useRealTimers());

describe("Kraken and Coinbase continuous public protocols", () => {
  it("verifies every Kraken Spot CRC32 with lossless JSON decimals and rejects a checksum mismatch", () => {
    const protocol = new KrakenSpotContinuousProtocol(instrument("kraken", "BTC/USD", "spot", "base"));
    expect(protocol.push(fixture("kraken-spot-book-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100, 3],
          [99, 2]
        ],
        continuity: { kind: "checksum-verified", sequence: 1, checksum: 2181137708, protocol: "kraken-spot-crc32" }
      }
    });
    const updated = protocol.push(fixture("kraken-spot-book-update.json"), RECEIVED_AT + 100);
    expect(updated).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 6],
          [99, 2]
        ],
        asks: [
          [101, 7],
          [102, 5]
        ],
        continuity: { sequence: 2, checksum: 3630265277 }
      }
    });
    if (updated.kind !== "book") throw new Error("expected checksum-verified Kraken Spot book");
    expect(pairwiseBookFromContinuous({ ...updated.book, connectionGeneration: 7 }, RECEIVED_AT + 100, 10_000)).toMatchObject({
      sequence: 2,
      sourceId: "kraken:public-websocket:kraken-spot-crc32:generation-7"
    });

    const wrong = structuredClone(fixture("kraken-spot-book-update.json")) as { data: Array<{ checksum: number }> };
    wrong.data[0]!.checksum += 1;
    expect(protocol.push(wrong, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/checksum mismatch/) });
    expect(protocol.push(fixture("kraken-spot-book-update.json"), RECEIVED_AT + 300)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/before a checksum-verified snapshot/) });
  });

  it("preserves numeric JSON token precision before calculating the Kraken checksum", () => {
    const protocol = new KrakenSpotContinuousProtocol(instrument("kraken", "BTC/USD", "spot", "base"));
    const raw = '{"channel":"book","type":"snapshot","data":[{"symbol":"BTC/USD","bids":[{"price":100.0,"qty":3.000},{"price":99.0,"qty":2.000}],"asks":[{"price":101.0,"qty":4.000},{"price":102.0,"qty":5.000}],"checksum":2181137708,"timestamp":"2026-07-14T12:00:00.100000Z"}]}';
    expect(protocol.push(protocol.parse(raw), RECEIVED_AT)).toMatchObject({ kind: "book", book: { continuity: { checksum: 2181137708 } } });
  });

  it("keeps Kraken Futures under a separate non-contiguous protocol proof", () => {
    const protocol = new KrakenFuturesContinuousProtocol(instrument("kraken", "PI_XBTUSD", "perpetual", "contract"));
    expect(protocol.push(fixture("kraken-futures-book-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: { continuity: { kind: "sequence-observed", sequence: 1000, protocol: "kraken-futures-seq", sequenceVerified: false } }
    });
    const update = protocol.push(fixture("kraken-futures-book-update.json"), RECEIVED_AT + 100);
    expect(update).toMatchObject({
      kind: "book",
      book: {
        asks: [
          [101, 7000],
          [102, 5000]
        ],
        continuity: { sequence: 1004 }
      }
    });
    if (update.kind !== "book") throw new Error("expected Kraken Futures book");
    expect(pairwiseBookFromContinuous({ ...update.book, connectionGeneration: 1 }, RECEIVED_AT + 100, 10_000)).toMatch(/not documented as contiguous/);

    const regressed = structuredClone(fixture("kraken-futures-book-update.json")) as { seq: number };
    regressed.seq = 1003;
    expect(protocol.push(regressed, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/did not advance/) });
  });

  it("reconstructs Coinbase Advanced level2, gates sequence zero from routes, and never subscribes to market_trades", () => {
    const protocol = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    const socket = new FakeSocket();
    protocol.subscribe(socket as unknown as WebSocket, RECEIVED_AT);
    expect(socket.sent).toEqual(['{"type":"subscribe","product_ids":["BTC-USD"],"channel":"level2"}', '{"type":"subscribe","channel":"heartbeats"}']);
    expect(socket.sent.join(" ")).not.toContain("market_trades");
    const snapshot = protocol.push(fixture("coinbase-level2-snapshot.json"), RECEIVED_AT);
    expect(snapshot).toMatchObject({
      kind: "book",
      book: { continuity: { kind: "sequence-verified", sequence: 0, protocol: "coinbase-advanced-sequence" } }
    });
    if (snapshot.kind !== "book") throw new Error("expected Coinbase snapshot book");
    expect(pairwiseBookFromContinuous({ ...snapshot.book, connectionGeneration: 1 }, RECEIVED_AT, 10_000)).toMatch(/positive safe integer/);

    const update = protocol.push(fixture("coinbase-level2-update.json"), RECEIVED_AT + 100);
    expect(update).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 6],
          [99, 2]
        ],
        asks: [
          [101, 7],
          [102, 5]
        ],
        exchangeTs: Date.parse("2026-07-14T12:00:00.205000Z"),
        continuity: { sequence: 1 }
      }
    });
    if (update.kind !== "book") throw new Error("expected Coinbase update book");
    expect(pairwiseBookFromContinuous({ ...update.book, connectionGeneration: 1 }, RECEIVED_AT + 100, 10_000)).toMatchObject({
      sequence: 1,
      sourceId: "coinbase:public-websocket:coinbase-advanced-sequence:generation-1"
    });
    const gap = structuredClone(fixture("coinbase-level2-update.json")) as { sequence_num: number };
    gap.sequence_num = 3;
    expect(protocol.push(gap, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected 2, received 3/) });
  });

  it("verifies Coinbase sequence_num globally across interleaved L2, control, ignored and heartbeat envelopes", () => {
    const protocol = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    expect(protocol.push(withSequence(fixture("coinbase-level2-snapshot.json"), 0), RECEIVED_AT)).toMatchObject({ kind: "book", book: { continuity: { sequence: 0 } } });
    expect(protocol.push(withSequence(fixture("coinbase-level2-update.json"), 1), RECEIVED_AT + 10)).toMatchObject({ kind: "book", book: { continuity: { sequence: 1 } } });
    expect(protocol.push(withSequence(fixture("coinbase-level2-update.json"), 2), RECEIVED_AT + 20)).toMatchObject({ kind: "book", book: { continuity: { sequence: 2 } } });
    expect(protocol.push({ channel: "subscriptions", sequence_num: 3 }, RECEIVED_AT + 30)).toEqual({ kind: "accepted" });
    expect(protocol.push(withSequence(fixture("coinbase-level2-update.json"), 4), RECEIVED_AT + 40)).toMatchObject({ kind: "book", book: { continuity: { sequence: 4 } } });
    expect(protocol.push({ channel: "subscriptions", sequence_num: 5 }, RECEIVED_AT + 50)).toEqual({ kind: "accepted" });
    expect(protocol.push(withSequence(fixture("coinbase-level2-update.json"), 6), RECEIVED_AT + 60)).toMatchObject({ kind: "book", book: { continuity: { sequence: 6 } } });
    expect(protocol.push({ channel: "future_control", sequence_num: 7 }, RECEIVED_AT + 70)).toEqual({ kind: "ignored" });
    expect(protocol.push({ channel: "future_control", sequence_num: 8 }, RECEIVED_AT + 80)).toEqual({ kind: "ignored" });
    expect(protocol.push({ channel: "future_control", sequence_num: 9 }, RECEIVED_AT + 90)).toEqual({ kind: "ignored" });
    expect(protocol.push(withSequence(fixture("coinbase-heartbeat.json"), 10), RECEIVED_AT + 100)).toEqual({ kind: "heartbeat" });
  });

  it("keeps Coinbase snapshot envelope time separate from monotonic matching-engine delta time", () => {
    const protocol = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    const snapshot = structuredClone(fixture("coinbase-level2-snapshot.json")) as { timestamp: string };
    snapshot.timestamp = "2026-07-14T12:00:00.900000Z";
    expect(protocol.push(snapshot, RECEIVED_AT)).toMatchObject({ kind: "book", book: { exchangeTs: Date.parse(snapshot.timestamp) } });
    expect(protocol.push(fixture("coinbase-level2-update.json"), RECEIVED_AT + 10)).toMatchObject({
      kind: "book",
      book: { exchangeTs: Date.parse("2026-07-14T12:00:00.205000Z"), continuity: { sequence: 1 } }
    });
    const regressed = withSequence(fixture("coinbase-level2-update.json"), 2) as { events: Array<{ updates: Array<{ event_time: string }> }> };
    for (const update of regressed.events[0]!.updates) update.event_time = "2026-07-14T12:00:00.204000Z";
    expect(protocol.push(regressed, RECEIVED_AT + 20)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/matching-engine event time regressed/) });
  });

  it("fails closed on the first non-zero Coinbase envelope and a gap carried by an ignored channel", () => {
    const protocol = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    expect(protocol.push({ channel: "future_control" }, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/no valid global sequence_num/) });
    expect(protocol.push({ channel: "subscriptions", sequence_num: 1 }, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/must start at 0/) });
    expect(protocol.push(fixture("coinbase-level2-snapshot.json"), RECEIVED_AT + 10)).toMatchObject({ kind: "book" });
    expect(protocol.push({ channel: "future_control", sequence_num: 2 }, RECEIVED_AT + 20)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected 1, received 2/) });
    expect(protocol.push(withSequence(fixture("coinbase-level2-update.json"), 0), RECEIVED_AT + 30)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/before a snapshot/) });
  });

  it("uses Coinbase heartbeat counters to detect a silent transport gap", () => {
    const protocol = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    expect(protocol.push(fixture("coinbase-heartbeat.json"), RECEIVED_AT)).toEqual({ kind: "heartbeat" });
    const next = structuredClone(fixture("coinbase-heartbeat.json")) as { sequence_num: number; events: Array<{ heartbeat_counter: number }> };
    next.sequence_num = 1;
    next.events[0]!.heartbeat_counter = 3050;
    expect(protocol.push(next, RECEIVED_AT + 1_000)).toEqual({ kind: "heartbeat" });
    next.sequence_num = 2;
    next.events[0]!.heartbeat_counter = 3052;
    expect(protocol.push(next, RECEIVED_AT + 2_000)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected 3051/) });
  });

  it("fails closed on Coinbase public USD/USDC aliasing and selects protocols explicitly", () => {
    expect(() => new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USDC", "spot", "base"))).toThrow(/alias most -USDC products/);
    expect(() => new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "USDT-USDC", "spot", "base"))).not.toThrow();
    expect(createContinuousVenueProtocol(instrument("kraken", "BTC/USD", "spot", "base"))).toBeInstanceOf(KrakenSpotContinuousProtocol);
    expect(createContinuousVenueProtocol(instrument("kraken", "PI_XBTUSD", "perpetual", "contract"))).toBeInstanceOf(KrakenFuturesContinuousProtocol);
    expect(createContinuousVenueProtocol(instrument("coinbase", "BTC-USD", "spot", "base"))).toBeInstanceOf(CoinbaseAdvancedContinuousProtocol);
  });

  it("enforces hard per-message and subscribed-depth bounds before retaining a book", () => {
    const kraken = new KrakenSpotContinuousProtocol(instrument("kraken", "BTC/USD", "spot", "base"), { krakenSpotDepth: 10 });
    const oversizedKraken = structuredClone(fixture("kraken-spot-book-snapshot.json")) as { data: Array<{ bids: Array<{ price: string; qty: string }> }> };
    oversizedKraken.data[0]!.bids = Array.from({ length: 11 }, (_, index) => ({ price: String(100 - index / 10), qty: "1.000" }));
    expect(kraken.push(oversizedKraken, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/exceeds its subscribed depth/) });

    const coinbase = new CoinbaseAdvancedContinuousProtocol(instrument("coinbase", "BTC-USD", "spot", "base"));
    const oversizedCoinbase = structuredClone(fixture("coinbase-level2-snapshot.json")) as { events: Array<{ updates: unknown[] }> };
    oversizedCoinbase.events[0]!.updates = Array.from({ length: 60_001 }, () => ({ side: "bid", event_time: "1970-01-01T00:00:00Z", price_level: "100", new_quantity: "1" }));
    expect(coinbase.push(oversizedCoinbase, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/oversized/) });
  });

  it("withdraws a Coinbase generation on a control-channel gap and publishes only the reconnected generation", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const feed = new ContinuousPublicFeed(instrument("coinbase", "BTC-USD", "spot", "base"), callbacks(books), {
      governor: governorFor("coinbase.public-websocket"),
      createSocket: () => socket(sockets),
      now: () => RECEIVED_AT,
      random: () => 0,
      heartbeatMs: 1_000,
      messageTimeoutMs: 5_000
    });
    feed.start();
    sockets[0]!.open();
    sockets[0]!.message(fixture("coinbase-level2-snapshot.json"));
    expect(books).toHaveLength(1);
    const firstGeneration = books[0]!.connectionGeneration;
    sockets[0]!.message({ channel: "subscriptions", sequence_num: 2 });
    expect(sockets[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    sockets[1]!.open();
    sockets[1]!.message(fixture("coinbase-level2-snapshot.json"));
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
    this.sent.push("<ping>");
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
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

function socket(values: FakeSocket[]) {
  const value = new FakeSocket();
  values.push(value);
  return value as unknown as WebSocket;
}

function callbacks(books: ContinuousPublicBook[]): ContinuousFeedCallbacks {
  return { onBook: (book) => books.push(book), onTopBook: () => undefined, onFunding: () => undefined, onInvalidate: () => undefined, onStatus: () => undefined };
}

function governorFor(source: string) {
  return new UpstreamResourceGovernor({ [source]: { maxConcurrent: 2, failureThreshold: 2, cooldownMs: 1_000 } }, () => RECEIVED_AT);
}

function instrument(venue: "kraken" | "coinbase", venueSymbol: string, marketType: "spot" | "perpetual" | "future", quantityUnit: "base" | "contract"): ContinuousFeedInstrument {
  return { venue, instrumentId: `${venue}:${marketType}:${venueSymbol}`, venueSymbol, marketType, quantityUnit };
}

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/public-feeds/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function withSequence(value: unknown, sequence_num: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture is not an envelope");
  return { ...value, sequence_num };
}
