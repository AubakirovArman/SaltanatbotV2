import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairwiseBookFromContinuous } from "../src/arbitrage/upstream/publicFeeds/discovery.js";
import { DydxIndexerContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/dydxProtocol.js";
import { ContinuousPublicFeed } from "../src/arbitrage/upstream/publicFeeds/feed.js";
import { createContinuousVenueProtocol } from "../src/arbitrage/upstream/publicFeeds/protocolFactory.js";
import { PUBLIC_STREAM_SOURCES } from "../src/arbitrage/upstream/publicFeeds/process.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/governor.js";

const NOW = 1_784_070_000_000;
const INSTRUMENT: ContinuousFeedInstrument = {
  venue: "dydx",
  instrumentId: "dydx:perpetual:BTC-USD",
  venueSymbol: "BTC-USD",
  marketType: "perpetual",
  quantityUnit: "base"
};

afterEach(() => vi.useRealTimers());

describe("dYdX continuous Indexer research protocol", () => {
  it("subscribes only to an unbatched public book and uses control-frame heartbeats", () => {
    const protocol = new DydxIndexerContinuousProtocol(INSTRUMENT);
    const socket = new FakeSocket();

    protocol.subscribe(socket as unknown as WebSocket, NOW);
    protocol.heartbeat(socket as unknown as WebSocket, NOW);

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "subscribe", channel: "v4_orderbook", id: "BTC-USD", batched: false })
    ]);
    expect(socket.pings).toBe(1);
    expect(protocol.url).toBe("wss://indexer.dydx.trade/v4/ws");
    expect(protocol.needsBootstrap).toBe(false);
  });

  it("reconstructs contiguous messages but permanently labels the non-canonical book non-route-ready", () => {
    const protocol = new DydxIndexerContinuousProtocol(INSTRUMENT, { maxLevels: 4, publishLevels: 2 });
    expect(protocol.push(connected(), NOW)).toEqual({ kind: "accepted" });

    const snapshot = protocol.push(bookSnapshot(), NOW + 10);
    expect(snapshot).toMatchObject({
      kind: "book",
      book: {
        venue: "dydx",
        instrumentId: INSTRUMENT.instrumentId,
        exchangeTs: NOW + 10,
        receivedAt: NOW + 10,
        retainedDepth: 4,
        continuity: {
          kind: "sequence-observed",
          sequence: 1,
          protocol: "dydx-indexer-message-id",
          sequenceVerified: false
        }
      }
    });
    if (snapshot.kind !== "book") throw new Error("expected book");
    expect(snapshot.book.bids).toEqual([
      [100, 2],
      [99, 3]
    ]);

    const update = protocol.push(
      {
        type: "channel_data",
        connection_id: "conn-a",
        channel: "v4_orderbook",
        id: "BTC-USD",
        message_id: 2,
        contents: { bids: [["101", "1.5", "2"]], asks: [["102", "0", "2"]] }
      },
      NOW + 20
    );
    expect(update).toMatchObject({ kind: "book", book: { continuity: { sequence: 2 } } });
    if (update.kind !== "book") throw new Error("expected book");
    expect(update.book.bids[0]).toEqual([101, 1.5]);
    expect(pairwiseBookFromContinuous({ ...update.book, connectionGeneration: 3 }, NOW + 20, 1_000)).toMatch(/non-canonical research signal/i);
  });

  it("invalidates gaps, connection changes and replacement snapshots until a new generation", () => {
    const protocol = new DydxIndexerContinuousProtocol(INSTRUMENT);
    protocol.push(connected(), NOW);
    protocol.push(bookSnapshot(), NOW + 1);

    expect(
      protocol.push(
        {
          type: "channel_data",
          connection_id: "conn-a",
          channel: "v4_orderbook",
          id: "BTC-USD",
          message_id: 3,
          contents: { bids: [["101", "1", "3"]] }
        },
        NOW + 2
      )
    ).toMatchObject({ kind: "gap", reason: expect.stringMatching(/message-id gap/i) });
    expect(protocol.push(bookSnapshot(), NOW + 3)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/before the connected envelope/i) });

    protocol.push(connected("conn-b"), NOW + 4);
    protocol.push(bookSnapshot("conn-b", 10), NOW + 5);
    expect(protocol.push(bookSnapshot("conn-b", 11), NOW + 6)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/replacement snapshot/i) });
  });

  it("is factory-registered, governed and rejects unsupported dYdX market types", () => {
    expect(createContinuousVenueProtocol(INSTRUMENT)).toBeInstanceOf(DydxIndexerContinuousProtocol);
    expect(PUBLIC_STREAM_SOURCES.dydx).toBe("dydx.public-websocket");
    expect(() => new DydxIndexerContinuousProtocol({ ...INSTRUMENT, marketType: "spot" })).toThrow(/perpetual instrument/i);
    expect(() => new DydxIndexerContinuousProtocol(INSTRUMENT, { maxLevels: 2, publishLevels: 3 })).toThrow(/publishLevels/i);
  });

  it("withdraws a gapped generation and publishes again only after reconnect plus connected/snapshot", async () => {
    vi.useFakeTimers();
    const sockets: LifecycleSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const invalidations: string[] = [];
    const feed = new ContinuousPublicFeed(INSTRUMENT, callbacks(books, invalidations), {
      governor: new UpstreamResourceGovernor(
        { "dydx.public-websocket": { maxConcurrent: 2, failureThreshold: 2, cooldownMs: 1_000 } },
        () => NOW
      ),
      createSocket: () => lifecycleSocket(sockets),
      now: () => NOW,
      random: () => 0,
      heartbeatMs: 1_000,
      messageTimeoutMs: 5_000
    });

    feed.start();
    sockets[0]!.open();
    sockets[0]!.message(connected());
    sockets[0]!.message(bookSnapshot());
    expect(books).toHaveLength(1);
    const firstGeneration = books[0]!.connectionGeneration;

    sockets[0]!.message({
      type: "channel_data",
      connection_id: "conn-a",
      channel: "v4_orderbook",
      id: "BTC-USD",
      message_id: 3,
      contents: { bids: [["101", "1", "3"]] }
    });
    expect(sockets[0]!.terminated).toBe(true);
    expect(invalidations.some((reason) => /message-id gap/i.test(reason))).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message(connected("conn-b"));
    sockets[1]!.message(bookSnapshot("conn-b", 10));
    expect(books).toHaveLength(2);
    expect(books[1]!.connectionGeneration).toBeGreaterThan(firstGeneration);
    feed.close();
  });
});

class FakeSocket {
  sent: string[] = [];
  pings = 0;
  send(value: string) {
    this.sent.push(String(value));
  }
  ping() {
    this.pings += 1;
  }
}

class LifecycleSocket extends EventEmitter {
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

function lifecycleSocket(values: LifecycleSocket[]) {
  const value = new LifecycleSocket();
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

function connected(connectionId = "conn-a") {
  return { type: "connected", connection_id: connectionId, message_id: 0 };
}

function bookSnapshot(connectionId = "conn-a", messageId = 1) {
  return {
    type: "subscribed",
    connection_id: connectionId,
    channel: "v4_orderbook",
    id: "BTC-USD",
    message_id: messageId,
    contents: {
      bids: [
        { price: "100", size: "2", offset: String(messageId) },
        { price: "99", size: "3", offset: String(messageId) }
      ],
      asks: [
        { price: "102", size: "1", offset: String(messageId) },
        { price: "103", size: "4", offset: String(messageId) }
      ]
    }
  };
}
