import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { continuousFeedHealthSnapshot, createContinuousFeedHealthHandler } from "../src/arbitrage/upstream/publicFeeds/health.js";
import { ContinuousPublicFeedHub } from "../src/arbitrage/upstream/publicFeeds/hub.js";
import type { BookContinuityProof, ContinuousFeedCallbacks, ContinuousFeedSnapshot, ContinuousPublicVenue } from "../src/arbitrage/upstream/publicFeeds/types.js";

const NOW = 1_784_000_000_500;
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("continuous public-feed health", () => {
  it("publishes bounded continuity, generation, reconnect, and last-receive evidence without status secrets", () => {
    const snapshots = [
      snapshot("okx", "okx:spot:BTC-USDT", 3, "live", { kind: "sequence-verified", protocol: "okx-seqid", sequence: 42 }, 3, NOW - 50, "apiKey=must-not-cross-the-boundary"),
      snapshot("kraken", "kraken:spot:BTC/USD", 4, "reconnecting", { kind: "checksum-verified", protocol: "kraken-spot-crc32", sequence: 9, checksum: 0xf00d }, 3, NOW - 75)
    ];

    const result = continuousFeedHealthSnapshot({ snapshots: () => snapshots }, { now: () => NOW, maxReceiveAgeMs: 1_000 });

    expect(result).toMatchObject({
      readOnly: true,
      dataScope: "public-market-data",
      secretsIncluded: false,
      executable: false,
      state: "degraded",
      counts: { streams: 2, healthy: 1, reconnecting: 1, bookContinuityReady: 1 },
      sources: [
        {
          instrumentId: "kraken:spot:BTC/USD",
          generation: 4,
          reconnect: { scheduled: true, observedConnectionRestarts: 3 },
          lastReceive: { at: NOW - 75, ageMs: 75, connectionGeneration: 3, currentGeneration: false, fresh: false },
          continuity: { kind: "checksum-verified", sequence: 9, checksum: 0xf00d, receivedAt: NOW - 75, ageMs: 75, fresh: false, connectionGeneration: 3, generationMatches: false },
          bookContinuityReady: false
        },
        {
          instrumentId: "okx:spot:BTC-USDT",
          generation: 3,
          reconnect: { scheduled: false, observedConnectionRestarts: 2 },
          lastReceive: { at: NOW - 50, ageMs: 50, connectionGeneration: 3, currentGeneration: true, fresh: true },
          continuity: { kind: "sequence-verified", sequence: 42, receivedAt: NOW - 50, ageMs: 50, fresh: true, connectionGeneration: 3, generationMatches: true },
          bookContinuityReady: true
        }
      ]
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-not-cross-the-boundary");
    expect(serialized).not.toContain("venueSymbol");
    expect(serialized).not.toContain('"bids"');
    expect(serialized).not.toContain('"asks"');
  });

  it("exposes an idle no-store endpoint when no operator streams exist", async () => {
    const app = express();
    app.get("/health", createContinuousFeedHealthHandler({ snapshots: () => [] }, { now: () => NOW }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ state: "idle", maxReceiveAgeMs: 10_000, counts: { streams: 0, healthy: 0, reconnecting: 0, bookContinuityReady: 0 }, sources: [] });
  });

  it("retains bounded last-receive and book proof diagnostics across invalidation/reconnect", () => {
    let callbacks: ContinuousFeedCallbacks | undefined;
    const value = snapshot("okx", "okx:spot:BTC-USDT", 1, "live", { kind: "sequence-verified", protocol: "okx-seqid", sequence: 42 }, 1, NOW - 50);
    const hub = new ContinuousPublicFeedHub({
      now: () => NOW,
      feedFactory: (_instrument, next) => {
        callbacks = next;
        return { start: () => undefined, close: () => undefined };
      }
    });
    const subscription = hub.subscribe(value.instrument, {});
    callbacks?.onBook(value.book!);
    callbacks?.onInvalidate("sequence gap");
    callbacks?.onStatus({ venue: "okx", instrumentId: value.instrument.instrumentId, state: "reconnecting", message: "retry", generation: 2 });

    const result = continuousFeedHealthSnapshot(hub, { now: () => NOW });

    expect(result.sources[0]).toMatchObject({
      state: "reconnecting",
      hasBook: false,
      lastReceive: { at: NOW - 50, connectionGeneration: 1, currentGeneration: false, fresh: false },
      continuity: { kind: "sequence-verified", sequence: 42, receivedAt: NOW - 50, connectionGeneration: 1, generationMatches: false, fresh: false },
      bookContinuityReady: false
    });
    subscription.close();
    hub.close();
  });

  it("never calls an older-than-policy book protocol-ready", () => {
    const stale = snapshot("okx", "okx:spot:BTC-USDT", 1, "live", { kind: "sequence-verified", protocol: "okx-seqid", sequence: 42 }, 1, NOW - 10_001);
    const result = continuousFeedHealthSnapshot({ snapshots: () => [stale] }, { now: () => NOW });

    expect(result.sources[0]).toMatchObject({ health: "unhealthy", continuity: { ageMs: 10_001, fresh: false }, bookContinuityReady: false });
    expect(result.counts.bookContinuityReady).toBe(0);
  });

  it("fails closed with a generic response when internal proof violates the wire schema", async () => {
    const malformed = snapshot("okx", "okx:spot:BTC-USDT", 1, "live", { kind: "sequence-verified", protocol: "okx-seqid", sequence: 0 }, 1, NOW - 10, "private-token-value");
    const app = express();
    app.get("/health", createContinuousFeedHealthHandler({ snapshots: () => [malformed] }, { now: () => NOW }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/health`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("Continuous public feed health unavailable");
    expect(body).not.toContain("private-token-value");
  });
});

function snapshot(venue: ContinuousPublicVenue, instrumentId: string, statusGeneration: number, state: ContinuousFeedSnapshot["status"]["state"], continuity: BookContinuityProof, bookGeneration: number, receivedAt: number, message = "public feed status"): ContinuousFeedSnapshot {
  const venueSymbol = instrumentId.split(":").at(-1) ?? "BTC-USDT";
  return {
    instrument: { venue, instrumentId, venueSymbol, marketType: "spot", quantityUnit: "base" },
    status: { venue, instrumentId, state, message, generation: statusGeneration },
    book: {
      venue,
      instrumentId,
      venueSymbol,
      marketType: "spot",
      quantityUnit: "base",
      bids: [[100, 2]],
      asks: [[101, 3]],
      exchangeTs: receivedAt - 1,
      receivedAt,
      complete: true,
      continuity,
      source: "public-websocket",
      connectionGeneration: bookGeneration,
      retainedDepth: 1
    }
  };
}
