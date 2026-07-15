import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { ArbitrageDepthService } from "../src/arbitrage/depth.js";
import { UpstreamCircuitOpenError, UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/index.js";

const source = "binance.public-rest";

describe("depth REST resource governor", () => {
  it("shares the venue circuit and rejects recovery work before transport I/O", async () => {
    let now = 1_000;
    const resources = new UpstreamResourceGovernor({ [source]: { maxConcurrent: 2, failureThreshold: 1, cooldownMs: 500 } }, () => now);
    const fetcher = vi.fn(async () => new Response("upstream unavailable", { status: 503 }));
    const service = new ArbitrageDepthService({
      now: () => now,
      fetch: fetcher,
      governor: resources,
      sequenceBooks: false,
      registry: registry()
    });
    const input = { symbol: "BTCUSDT", spotExchange: "binance" as const, futuresExchange: "binance" as const, notionalUsd: 100 };

    await expect(service.analyze(input)).rejects.toThrow(/HTTP 503|circuit is open/);
    const callsAfterFailure = fetcher.mock.calls.length;
    expect(callsAfterFailure).toBeGreaterThanOrEqual(1);
    expect(callsAfterFailure).toBeLessThanOrEqual(2);
    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "open", active: 0, counters: { failed: callsAfterFailure } });

    await expect(service.analyze(input)).rejects.toBeInstanceOf(UpstreamCircuitOpenError);
    expect(fetcher).toHaveBeenCalledTimes(callsAfterFailure);

    now += 500;
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ E: now, lastUpdateId: 1, asks: [["100", "2"]], bids: [["99", "2"]] }), { status: 200 }));
    await expect(service.analyze(input)).rejects.toThrow();
    expect(resources.sourceSnapshot(source).counters.acquired).toBeGreaterThan(callsAfterFailure);
  });
});

function registry() {
  const rows = [instrument("spot"), instrument("perpetual")];
  return { get: async (_venue: string, marketType: string, symbol: string) => rows.find((row) => row.marketType === marketType && row.venueSymbol === symbol) };
}

function instrument(marketType: "spot" | "perpetual"): RegistryInstrument {
  return {
    id: `binance:${marketType}:BTCUSDT`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue: "binance",
    venueSymbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.01,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading"
  };
}
