import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DydxPublicAdapter } from "../src/venues/dydx/adapter.js";
import { DydxIndexerBookReconciler } from "../src/venues/dydx/indexerBook.js";
import { decodeDydxIndexerBookMessage } from "../src/venues/dydx/indexerProtocol.js";
import { DydxNodeBookReconciler } from "../src/venues/dydx/nodeBook.js";
import { DYDX_PUBLIC_VENUE_PLUGIN } from "../src/venues/dydx/plugin.js";
import { DydxIndexerTransport } from "../src/venues/dydx/transport.js";
import type { DydxNodeBookBatch } from "../src/venues/dydx/types.js";

const MARKETS = fixture("perpetual-markets.json");
const ORDERBOOK = fixture("orderbook-btc.json");
const FUNDING = fixture("historical-funding-btc.json");
const INDEXER_SNAPSHOT = decodeDydxIndexerBookMessage(fixture("indexer-book-snapshot.json"));
const INDEXER_UPDATES = fixture<unknown[]>("indexer-book-updates.json").map(decodeDydxIndexerBookMessage);
const NODE_BATCHES = fixture<DydxNodeBookBatch[]>("node-book-batches.json");
const NOW = Date.parse("2026-07-14T18:30:00.000Z");

describe("dYdX public read-only adapter", () => {
  it("advertises only public perpetual research data through the versioned plugin boundary", () => {
    const capabilities = adapter({}).capabilities();

    expect(capabilities).toMatchObject({
      venue: "dydx",
      publicData: true,
      perpetual: true,
      topBook: true,
      depth: true,
      funding: true,
      spot: false,
      margin: false,
      datedFuture: false,
      option: false,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false
    });
    expect(DYDX_PUBLIC_VENUE_PLUGIN).toMatchObject({
      venue: "dydx",
      authority: "public-read-only",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });
    expect(DYDX_PUBLIC_VENUE_PLUGIN.operations.map((operation) => operation.operation)).toEqual(["instruments", "ticker", "depth", "funding"]);
  });

  it("normalizes Indexer metadata and quarantines invalid rows", async () => {
    const snapshot = await adapter({ "/v4/perpetualMarkets": MARKETS }).instruments("perpetual");
    const btc = snapshot.instruments.find((instrument) => instrument.venueSymbol === "BTC-USD");
    const eth = snapshot.instruments.find((instrument) => instrument.venueSymbol === "ETH-USD");

    expect(snapshot).toMatchObject({
      venue: "dydx",
      network: "mainnet",
      marketType: "perpetual",
      receivedAt: NOW
    });
    expect(btc).toMatchObject({
      id: "dydx:perpetual:BTC-USD",
      assetId: "BTC",
      baseAsset: "BTC",
      quoteAsset: "USD",
      settleAsset: "USDC",
      clobPairId: 0,
      contractDirection: "linear",
      contractMultiplier: 1,
      quantityUnit: "base",
      tickSize: 1,
      quantityStep: 0.0001,
      initialMarginFraction: 0.02,
      maintenanceMarginFraction: 0.012,
      fundingIntervalMinutes: 60,
      status: "trading",
      dataPlane: "indexer"
    });
    expect(eth?.status).toBe("settling");
    expect(snapshot.rejectedRows).toEqual([expect.objectContaining({ index: 2, instrumentId: "BROKEN-USD" })]);
    await expect(adapter({}).instruments("spot")).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("labels selected REST top-book/depth as non-canonical research observations", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const client = adapter({ "/v4/orderbooks/perpetualMarket/BTC-USD": ORDERBOOK }, { onRequest: (url, init) => requests.push({ url: new URL(url), init }) });

    const [ticker, depth] = await Promise.all([client.ticker("BTC-USD", "perpetual"), client.depth({ instrumentId: "BTC-USD", marketType: "perpetual", limit: 2 })]);

    expect(ticker).toMatchObject({
      bid: 64571,
      bidSize: 0.1347,
      ask: 64572,
      askSize: 0.052,
      canonical: false,
      executable: false,
      executionStatus: "research-only",
      sequenceAvailable: false,
      timestampSource: "local-receive",
      exchangeTs: NOW
    });
    expect(depth).toMatchObject({
      sequence: 0,
      complete: true,
      canonical: false,
      executable: false,
      dataPlane: "indexer-rest"
    });
    expect(depth.bids).toEqual([
      [64571, 0.1347],
      [64570, 0.0417]
    ]);
    expect(depth.asks).toEqual([
      [64572, 0.052],
      [64573, 0.13]
    ]);
    await expect(client.tickers("perpetual")).rejects.toMatchObject({ kind: "unsupported" });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.origin).toBe("https://indexer.dydx.trade");
      expect(request.init?.method).toBe("GET");
      expect(new Headers(request.init?.headers).has("Authorization")).toBe(false);
    }
  });

  it("rejects a crossed REST book because REST levels have no logical offsets", async () => {
    const crossed = {
      bids: [{ price: "102", size: "1" }],
      asks: [{ price: "101", size: "1" }]
    };
    await expect(
      adapter({ "/v4/orderbooks/perpetualMarket/BTC-USD": crossed }).depth({
        instrumentId: "BTC-USD",
        marketType: "perpetual"
      })
    ).rejects.toThrow(/no logical offsets/i);
  });

  it("combines the current one-hour estimate with height-bound settled funding history", async () => {
    const requests: URL[] = [];
    const result = await adapter(
      {
        "/v4/perpetualMarkets": MARKETS,
        "/v4/historicalFunding/BTC-USD?limit=2": FUNDING
      },
      { onRequest: (url) => requests.push(new URL(url)) }
    ).funding("BTC-USD", { historyLimit: 2 });

    expect(result).toMatchObject({
      venue: "dydx",
      network: "mainnet",
      instrumentId: "BTC-USD",
      currentEstimateRate: -0.00004525,
      fundingTime: Date.parse("2026-07-14T19:00:00.000Z"),
      nextFundingTime: Date.parse("2026-07-14T20:00:00.000Z"),
      intervalMinutes: 60,
      scheduleVerified: false,
      estimateSource: "perpetualMarkets.nextFundingRate",
      timestampSource: "local-receive",
      settledRate: -0.00006175,
      sourceErrors: []
    });
    expect(result.history).toEqual([
      expect.objectContaining({
        effectiveAtHeight: 97679500,
        fundingRate: -0.00006625,
        realizedRate: -0.00006625,
        price: 64545.82264
      }),
      expect.objectContaining({
        effectiveAtHeight: 97681911,
        fundingRate: -0.00006175,
        realizedRate: -0.00006175,
        price: 64585.16593
      })
    ]);
    expect(requests.map((url) => `${url.pathname}${url.search}`)).toEqual(expect.arrayContaining(["/v4/perpetualMarkets", "/v4/historicalFunding/BTC-USD?limit=2"]));
  });

  it("retains a current estimate when bounded history is temporarily unavailable", async () => {
    const result = await adapter({
      "/v4/perpetualMarkets": MARKETS,
      "/v4/historicalFunding/BTC-USD?limit=24": { status: 503, body: {} }
    }).funding("BTC-USD");

    expect(result.currentEstimateRate).toBe(-0.00004525);
    expect(result.history).toEqual([]);
    expect(result.sourceErrors[0]).toContain("HTTP 503");
  });

  it("enforces bounded transport, cancellation, timeout and rate-limit errors", async () => {
    await expect(adapter({ "/v4/perpetualMarkets": { status: 429, body: {} } }).instruments("perpetual")).rejects.toMatchObject({ kind: "rate-limit", status: 429 });

    const controller = new AbortController();
    controller.abort();
    await expect(adapter({}).instruments("perpetual", controller.signal)).rejects.toMatchObject({
      kind: "cancelled"
    });

    const timeoutClient = new DydxPublicAdapter({
      timeoutMs: 1,
      now: () => NOW,
      fetch: ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true
          });
        })) as typeof fetch
    });
    await expect(timeoutClient.instruments("perpetual")).rejects.toMatchObject({ kind: "timeout" });

    const oversized = new DydxPublicAdapter({
      maxPayloadBytes: 1_024,
      now: () => NOW,
      fetch: (async () => new Response(JSON.stringify({ markets: { padding: "x".repeat(2_000) } }), { status: 200 })) as typeof fetch
    });
    await expect(oversized.instruments("perpetual")).rejects.toThrow(/exceeds 1024 bytes/i);
  });

  it("rejects unsafe origins and never accepts an origin path or embedded credentials", () => {
    expect(() => new DydxIndexerTransport({ baseUrl: "https://user:pass@example.com" })).toThrow(/without credentials/i);
    expect(() => new DydxIndexerTransport({ baseUrl: "https://example.com/private" })).toThrow(/without credentials, path/i);
    expect(() => new DydxIndexerTransport({ baseUrl: "file:///tmp/indexer" })).toThrow(/HTTP or HTTPS/i);
  });
});

describe("dYdX Indexer order-book logical sequencing", () => {
  it("strictly decodes official snake-case unbatched envelopes", () => {
    expect(INDEXER_SNAPSHOT).toMatchObject({
      type: "subscribed",
      connectionId: "conn-a",
      instrumentId: "BTC-USD",
      messageId: 10
    });
    expect(() =>
      decodeDydxIndexerBookMessage({
        type: "channel_data",
        connection_id: "conn-a",
        channel: "v4_trades",
        id: "BTC-USD",
        message_id: 11,
        contents: { bids: [] }
      })
    ).toThrow(/channel must be v4_orderbook/i);
    expect(() =>
      decodeDydxIndexerBookMessage({
        type: "channel_data",
        connection_id: "conn-a",
        channel: "v4_orderbook",
        id: "BTC-USD",
        message_id: 11,
        contents: [{ bids: [] }]
      })
    ).toThrow(/contents must be an object/i);
  });

  it("requires a snapshot, verifies contiguous message IDs and uncrosses only as research data", () => {
    const reconciler = new DydxIndexerBookReconciler("BTC-USD");

    expect(reconciler.snapshot()).toMatchObject({
      status: "awaiting-snapshot",
      sequenceVerified: false,
      canonical: false,
      routeReady: false
    });
    const initial = reconciler.apply(INDEXER_SNAPSHOT);
    expect(initial).toMatchObject({
      status: "ready",
      lastMessageId: 10,
      sequenceVerified: true,
      rawCrossed: false
    });
    const crossed = reconciler.apply(INDEXER_UPDATES[0]!);
    expect(crossed).toMatchObject({
      lastMessageId: 11,
      rawCrossed: true,
      uncrossed: true,
      canonical: false,
      routeReady: false,
      executionStatus: "research-only"
    });
    expect(crossed.bids[0]).toEqual([102, 1.5, "11"]);
    // The older ask at 101 is removed from the presentation by logical offset.
    expect(crossed.asks[0]).toEqual([103, 3, "9"]);
    const next = reconciler.apply(INDEXER_UPDATES[1]!);
    expect(next.lastMessageId).toBe(12);
    expect(next.bids.some(([price]) => price === 100)).toBe(false);
  });

  it("invalidates gaps, connection changes and over-capacity updates until a new snapshot", () => {
    const reconciler = new DydxIndexerBookReconciler("BTC-USD", {
      maxLevelsPerSide: 3,
      maxUpdatesPerMessage: 2
    });
    reconciler.apply(INDEXER_SNAPSHOT);

    expect(() =>
      reconciler.apply({
        type: "channel_data",
        connectionId: "conn-a",
        instrumentId: "BTC-USD",
        messageId: 12,
        bids: [["98", "1", "12"]]
      })
    ).toThrow(/message-id gap/i);
    expect(reconciler.snapshot()).toMatchObject({ status: "invalidated", sequenceVerified: false });
    expect(() => reconciler.apply(INDEXER_UPDATES[0]!)).toThrow(/before a valid subscribed snapshot/i);

    expect(reconciler.apply({ ...INDEXER_SNAPSHOT, connectionId: "conn-b", messageId: 20 })).toMatchObject({
      status: "ready",
      connectionId: "conn-b",
      lastMessageId: 20
    });
    expect(() =>
      reconciler.apply({
        type: "channel_data",
        connectionId: "conn-a",
        instrumentId: "BTC-USD",
        messageId: 21,
        bids: [["98", "1", "21"]]
      })
    ).toThrow(/connection changed/i);
  });

  it("applies equal-offset uncrossing by quantity without mutating raw sequence semantics", () => {
    const reconciler = new DydxIndexerBookReconciler("BTC-USD");
    const view = reconciler.apply({
      type: "subscribed",
      connectionId: "equal-offset",
      instrumentId: "BTC-USD",
      messageId: 1,
      bids: [{ price: "101", size: "3", offset: "1" }],
      asks: [
        { price: "100", size: "1", offset: "1" },
        { price: "102", size: "4", offset: "1" }
      ]
    });

    expect(view.rawCrossed).toBe(true);
    expect(view.bids[0]).toEqual([101, 2, "1"]);
    expect(view.asks[0]).toEqual([102, 4, "1"]);
  });
});

describe("dYdX decoded full-node finality reducer", () => {
  it("discards pre-snapshot updates and separates optimistic from finalized checkpoints", () => {
    const reconciler = new DydxNodeBookReconciler(0);
    expect(reconciler.apply({ blockHeight: 99, execMode: 0, snapshot: false, operations: [] })).toMatchObject({ status: "awaiting-snapshot", orderCount: 0 });

    const snapshot = reconciler.apply(NODE_BATCHES[0]!);
    expect(snapshot).toMatchObject({ status: "optimistic", blockHeight: 100, execMode: 102, routeReady: false });
    expect(snapshot.bids).toEqual([[100, 10, 1]]);

    const optimistic = reconciler.apply(NODE_BATCHES[1]!);
    expect(optimistic).toMatchObject({ status: "optimistic", blockHeight: 101, execMode: 0 });
    expect(optimistic.bids).toEqual([[100, 6, 1]]);

    const finalized = reconciler.apply(NODE_BATCHES[2]!);
    expect(finalized).toMatchObject({
      status: "finalized",
      blockHeight: 101,
      finalizedHeight: 101,
      execMode: 7,
      routeReady: false
    });
    expect(finalized.bids).toEqual([[100, 8, 1]]);

    const laterOptimistic = reconciler.apply(NODE_BATCHES[3]!);
    expect(laterOptimistic.status).toBe("optimistic");
    expect(laterOptimistic.asks).toEqual([[103, 8, 1]]);
    const reverted = reconciler.revertOptimistic();
    expect(reverted).toMatchObject({ status: "finalized", blockHeight: 101, finalizedHeight: 101 });
    expect(reverted.asks).toEqual([[101, 12, 1]]);
  });

  it("fails closed on finalized-height regression, unknown orders and unsafe uint64 values", () => {
    const reconciler = new DydxNodeBookReconciler(0);
    reconciler.apply(NODE_BATCHES[0]!);
    reconciler.apply(NODE_BATCHES[2]!);

    expect(() => reconciler.apply({ blockHeight: 100, execMode: 7, snapshot: false, operations: [] })).toThrow(/regressed below finalized height/i);
    expect(reconciler.snapshot().status).toBe("invalidated");
    expect(() =>
      reconciler.apply({
        blockHeight: 102,
        execMode: 0,
        snapshot: false,
        operations: [{ kind: "remove", orderId: "missing" }]
      })
    ).toThrow(/new full-node snapshot is required/i);

    const recovered = reconciler.apply({ ...NODE_BATCHES[0]!, blockHeight: 102 });
    expect(recovered.status).toBe("optimistic");
    expect(() =>
      reconciler.apply({
        blockHeight: 103,
        execMode: 0,
        snapshot: false,
        operations: [{ kind: "fill", orderId: "bid-1", totalFilledQuantums: Number.MAX_SAFE_INTEGER }]
      })
    ).toThrow(/exceeds initial quantums/i);
  });

  it("enforces pair identity and configured operation/order bounds", () => {
    const pairMismatch = structuredClone(NODE_BATCHES[0]!);
    const place = pairMismatch.operations[0];
    if (place?.kind === "place") place.order.clobPairId = 7;
    expect(() => new DydxNodeBookReconciler(0).apply(pairMismatch)).toThrow(/unexpected clobPairId/i);

    const bounded = new DydxNodeBookReconciler(0, { maxOrders: 1, maxOperationsPerBatch: 1 });
    expect(() => bounded.apply(NODE_BATCHES[0]!)).toThrow(/exceeds 1 operations/i);
  });
});

type Route = unknown | { status: number; body: unknown };

function adapter(
  routes: Record<string, Route>,
  options: {
    network?: "mainnet" | "testnet";
    onRequest?: (url: string, init?: RequestInit) => void;
  } = {}
) {
  return new DydxPublicAdapter({
    network: options.network,
    now: () => NOW,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      options.onRequest?.(url.toString(), init);
      const key = `${url.pathname}${url.search}`;
      const route = routes[key];
      if (route === undefined) return new Response(JSON.stringify({ error: `missing fixture ${key}` }), { status: 404 });
      if (isStatusRoute(route)) return jsonResponse(route.body, route.status);
      return jsonResponse(route);
    }) as typeof fetch
  });
}

function isStatusRoute(value: Route): value is { status: number; body: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "status" in value && "body" in value);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/dydx/${name}`, import.meta.url), "utf8")) as T;
}
