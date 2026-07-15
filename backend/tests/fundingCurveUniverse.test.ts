import type { RegistryInstrument, VenueCapabilityManifest } from "@saltanatbotv2/contracts";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "../../packages/arbitrage-sdk/client.js";
import { createFundingCurveUniverseHandler, fundingCurveUniverseResponseSchema } from "../src/arbitrage/fundingCurve/index.js";
import type { InstrumentRegistrySnapshot, InstrumentRegistrySourceState } from "../src/market/instrumentRegistry.js";
import type { PublicVenueAdapter } from "../src/venues/publicTypes.js";

const NOW = Date.UTC(2026, 6, 14, 12);
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("server-owned funding-curve universe", () => {
  it("offers only fresh trading perpetuals supported by the actual funding adapter allowlist", async () => {
    const gate = instrument("gate", "perpetual", "trading");
    const snapshot = registrySnapshot([gate, instrument("binance", "perpetual", "trading"), instrument("bybit", "perpetual", "trading"), instrument("coinbase", "perpetual", "trading"), instrument("gate", "spot", "trading"), instrument("gate", "perpetual", "closed")]);
    snapshot.sourceErrors.push("Binance futures: upstream timeout");
    const response = await get(
      snapshot,
      adapters([
        ["gate", true],
        ["coinbase", false]
      ])
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const payload = await response.json();
    expect(fundingCurveUniverseResponseSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      engine: "funding-curve-universe-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      stale: false,
      supportedVenues: ["gate"],
      total: 1,
      truncated: false,
      instruments: [{ id: gate.id, venue: "gate", marketType: "perpetual", status: "trading" }],
      sourceErrors: []
    });
    expect(JSON.stringify(payload)).not.toMatch(/binance|bybit|coinbase|apiKey|apiSecret/);
  });

  it("reports only supported funding-source degradation and keeps an empty universe accessible", async () => {
    const snapshot = registrySnapshot([]);
    snapshot.sourceErrors.push("Gate perpetual: malformed row", "Binance futures: timeout");
    snapshot.sourceStates = [state("gate:perpetual", "quarantined", "upstream unavailable"), state("binance:derivatives", "quarantined", "timeout")];

    const response = await get(snapshot, adapters([["gate", true]]));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      stale: true,
      supportedVenues: ["gate"],
      total: 0,
      truncated: false,
      instruments: []
    });
    expect(payload.sourceErrors).toEqual(["Gate perpetual: malformed row", "gate:perpetual: upstream unavailable"]);
    expect(JSON.stringify(payload.sourceErrors)).not.toContain("Binance");
  });

  it("fails closed when adapter identity or instrument shape violates the public contract", async () => {
    const mismatched = adapters([["gate", true]]);
    mismatched.set("alias", adapter("gate", true));
    const identityResponse = await get(registrySnapshot([]), mismatched);
    expect(identityResponse.status).toBe(503);
    await expect(identityResponse.json()).resolves.toMatchObject({
      readOnly: true,
      researchOnly: true,
      executable: false
    });

    const leaked = { ...instrument("gate", "perpetual", "trading"), apiSecret: "must-not-cross-boundary" };
    const shapeResponse = await get(registrySnapshot([leaked as RegistryInstrument]), adapters([["gate", true]]));
    expect(shapeResponse.status).toBe(503);
    expect(await shapeResponse.text()).not.toContain("must-not-cross-boundary");
  });

  it("round-trips the mounted GET contract through the strict SDK without credentials", async () => {
    const fetchSpy = vi.fn<typeof fetch>(globalThis.fetch);
    const app = express();
    app.get("/api/arbitrage/funding-curve/universe", createFundingCurveUniverseHandler({ snapshot: async () => registrySnapshot([instrument("gate", "perpetual", "trading")]) }, adapters([["gate", true]])));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const client = new SaltanatArbitrageClient({
      baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
      fetch: fetchSpy
    });

    await expect(client.fundingCurveUniverse()).resolves.toMatchObject({
      contract: { owner: "server", execution: "none" },
      economicIdentityCatalog: { schemaVersion: 1, version: "2026-07-14.v1" },
      supportedVenues: ["gate"],
      instruments: [{ venue: "gate", marketType: "perpetual" }]
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.body).toBeUndefined();
  });
});

function registrySnapshot(verifiedInstruments: RegistryInstrument[]): InstrumentRegistrySnapshot {
  return {
    updatedAt: NOW,
    instruments: verifiedInstruments,
    verifiedInstruments,
    capabilities: [],
    sourceErrors: [],
    sourceStates: []
  };
}

function instrument(venue: string, marketType: RegistryInstrument["marketType"], status: RegistryInstrument["status"]): RegistryInstrument {
  const symbol = marketType === "spot" ? "BTC_USDT_SPOT" : status === "closed" ? "BTC_USDT_OLD" : "BTC_USDT";
  return {
    id: `${venue}:${marketType}:${symbol}`,
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol: symbol,
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
    minimumNotional: 1,
    status,
    ...(marketType === "perpetual" ? { fundingIntervalMinutes: 480 } : {})
  };
}

function adapters(rows: ReadonlyArray<readonly [string, boolean]>) {
  return new Map<string, Pick<PublicVenueAdapter, "venue" | "capabilities">>(rows.map(([venue, funding]) => [venue, adapter(venue, funding)]));
}

function adapter(venue: string, funding: boolean): Pick<PublicVenueAdapter, "venue" | "capabilities"> {
  return {
    venue,
    capabilities: () => capability(venue, funding)
  };
}

function capability(venue: string, funding: boolean): VenueCapabilityManifest {
  return {
    venue,
    publicData: true,
    spot: true,
    margin: false,
    perpetual: true,
    datedFuture: false,
    option: false,
    nativeSpread: false,
    topBook: true,
    depth: true,
    publicTrades: false,
    funding,
    borrow: false,
    depositWithdrawal: false,
    privateExecution: false,
    demoEnvironment: true
  };
}

function state(source: string, status: InstrumentRegistrySourceState["status"], message?: string): InstrumentRegistrySourceState {
  return {
    source,
    status,
    checkedAt: NOW,
    ...(message ? { message } : {})
  };
}

async function get(snapshot: InstrumentRegistrySnapshot, adapterRegistry: ReadonlyMap<string, Pick<PublicVenueAdapter, "venue" | "capabilities">>) {
  const app = express();
  app.get("/universe", createFundingCurveUniverseHandler({ snapshot: async () => snapshot }, adapterRegistry));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/universe`);
}
