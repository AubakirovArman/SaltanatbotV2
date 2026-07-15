import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createRouteFamilyEvaluationHandler } from "../src/arbitrage/routeFamilyRoutes.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("bounded public route-family facade", () => {
  it("returns only research output for an automatically discovered spot/future route", async () => {
    const now = 2_000_000_000_000;
    const { url } = serve(now);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture(now)) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ engine: "route-families-v1", executionStatus: "research-only", executable: false, evaluatedRoutes: 1, totalCompatibleCandidates: 1 });
    expect(body.opportunities).toEqual([expect.objectContaining({ strategyKind: "spot-dated-future", executable: false, edgeKind: "research-simulation" })]);
    expect(body).not.toHaveProperty("order");
    expect(body).not.toHaveProperty("credentials");
    expect(JSON.stringify(body)).not.toMatch(/"executable":true|"executionStatus":"guaranteed"/i);
  });

  it("rejects unknown fields, duplicate scopes and oversized bounded inputs", async () => {
    const now = 2_000_000_000_000;
    const { url } = serve(now);
    const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const unknown = fixture(now) as ReturnType<typeof fixture> & { credentials?: string };
    unknown.credentials = "must-not-be-accepted";
    expect((await post(unknown)).status).toBe(400);

    const duplicate = fixture(now);
    duplicate.assumptions.scopes.push(structuredClone(duplicate.assumptions.scopes[0]!));
    const duplicateResponse = await post(duplicate);
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toMatchObject({ executable: false, executionStatus: "research-only" });

    const oversized = fixture(now);
    oversized.instruments = Array.from({ length: 121 }, (_, index) => ({ ...oversized.instruments[0]!, instrumentId: `x:spot:BTC${index}` }));
    expect((await post(oversized)).status).toBe(400);
  });
});

function serve(now: number) {
  const app = express();
  app.use(express.json());
  app.post("/evaluate", createRouteFamilyEvaluationHandler(() => now));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate` };
}

function fixture(now: number) {
  const expiry = now + 30 * 86_400_000;
  const exitAt = now + 7 * 86_400_000;
  const identity = { status: "reviewed" as const, source: "reviewed-map", version: "2026-07-14", asOf: now - 100, validUntil: expiry };
  const common = { baseAsset: "BTC", economicAssetId: "crypto:bitcoin", economicIdentity: identity, quoteAsset: "USDT", settleAsset: "USDT", quantityModel: { unit: "base" as const }, quantityStep: 0.001, minimumQuantity: 0.001, minimumNotional: 1, takerFeeBps: 1 };
  const instruments = [
    { ...common, instrumentId: "binance:spot:BTCUSDT", venue: "binance", symbol: "BTCUSDT", marketType: "spot" as const },
    { ...common, instrumentId: "binance:future:BTCUSDT-QUARTER", venue: "binance", symbol: "BTCUSDT-QUARTER", marketType: "future" as const, expiryTime: expiry }
  ];
  return {
    instruments,
    books: [
      { instrumentId: instruments[0]!.instrumentId, quantityUnit: "base" as const, bids: [[99, 10]], asks: [[100, 10]], exchangeTs: now - 10, receivedAt: now - 5, complete: true, sequence: 1, source: "fixture" as const, sourceId: "fixture:spot" },
      { instrumentId: instruments[1]!.instrumentId, quantityUnit: "base" as const, bids: [[105, 10]], asks: [[106, 10]], exchangeTs: now - 9, receivedAt: now - 4, complete: true, sequence: 1, source: "fixture" as const, sourceId: "fixture:future" }
    ],
    assumptions: {
      scopes: [
        {
          family: "spot-dated-future" as const,
          longInstrumentId: instruments[0]!.instrumentId,
          shortInstrumentId: instruments[1]!.instrumentId,
          requestedBaseQuantity: 1,
          convergence: { exitAt, expectedExitBasisBps: 0, longExitFeeBps: 1, shortExitFeeBps: 1, source: "stress-convergence", asOf: now - 100 },
          delivery: { mode: "close-before-expiry" as const, exitAt, deliveryFeeBps: 1, source: "close-model", asOf: now - 100 }
        }
      ],
      capital: [{ instrumentId: instruments[0]!.instrumentId, kind: "capital" as const, availableQuoteQuantity: 1_000, availabilityVerified: true as const, source: "verified-capital", asOf: now - 100 }],
      inventory: [],
      borrow: [],
      funding: []
    },
    families: ["spot-dated-future" as const],
    maxRoutes: 10,
    options: { maxQuoteAgeMs: 2_000, maxLegSkewMs: 250, maxFutureClockSkewMs: 1_000, maxAssumptionAgeMs: 86_400_000, maxEconomicIdentityAgeMs: 30 * 86_400_000, maxResidualDeltaBps: 1, pairingIterations: 20 }
  };
}
