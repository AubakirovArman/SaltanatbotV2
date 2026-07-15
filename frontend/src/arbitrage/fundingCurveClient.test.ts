// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFundingCurveUniverse } from "./fundingCurveClient";

const NOW = 1_800_000_000_000;

afterEach(() => vi.unstubAllGlobals());

describe("funding curve browser universe transport", () => {
  it("uses only the server-owned universe endpoint and preserves its strict contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage/funding-curve/universe");
      expect(url.pathname).not.toBe("/api/instruments");
      expect(url.pathname).not.toBe("/api/venues");
      expect(init?.method).toBe("GET");
      return Response.json(universe());
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFundingCurveUniverse()).resolves.toMatchObject({
      contract: { owner: "server", execution: "none" },
      supportedVenues: ["gate"],
      instruments: [{ venue: "gate", marketType: "perpetual" }]
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an executable or unsupported server response", async () => {
    const forged = universe();
    forged.executable = true as false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(forged))
    );
    await expect(fetchFundingCurveUniverse()).rejects.toThrow(/executable/);

    const unsupported = universe();
    unsupported.instruments[0]!.venue = "binance";
    unsupported.instruments[0]!.id = "binance:perpetual:BTCUSDT";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(unsupported))
    );
    await expect(fetchFundingCurveUniverse()).rejects.toThrow(/not supported/);
  });
});

function universe() {
  return {
    engine: "funding-curve-universe-v1" as const,
    readOnly: true as const,
    researchOnly: true as const,
    executable: false as const,
    updatedAt: NOW,
    stale: false,
    contract: {
      owner: "server" as const,
      adapterRegistry: "publicVenueAdapters" as const,
      instruments: "fresh-verified-trading-perpetuals" as const,
      execution: "none" as const
    },
    economicIdentityCatalog: {
      schemaVersion: 1 as const,
      source: "browser fixture",
      version: "fixture-v1",
      asOf: NOW - 1,
      validUntil: NOW + 1
    },
    supportedVenues: ["gate"],
    total: 1,
    truncated: false,
    instruments: [
      {
        id: "gate:perpetual:BTC_USDT",
        assetId: "BTC",
        economicAssetId: "crypto:bitcoin",
        venue: "gate",
        venueSymbol: "BTC_USDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        settleAsset: "USDT",
        marketType: "perpetual" as const,
        contractDirection: "linear" as const,
        contractMultiplier: 1,
        quantityUnit: "base" as const,
        tickSize: 0.1,
        quantityStep: 0.001,
        minimumQuantity: 0.001,
        minimumNotional: 1,
        status: "trading" as const,
        fundingIntervalMinutes: 480
      }
    ],
    sourceErrors: [] as string[]
  };
}
