import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseVenueClockHealth } from "./clockHealth.js";

function source(sourceId: string) {
  return {
    sourceId,
    status: "calibrated",
    evaluatedAt: 10_000,
    sampleCount: 3,
    consistentSampleCount: 3,
    sampledAt: 9_990,
    expiresAt: 20_000,
    roundTripMs: 10,
    minimumObservedRoundTripMs: 8,
    offsetLowerMs: -4,
    offsetUpperMs: 6,
    offsetMidpointMs: 1,
    uncertaintyMs: 5,
    rejectedProbes: 0,
    ok: true,
    endpoint: `https://${sourceId.split(":")[0]}.example/time`
  };
}

function fixture() {
  return { schemaVersion: 1, updatedAt: 10_000, stale: false, sources: [source("binance:public"), source("bybit:public")] };
}

describe("venue clock health SDK", () => {
  it("parses a coherent calibrated response", () => {
    expect(parseVenueClockHealth(fixture())).toEqual(fixture());
  });

  it("rejects forged aggregate health and timing arithmetic", () => {
    expect(() => parseVenueClockHealth({ ...fixture(), stale: true })).toThrow(/stale flag/);
    const midpoint = structuredClone(fixture());
    midpoint.sources[0]!.offsetMidpointMs = 2;
    expect(() => parseVenueClockHealth(midpoint)).toThrow(/offsetMidpointMs/);
    const evaluatedAt = structuredClone(fixture());
    evaluatedAt.sources[0]!.evaluatedAt = 9_999;
    expect(() => parseVenueClockHealth(evaluatedAt)).toThrow(/must match updatedAt/);
  });

  it("requires unavailable sources to omit invented calibration", () => {
    const unavailable = fixture();
    unavailable.sources = [{
      sourceId: "binance:public",
      status: "unavailable",
      evaluatedAt: 10_000,
      sampleCount: 0,
      consistentSampleCount: 0,
      rejectedProbes: 1,
      reason: "no-samples",
      ok: false,
      endpoint: "https://binance.example/time"
    } as ReturnType<typeof source>];
    unavailable.stale = true;
    expect(parseVenueClockHealth(unavailable).sources[0]).toMatchObject({ status: "unavailable", reason: "no-samples" });
    (unavailable.sources[0] as ReturnType<typeof source>).offsetMidpointMs = 0;
    expect(() => parseVenueClockHealth(unavailable)).toThrow(/contains calibrated timing fields/);
  });

  it("fetches the public read-only clock-health endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher });
    await expect(client.clockHealth()).resolves.toEqual(fixture());
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://scanner.example/api/arbitrage/clock-health");
  });
});
