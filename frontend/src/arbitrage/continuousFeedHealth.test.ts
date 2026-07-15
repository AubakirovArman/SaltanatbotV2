import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchContinuousFeedHealth } from "./continuousFeedHealth";

afterEach(() => vi.unstubAllGlobals());

describe("continuous feed health browser client", () => {
  it("loads and strictly parses the same-origin read-only endpoint", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/arbitrage/continuous-feed-health");
      expect(init?.headers).toEqual({ Accept: "application/json" });
      return json(idleFixture());
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(fetchContinuousFeedHealth()).resolves.toMatchObject({ state: "idle", executable: false, sources: [] });
  });

  it("preserves bounded public API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "feed health unavailable" }, 503))
    );
    await expect(fetchContinuousFeedHealth()).rejects.toThrow("feed health unavailable");
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function idleFixture() {
  return {
    schemaVersion: 1,
    engine: "continuous-feed-health-v1",
    readOnly: true,
    dataScope: "public-market-data",
    credentialsRequired: false,
    secretsIncluded: false,
    executionStatus: "not-supported",
    executable: false,
    capturedAt: 10_000,
    maxReceiveAgeMs: 10_000,
    state: "idle",
    counts: { streams: 0, healthy: 0, reconnecting: 0, bookContinuityReady: 0 },
    sources: []
  };
}
