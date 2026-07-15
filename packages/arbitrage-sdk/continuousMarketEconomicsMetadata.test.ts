import { describe, expect, it } from "vitest";
import { parseContinuousMarketBooks } from "./continuousMarketEconomicsMetadata.js";

describe("continuous market metadata continuity protocols", () => {
  it("accepts both strict MEXC version proofs and rejects unregistered names", () => {
    for (const protocol of ["mexc-spot-version", "mexc-futures-version"] as const) {
      expect(parseContinuousMarketBooks([book(protocol)], "books").get("mexc:spot:BTCUSDT")?.continuity).toEqual({
        kind: "sequence-verified",
        sequence: 1_003,
        protocol
      });
    }
    expect(() => parseContinuousMarketBooks([book("mexc-version-unverified")], "books")).toThrow(/books\[0\]\.continuity\.protocol/);
  });
});

function book(protocol: string) {
  return {
    venue: "mexc",
    instrumentId: "mexc:spot:BTCUSDT",
    marketType: "spot",
    quantityUnit: "base",
    bid: 100,
    bidSize: 2,
    ask: 101,
    askSize: 3,
    exchangeTs: 1_784_023_200_000,
    receivedAt: 1_784_023_200_010,
    connectionGeneration: 2,
    continuity: { kind: "sequence-verified", sequence: 1_003, protocol }
  };
}
