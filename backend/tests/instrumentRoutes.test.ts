import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import express from "express";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createInstrumentRegistryHandler } from "../src/market/instrumentRoutes.js";

describe("instrument registry HTTP freshness", () => {
  it("defaults to verified rows and exposes retained stale rows only by explicit opt-in", async () => {
    const fresh = instrument("binance", "spot", "BTCUSDT");
    const retained = instrument("okx", "perpetual", "BTC-USDT-SWAP");
    const handler = createInstrumentRegistryHandler({
      snapshot: async () => ({
        updatedAt: 20_050,
        instruments: [fresh, retained],
        verifiedInstruments: [fresh],
        capabilities: [],
        sourceErrors: ["OKX swap: temporary outage"],
        sourceStates: [
          { source: "binance:spot", status: "fresh", receivedAt: 20_050, checkedAt: 20_050, ageMs: 0 },
          { source: "okx:swap", status: "stale-cache", receivedAt: 20_000, checkedAt: 20_050, ageMs: 50, message: "temporary outage" }
        ]
      })
    });
    const app = express();
    app.get("/api/instruments", handler);
    const server = await listen(app);
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/instruments`;
    try {
      const current = await fetch(url);
      const currentBody = (await current.json()) as RegistryBody;
      expect(current.status).toBe(200);
      expect(current.headers.get("cache-control")).toBe("public, max-age=60");
      expect(currentBody).toMatchObject({ checkedAt: 20_050, stale: true, includeStale: false, total: 1, sourceErrors: ["OKX swap: temporary outage"] });
      expect(currentBody.instruments.map((row) => row.id)).toEqual([fresh.id]);
      expect(currentBody.sourceStates[1]).toMatchObject({ source: "okx:swap", status: "stale-cache", receivedAt: 20_000, checkedAt: 20_050, ageMs: 50 });

      const catalog = await fetch(`${url}?includeStale=true`);
      const catalogBody = (await catalog.json()) as RegistryBody;
      expect(catalogBody).toMatchObject({ stale: true, includeStale: true, total: 2 });
      expect(catalogBody.instruments.map((row) => row.id)).toEqual([fresh.id, retained.id]);
      expect((await fetch(`${url}?includeStale=yes`)).status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

interface RegistryBody {
  checkedAt: number;
  stale: boolean;
  includeStale: boolean;
  total: number;
  instruments: RegistryInstrument[];
  sourceErrors: string[];
  sourceStates: Array<{ source: string; status: string; receivedAt?: number; checkedAt: number; ageMs?: number }>;
}

function instrument(venue: string, marketType: "spot" | "perpetual", venueSymbol: string): RegistryInstrument {
  return {
    id: `${venue}:${marketType}:${venueSymbol}`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading"
  };
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}
