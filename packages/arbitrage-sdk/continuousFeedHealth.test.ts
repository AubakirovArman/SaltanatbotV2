import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient, parseContinuousFeedHealthResponse, type ContinuousFeedHealthResponse } from "./index.js";

describe("continuous feed health SDK contract", () => {
  it("parses the strict read-only health envelope and continuity evidence", () => {
    expect(parseContinuousFeedHealthResponse(fixture())).toMatchObject({
      state: "healthy",
      counts: { streams: 1, healthy: 1, reconnecting: 0, bookContinuityReady: 1 },
      sources: [
        {
          generation: 2,
          reconnect: { scheduled: false, observedConnectionRestarts: 1 },
          lastReceive: { at: 9_950, ageMs: 50, connectionGeneration: 2, currentGeneration: true, fresh: true },
          continuity: { kind: "checksum-verified", protocol: "kraken-spot-crc32", sequence: 8, checksum: 123, receivedAt: 9_950, ageMs: 50, fresh: true, generationMatches: true },
          bookContinuityReady: true
        }
      ]
    });
  });

  it("rejects extra secret-shaped fields and inconsistent derived health", () => {
    const extra = fixture() as ReturnType<typeof fixture> & { apiKey?: string };
    extra.apiKey = "forbidden";
    expect(() => parseContinuousFeedHealthResponse(extra)).toThrow(/unsupported fields/);

    const badAge = fixture();
    badAge.sources[0]!.lastReceive.ageMs = 49;
    expect(() => parseContinuousFeedHealthResponse(badAge)).toThrow(/ageMs/);

    const forgedReady = fixture();
    forgedReady.sources[0]!.bookContinuityReady = false;
    expect(() => parseContinuousFeedHealthResponse(forgedReady)).toThrow(/bookContinuityReady/);

    const staleBookClaim = fixture();
    staleBookClaim.maxReceiveAgeMs = 100;
    staleBookClaim.sources[0]!.continuity.receivedAt = 9_899;
    staleBookClaim.sources[0]!.continuity.ageMs = 101;
    staleBookClaim.sources[0]!.continuity.fresh = false;
    expect(() => parseContinuousFeedHealthResponse(staleBookClaim)).toThrow(/bookContinuityReady/);

    const forgedGeneration = fixture();
    forgedGeneration.sources[0]!.continuity.generationMatches = false;
    expect(() => parseContinuousFeedHealthResponse(forgedGeneration)).toThrow(/generationMatches/);

    const forgedLastReceiveGeneration = fixture();
    forgedLastReceiveGeneration.sources[0]!.lastReceive.connectionGeneration = 1;
    expect(() => parseContinuousFeedHealthResponse(forgedLastReceiveGeneration)).toThrow(/currentGeneration/);

    const badCounts = fixture();
    badCounts.counts.healthy = 0;
    expect(() => parseContinuousFeedHealthResponse(badCounts)).toThrow(/counts/);
  });

  it("accepts historical receive/proof evidence during a fail-closed reconnect", () => {
    const reconnecting = structuredClone(fixture()) as ContinuousFeedHealthResponse;
    reconnecting.state = "degraded";
    reconnecting.counts = { streams: 1, healthy: 0, reconnecting: 1, bookContinuityReady: 0 };
    const source = reconnecting.sources[0]!;
    source.state = "reconnecting";
    source.health = "degraded";
    source.generation = 3;
    source.reconnect = { scheduled: true, observedConnectionRestarts: 2 };
    source.lastReceive!.currentGeneration = false;
    source.lastReceive!.fresh = false;
    source.continuity!.generationMatches = false;
    source.continuity!.fresh = false;
    source.hasBook = false;
    source.hasTopBook = false;
    source.bookContinuityReady = false;

    expect(parseContinuousFeedHealthResponse(reconnecting).sources[0]).toMatchObject({
      state: "reconnecting",
      hasBook: false,
      lastReceive: { connectionGeneration: 2, currentGeneration: false },
      continuity: { connectionGeneration: 2, generationMatches: false },
      bookContinuityReady: false
    });
  });

  it("uses the bounded public client endpoint and exposes no execution method", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/arbitrage/continuous-feed-health");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify(fixture()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher as typeof fetch });

    await expect(client.continuousFeedHealth()).resolves.toMatchObject({ state: "healthy", executable: false });
    expect("restartContinuousFeed" in client).toBe(false);
    expect("placeOrder" in client).toBe(false);
  });
});

function fixture() {
  return {
    schemaVersion: 1 as const,
    engine: "continuous-feed-health-v1" as const,
    readOnly: true as const,
    dataScope: "public-market-data" as const,
    credentialsRequired: false as const,
    secretsIncluded: false as const,
    executionStatus: "not-supported" as const,
    executable: false as const,
    capturedAt: 10_000,
    maxReceiveAgeMs: 1_000,
    state: "healthy" as const,
    counts: { streams: 1, healthy: 1, reconnecting: 0, bookContinuityReady: 1 },
    sources: [
      {
        venue: "kraken" as const,
        instrumentId: "kraken:spot:BTC/USD",
        marketType: "spot" as const,
        state: "live" as const,
        health: "healthy" as const,
        generation: 2,
        reconnect: { scheduled: false, observedConnectionRestarts: 1 },
        lastReceive: { at: 9_950, ageMs: 50, kind: "book" as const, connectionGeneration: 2, currentGeneration: true, fresh: true },
        continuity: { kind: "checksum-verified" as const, protocol: "kraken-spot-crc32" as const, verified: true as const, sequence: 8, checksum: 123, receivedAt: 9_950, ageMs: 50, fresh: true, connectionGeneration: 2, generationMatches: true },
        hasBook: true,
        hasTopBook: true,
        hasFunding: false,
        bookContinuityReady: true
      }
    ]
  };
}
