import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KucoinObuBookReconciler, kucoinObuSubscription } from "../src/venues/kucoin/index.js";
import { MEXC_SPOT_PUBLIC_WS_URL, MexcFuturesBookReconciler, MexcSpotProtobufBookReconciler, mexcFuturesDepthSubscription, mexcSpotDepthSubscription } from "../src/venues/mexc/index.js";

const KUCOIN_SNAPSHOT = fixture("kucoin", "obu-snapshot.json");
const KUCOIN_DELTA = fixture("kucoin", "obu-delta.json");
const MEXC_SPOT_SNAPSHOT = fixture("mexc", "spot-protobuf-snapshot.json");
const MEXC_SPOT_DELTA = fixture("mexc", "spot-protobuf-delta.json");
const MEXC_FUTURES_SNAPSHOT = fixture("mexc", "futures-book-snapshot.json");
const MEXC_FUTURES_DELTA = fixture("mexc", "futures-book-delta.json");

describe("KuCoin post-retirement OBU protocol", () => {
  it("builds only increment@10ms public subscriptions", () => {
    const request = kucoinObuSubscription("book-1", "btc-usdt", "spot");

    expect(request).toEqual({
      id: "book-1",
      action: "SUBSCRIBE",
      channel: "obu",
      tradeType: "SPOT",
      symbol: "BTC-USDT",
      depth: "increment@10ms",
      rpiFilter: 0
    });
    expect(JSON.stringify(request)).not.toMatch(/key|secret|signature|increment"/i);
  });

  it("accepts snapshot then overlapping absolute deltas and deletes zero levels", () => {
    const book = new KucoinObuBookReconciler("BTC-USDT", "spot");

    expect(book.apply(KUCOIN_SNAPSHOT as any)).toMatchObject({ status: "ready", sequence: "1000", routeReady: true, exchangeTs: 1784023200000 });
    const updated = book.apply(KUCOIN_DELTA as any);

    expect(updated).toMatchObject({ status: "ready", sequence: "1003", routeReady: true, exchangeTs: 1784023200010 });
    expect(updated.bids).toEqual([
      [100, 1.5],
      [99, 4]
    ]);
    expect(updated.asks).toEqual([
      [101.5, 5],
      [102, 3]
    ]);
    expect(book.apply(KUCOIN_DELTA as any)).toMatchObject({ sequence: "1003", status: "ready" });
  });

  it("invalidates gaps, retired modes and deltas before snapshot; reconnect requires a new snapshot", () => {
    const beforeSnapshot = new KucoinObuBookReconciler("BTC-USDT", "spot");
    expect(() => beforeSnapshot.apply(KUCOIN_DELTA as any)).toThrow(/before an increment@10ms snapshot/);
    expect(beforeSnapshot.snapshot()).toMatchObject({ status: "invalidated", routeReady: false });

    const retired = structuredClone(KUCOIN_SNAPSHOT) as any;
    retired.dp = "increment";
    const retiredBook = new KucoinObuBookReconciler("BTC-USDT", "spot");
    expect(() => retiredBook.apply(retired)).toThrow(/retired increment mode is forbidden/);

    const gapBook = new KucoinObuBookReconciler("BTC-USDT", "spot");
    gapBook.apply(KUCOIN_SNAPSHOT as any);
    const gap = structuredClone(KUCOIN_DELTA) as any;
    gap.d.O = "1002";
    gap.d.C = "1004";
    expect(() => gapBook.apply(gap)).toThrow(/sequence gap/);
    expect(gapBook.reset()).toMatchObject({ status: "awaiting-snapshot", routeReady: false, bids: [], asks: [] });
    expect(() => gapBook.apply(KUCOIN_DELTA as any)).toThrow(/before an increment@10ms snapshot/);
  });

  it("enforces the documented 500-level ceiling", () => {
    expect(() => new KucoinObuBookReconciler("BTC-USDT", "spot", { maxLevelsPerSide: 501 })).toThrow(/cannot exceed 500/);
    expect(() => new KucoinObuBookReconciler("BTC-USDT", "spot", { maxUpdatesPerMessage: 2_001 })).toThrow(/cannot exceed 2000/);
  });

  it("fails closed when an incremental update crosses the cached top of book", () => {
    const book = new KucoinObuBookReconciler("BTC-USDT", "spot");
    book.apply(KUCOIN_SNAPSHOT as any);
    const crossed = structuredClone(KUCOIN_DELTA) as any;
    crossed.d.O = "1001";
    crossed.d.C = "1001";
    crossed.d.b = [["102", "1"]];
    crossed.d.a = [];
    expect(() => book.advance(crossed)).toThrow(/crossed or locked/);
    expect(book.snapshot()).toMatchObject({ status: "invalidated", routeReady: false, bids: [], asks: [] });
  });
});

describe("MEXC Spot Protobuf protocol", () => {
  it("uses the replacement public endpoint and Protobuf aggregate-depth topic", () => {
    expect(MEXC_SPOT_PUBLIC_WS_URL).toBe("wss://wbs-api.mexc.com/ws");
    expect(mexcSpotDepthSubscription("btcusdt")).toEqual({
      method: "SUBSCRIPTION",
      params: ["spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT"]
    });
  });

  it("buffers decoded PB deltas, bridges the REST snapshot and then requires exact continuity", () => {
    const book = new MexcSpotProtobufBookReconciler("BTCUSDT");

    expect(book.ingestDecoded(MEXC_SPOT_DELTA as any)).toMatchObject({ status: "awaiting-snapshot", bufferedMessages: 1, routeReady: false });
    const seeded = book.seed(MEXC_SPOT_SNAPSHOT, 1784023200005);

    expect(seeded).toMatchObject({ status: "ready", sequence: "1003", bufferedMessages: 0, routeReady: true, boundedSnapshot: true });
    expect(seeded.bids).toEqual([
      [100, 2],
      [99, 4]
    ]);
    expect(seeded.asks).toEqual([
      [101.5, 3],
      [102, 3]
    ]);

    const next = structuredClone(MEXC_SPOT_DELTA) as any;
    next.publicAggreDepths.fromVersion = "1004";
    next.publicAggreDepths.toVersion = "1004";
    next.publicAggreDepths.asks = [];
    next.publicAggreDepths.bids = [{ price: "100", quantity: "2.5" }];
    next.sendTime = 1784023200020;
    expect(book.ingestDecoded(next)).toMatchObject({ sequence: "1004", exchangeTs: 1784023200020 });
  });

  it("invalidates gaps, legacy/non-PB frames and bounded-buffer overflow", () => {
    const gapBook = new MexcSpotProtobufBookReconciler("BTCUSDT");
    gapBook.seed(MEXC_SPOT_SNAPSHOT, 1784023200000);
    const gap = structuredClone(MEXC_SPOT_DELTA) as any;
    gap.publicAggreDepths.fromVersion = "1002";
    gap.publicAggreDepths.toVersion = "1003";
    expect(() => gapBook.ingestDecoded(gap)).toThrow(/version gap/);
    expect(gapBook.snapshot()).toMatchObject({ status: "invalidated", routeReady: false });
    expect(gapBook.reset()).toMatchObject({ status: "awaiting-snapshot", bids: [], asks: [] });

    const legacy = structuredClone(MEXC_SPOT_DELTA) as any;
    legacy.channel = "spot@public.increase.depth.v3.api@BTCUSDT";
    const legacyBook = new MexcSpotProtobufBookReconciler("BTCUSDT");
    expect(() => legacyBook.ingestDecoded(legacy)).toThrow(/Protobuf aggregate-depth channel/);

    const bounded = new MexcSpotProtobufBookReconciler("BTCUSDT", { maxBufferedMessages: 1 });
    bounded.ingestDecoded(MEXC_SPOT_DELTA as any);
    expect(() => bounded.ingestDecoded(MEXC_SPOT_DELTA as any)).toThrow(/buffer exceeds 1/);

    const updateBounded = new MexcSpotProtobufBookReconciler("BTCUSDT", { maxBufferedMessages: 10, maxBufferedLevelUpdates: 3 });
    updateBounded.ingestDecoded(MEXC_SPOT_DELTA as any);
    expect(() => updateBounded.ingestDecoded(MEXC_SPOT_DELTA as any)).toThrow(/exceeds 3 level updates/);
  });
});

describe("MEXC futures native version protocol", () => {
  it("keeps the native subscription separate and applies exact version+1 absolute updates", () => {
    expect(mexcFuturesDepthSubscription("btc_usdt")).toEqual({ method: "sub.depth", param: { symbol: "BTC_USDT", compress: false } });
    const book = new MexcFuturesBookReconciler("BTC_USDT");

    expect(book.seed(MEXC_FUTURES_SNAPSHOT)).toMatchObject({ status: "ready", sequence: "500", routeReady: true });
    const updated = book.apply(MEXC_FUTURES_DELTA as any);

    expect(updated).toMatchObject({ sequence: "501", exchangeTs: 1784023200010, quantityUnit: "contract" });
    expect(updated.bids).toEqual([
      [100, 15, 3],
      [99, 40, 3]
    ]);
    expect(updated.asks).toEqual([
      [101.5, 25, 2],
      [102, 30, 1]
    ]);
  });

  it("invalidates a gap or wrong protocol and requires a new snapshot after reconnect", () => {
    const book = new MexcFuturesBookReconciler("BTC_USDT");
    book.seed(MEXC_FUTURES_SNAPSHOT);
    const gap = structuredClone(MEXC_FUTURES_DELTA) as any;
    gap.data.version = 502;
    expect(() => book.apply(gap)).toThrow(/version gap/);
    expect(book.reset()).toMatchObject({ status: "awaiting-snapshot", routeReady: false });
    expect(() => book.apply(MEXC_FUTURES_DELTA as any)).toThrow(/requires a REST snapshot/);

    const wrong = new MexcFuturesBookReconciler("BTC_USDT");
    wrong.seed(MEXC_FUTURES_SNAPSHOT);
    const protobuf = structuredClone(MEXC_FUTURES_DELTA) as any;
    protobuf.channel = "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT";
    expect(() => wrong.apply(protobuf)).toThrow(/must be push.depth/);
  });

  it("fails closed when a native delta crosses the cached top of book", () => {
    const book = new MexcFuturesBookReconciler("BTC_USDT");
    book.seed(MEXC_FUTURES_SNAPSHOT);
    const crossed = structuredClone(MEXC_FUTURES_DELTA) as any;
    crossed.data.bids = [[102, 1, 1]];
    crossed.data.asks = [];
    expect(() => book.advance(crossed)).toThrow(/crossed or locked/);
    expect(book.snapshot()).toMatchObject({ status: "invalidated", routeReady: false, bids: [], asks: [] });
  });
});

function fixture(directory: "kucoin" | "mexc", name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${directory}/${name}`, import.meta.url), "utf8"));
}
