import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";
import { ContinuousPublicFeed, publicFeedSocketOptions } from "../src/arbitrage/upstream/publicFeeds/feed.js";
import { ContinuousPublicFeedHub } from "../src/arbitrage/upstream/publicFeeds/hub.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/governor.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousPublicBook } from "../src/arbitrage/upstream/publicFeeds/types.js";

const NOW = 1_784_000_000_500;

afterEach(() => vi.useRealTimers());

describe("continuous public feed lifecycle", () => {
  it("isolates Coinbase's bounded full-L2 frame budget from other venue sockets", () => {
    expect(publicFeedSocketOptions(instrument("coinbase", "BTC-USD", "spot", "base"))).toEqual({ maxPayload: 8 * 1024 * 1024 });
    expect(publicFeedSocketOptions(instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"))).toEqual({ maxPayload: 2 * 1024 * 1024 });
    expect(publicFeedSocketOptions(instrument("gate", "BTC_USDT", "perpetual", "contract"))).toEqual({ maxPayload: 2 * 1024 * 1024, headers: { "X-Gate-Size-Decimal": "1" } });
  });

  it("withdraws a generation on malformed input and publishes only the reconnected generation", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const invalidations: string[] = [];
    const governor = governorFor("okx.public-websocket", 2);
    const feed = new ContinuousPublicFeed(instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"), callbacks({ books, invalidations }), { governor, createSocket: () => socket(sockets), now: () => NOW, random: () => 0, heartbeatMs: 1_000, messageTimeoutMs: 5_000 });
    feed.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent.some((value) => value.includes('"channel":"books"'))).toBe(true);
    sockets[0]!.message(fixture("okx-book-snapshot.json"));
    expect(books).toHaveLength(1);
    expect(governor.sourceSnapshot("okx.public-websocket")).toMatchObject({ active: 0, counters: { succeeded: 1 } });
    const firstGeneration = books[0]!.connectionGeneration;

    sockets[0]!.emit("message", Buffer.from("not-json"));
    expect(sockets[0]!.terminated).toBe(true);
    expect(invalidations.some((reason) => /Malformed JSON/.test(reason))).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.message(fixture("okx-book-snapshot.json"));
    expect(books).toHaveLength(2);
    expect(books[1]!.connectionGeneration).toBeGreaterThan(firstGeneration);
    feed.close();
  });

  it("uses Gate futures.obu full snapshots without an unnecessary REST bootstrap", () => {
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    const depth = vi.fn(async () => gateDepth(300));
    const adapter = fakeAdapter(depth);
    const feed = new ContinuousPublicFeed(instrument("gate", "BTC_USDT", "perpetual", "contract"), callbacks({ books }), {
      adapter,
      governor: governorFor("gate.public-websocket", 2),
      restGovernor: governorFor("gate.public-rest", 2),
      createSocket: () => socket(sockets),
      now: () => NOW
    });
    feed.start();
    sockets[0]!.open();
    sockets[0]!.message(fixture("gate-perpetual-snapshot.json"));
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      continuity: { sequence: 300 },
      bids: [
        [100, 3],
        [99, 2]
      ]
    });
    expect(depth).not.toHaveBeenCalled();
    feed.close();
  });

  it("governs the optional Gate incremental REST bridge and replays its bounded buffer", async () => {
    const sockets: FakeSocket[] = [];
    const books: ContinuousPublicBook[] = [];
    let resolveDepth: ((value: ReturnType<typeof gateDepth>) => void) | undefined;
    const depth = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof gateDepth>>((resolve) => {
          resolveDepth = resolve;
        })
    );
    const restGovernor = governorFor("gate.public-rest", 1);
    const feed = new ContinuousPublicFeed(instrument("gate", "BTC_USDT", "perpetual", "contract"), callbacks({ books }), {
      gateMode: "incremental-rest-bridge",
      adapter: fakeAdapter(depth),
      governor: governorFor("gate.public-websocket", 1),
      restGovernor,
      createSocket: () => socket(sockets),
      now: () => NOW
    });
    feed.start();
    sockets[0]!.open();
    sockets[0]!.message(fixture("gate-perpetual-update.json"));
    expect(books).toHaveLength(0);
    resolveDepth?.(gateDepth(300));
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(books[0]).toMatchObject({
      continuity: { sequence: 302 },
      bids: [
        [100.5, 8],
        [99, 2]
      ]
    });
    expect(restGovernor.sourceSnapshot("gate.public-rest")).toMatchObject({ active: 0, counters: { succeeded: 1 } });
    feed.close();
  });

  it("fails admission without opening a socket or creating an unbounded wait queue", () => {
    vi.useFakeTimers();
    const governor = governorFor("okx.public-websocket", 1);
    const occupied = governor.acquire("okx.public-websocket");
    const createSocket = vi.fn();
    const states: string[] = [];
    const feed = new ContinuousPublicFeed(instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"), callbacks({ states }), { governor, createSocket, now: () => NOW, random: () => 0 });
    feed.start();
    expect(createSocket).not.toHaveBeenCalled();
    expect(states).toContain("overloaded");
    expect(governor.sourceSnapshot("okx.public-websocket").counters.overloadRejected).toBe(1);
    feed.close();
    occupied.release("success");
  });

  it("does not hot-loop while another stream owns the half-open probe", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const source = "okx.public-websocket";
    const governor = new UpstreamResourceGovernor({ [source]: { maxConcurrent: 2, failureThreshold: 1, cooldownMs: 100 } }, () => now);
    governor.acquire(source).release("failure");
    now += 100;
    const probe = governor.acquire(source);
    const statuses: Array<{ state: string; generation: number }> = [];
    const createSocket = vi.fn();
    const feed = new ContinuousPublicFeed(
      instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"),
      {
        onBook: () => undefined,
        onTopBook: () => undefined,
        onFunding: () => undefined,
        onInvalidate: () => undefined,
        onStatus: ({ state, generation }) => statuses.push({ state, generation })
      },
      { governor, createSocket, now: () => now }
    );

    feed.start();
    expect(statuses.at(-1)).toEqual({ state: "reconnecting", generation: 1 });
    await vi.advanceTimersByTimeAsync(99);
    expect(statuses.at(-1)?.generation).toBe(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.at(-1)).toEqual({ state: "reconnecting", generation: 2 });
    await vi.advanceTimersByTimeAsync(99);
    expect(statuses.at(-1)?.generation).toBe(2);
    expect(createSocket).not.toHaveBeenCalled();

    feed.close();
    probe.release("success");
  });

  it("shares a feed, applies per-venue bounds, and isolates one venue invalidation", () => {
    let okxCallbacks: ContinuousFeedCallbacks | undefined;
    let gateCallbacks: ContinuousFeedCallbacks | undefined;
    let starts = 0;
    let closes = 0;
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      maxStreams: 2,
      maxStreamsPerVenue: 1,
      feedFactory: (value, next) => {
        if (value.venue === "okx") okxCallbacks = next;
        else gateCallbacks = next;
        return {
          start: () => {
            starts += 1;
          },
          close: () => {
            closes += 1;
          }
        };
      }
    });
    const okx = instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract");
    const gate = instrument("gate", "BTC_USDT", "perpetual", "contract");
    const firstBooks: ContinuousPublicBook[] = [];
    const first = hub.subscribe(okx, { onBook: (book) => firstBooks.push(book) });
    const second = hub.subscribe(okx, { onBook: (book) => firstBooks.push(book) });
    expect(starts).toBe(1);
    expect(() => hub.subscribe(instrument("okx", "ETH-USDT-SWAP", "perpetual", "contract"), {})).toThrow(/okx continuous stream limit/);
    const gateSub = hub.subscribe(gate, {});
    expect(starts).toBe(2);
    okxCallbacks?.onBook(book(okx, 1, 100));
    gateCallbacks?.onBook(book(gate, 1, 200));
    const gateBook = hub.snapshots().find((value) => value.instrument.venue === "gate")!.book!;
    okxCallbacks?.onInvalidate("okx gap");
    expect(hub.snapshots().find((value) => value.instrument.venue === "okx")!.book).toBeUndefined();
    expect(hub.isCurrent(gateBook)).toBe(true);
    expect(firstBooks).toHaveLength(2);
    first.close();
    second.close();
    gateSub.close();
    hub.close();
    expect(closes).toBe(2);
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

function callbacks(values: { books?: ContinuousPublicBook[]; invalidations?: string[]; states?: string[] }): ContinuousFeedCallbacks {
  return {
    onBook: (book) => values.books?.push(book),
    onTopBook: () => undefined,
    onFunding: () => undefined,
    onInvalidate: (reason) => values.invalidations?.push(reason),
    onStatus: (status) => values.states?.push(status.state)
  };
}

function governorFor(source: string, maxConcurrent: number) {
  return new UpstreamResourceGovernor({ [source]: { maxConcurrent, failureThreshold: 2, cooldownMs: 1_000 } }, () => NOW);
}

function fakeAdapter(depth: PublicVenueAdapter["depth"]): PublicVenueAdapter {
  return {
    venue: "gate",
    capabilities: () => ({ venue: "gate", publicData: true, spot: true, margin: false, perpetual: true, datedFuture: false, option: false, nativeSpread: false, topBook: true, depth: true, publicTrades: false, funding: true, borrow: false, depositWithdrawal: false, privateExecution: false, demoEnvironment: false }),
    instruments: vi.fn(),
    tickers: vi.fn(),
    ticker: vi.fn(),
    depth,
    funding: vi.fn()
  };
}

function gateDepth(sequence: number) {
  return {
    venue: "gate",
    instrumentId: "BTC_USDT",
    marketType: "perpetual" as const,
    quantityUnit: "contract" as const,
    bids: [
      [100, 3],
      [99, 2]
    ] as const,
    asks: [
      [101, 4],
      [102, 5]
    ] as const,
    sequence,
    exchangeTs: NOW - 1,
    receivedAt: NOW,
    complete: true as const
  };
}

function book(value: ContinuousFeedInstrument, generation: number, sequence: number): ContinuousPublicBook {
  return {
    venue: value.venue,
    instrumentId: value.instrumentId,
    venueSymbol: value.venueSymbol,
    marketType: value.marketType,
    quantityUnit: value.quantityUnit,
    bids: [[100, 2]],
    asks: [[101, 2]],
    exchangeTs: NOW,
    receivedAt: NOW,
    complete: true,
    continuity: { kind: "sequence-verified", sequence, protocol: value.venue === "gate" ? "gate-update-id" : "okx-seqid" },
    source: "public-websocket",
    connectionGeneration: generation,
    retainedDepth: 100
  };
}

function instrument(venue: ContinuousFeedInstrument["venue"], venueSymbol: string, marketType: ContinuousFeedInstrument["marketType"], quantityUnit: ContinuousFeedInstrument["quantityUnit"]): ContinuousFeedInstrument {
  return { venue, instrumentId: `${venue}:${marketType}:${venueSymbol}`, venueSymbol, marketType, quantityUnit };
}

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/public-feeds/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
