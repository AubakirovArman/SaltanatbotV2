import { describe, expect, it } from "vitest";
import { parseVenueClockHealth } from "./clockHealth";

const calibrated = {
  sourceId: "binance:public",
  status: "calibrated",
  evaluatedAt: 10_000,
  sampleCount: 3,
  consistentSampleCount: 3,
  sampledAt: 9_990,
  expiresAt: 20_000,
  roundTripMs: 10,
  offsetMidpointMs: 2,
  uncertaintyMs: 5,
  rejectedProbes: 0,
  ok: true
};

describe("venue clock health browser contract", () => {
  it("accepts calibrated source diagnostics", () => {
    const value = { schemaVersion: 1, updatedAt: 10_000, stale: false, sources: [calibrated] };
    expect(parseVenueClockHealth(value)).toEqual(value);
  });

  it("rejects stale/source contradictions and invented unavailable timing", () => {
    expect(() => parseVenueClockHealth({ schemaVersion: 1, updatedAt: 10_000, stale: true, sources: [calibrated] })).toThrow(/stale flag/);
    expect(() =>
      parseVenueClockHealth({
        schemaVersion: 1,
        updatedAt: 10_000,
        stale: true,
        sources: [{ ...calibrated, status: "unavailable", sampleCount: 0, consistentSampleCount: 0, reason: "no-samples", ok: false }]
      })
    ).toThrow(/invented timing/);
  });

  it("requires source timestamps to match their envelope", () => {
    expect(() => parseVenueClockHealth({ schemaVersion: 1, updatedAt: 10_001, stale: false, sources: [calibrated] })).toThrow(/must match updatedAt/);
  });
});
