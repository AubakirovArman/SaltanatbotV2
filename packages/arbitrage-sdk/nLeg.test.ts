import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNLegEvaluationHandler } from "../../backend/src/arbitrage/nLegRoutes.js";
import { SaltanatArbitrageClient } from "./client.js";
import { parseNLegResearchResponse } from "./nLeg.js";
import type { NLegResearchRequest } from "./nLegTypes.js";

describe("N-leg public SDK", () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/api/arbitrage/n-leg/evaluate", createNLegEvaluationHandler());
  const server = app.listen(0);
  let client: SaltanatArbitrageClient;

  beforeAll(() => {
    const { port } = server.address() as AddressInfo;
    client = new SaltanatArbitrageClient({ baseUrl: `http://127.0.0.1:${port}` });
  });

  afterAll(() => server.close());

  it("calls the bounded endpoint and verifies the complete research envelope", async () => {
    const response = await client.nLeg(fixture());
    expect(response).toMatchObject({ engine: "n-leg-v1", readOnly: true, researchOnly: true, executable: false, execution: "none", totalCycles: 2 });
    expect(response.opportunities).toHaveLength(1);
    expect(response.opportunities[0]).toMatchObject({ legCount: 4, strategyKind: "n-leg-cycle", executable: false });
  });

  it("rejects forged execution fields, arithmetic, provenance and graph totals", async () => {
    const value = await rawResponse(fixture());
    const cases: Array<(candidate: Record<string, any>) => void> = [
      (candidate) => {
        candidate.executable = true;
      },
      (candidate) => {
        candidate.opportunities[0].order = { side: "buy" };
      },
      (candidate) => {
        candidate.opportunities[0].endQuantity += 1;
      },
      (candidate) => {
        candidate.opportunities[0].provenance.instrumentIds.reverse();
      },
      (candidate) => {
        candidate.opportunities[0].timestamps.sequenceVerified = false;
      },
      (candidate) => {
        candidate.totalCycles += 1;
      }
    ];
    for (const mutate of cases) {
      const candidate = structuredClone(value);
      mutate(candidate);
      expect(() => parseNLegResearchResponse(candidate)).toThrow();
    }
  });

  it("keeps credential-shaped input outside the public contract", async () => {
    await expect(client.nLeg({ ...fixture(), apiKey: "forbidden" } as NLegResearchRequest)).rejects.toMatchObject({ status: 400, kind: "http" });
  });

  async function rawResponse(body: NLegResearchRequest) {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/arbitrage/n-leg/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return (await response.json()) as Record<string, any>;
  }
});

function fixture(): NLegResearchRequest {
  const venue = "testex";
  const unit = (assetId: string) => ({ venue, assetId, unitId: "native" });
  const market = (instrumentId: string, baseId: string, quoteId: string) => ({
    instrumentId,
    venue,
    symbol: instrumentId,
    marketType: "spot" as const,
    base: unit(baseId),
    quote: unit(quoteId),
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 0.001,
    buyFee: { scheduleId: `fee:${instrumentId}:buy`, tierId: "vip-0", takerBps: 0, asset: unit(baseId) },
    sellFee: { scheduleId: `fee:${instrumentId}:sell`, tierId: "vip-0", takerBps: 0, asset: unit(quoteId) }
  });
  const markets = [market("A-USDT", "A", "USDT"), market("B-A", "B", "A"), market("C-B", "C", "B"), market("C-USDT", "C", "USDT")];
  const books = markets.map((row) => ({
    instrumentId: row.instrumentId,
    base: row.base,
    quote: row.quote,
    bids: [[row.instrumentId === "C-USDT" ? 1.2 : 0.99, 1_000] as const],
    asks: [[row.instrumentId === "C-USDT" ? 1.21 : 1, 1_000] as const],
    exchangeTs: 9_999,
    exchangeTimestampVerified: true,
    receivedAt: 9_999,
    complete: true,
    sequence: 1,
    sequenceVerified: true,
    sourceId: `fixture:${row.instrumentId}`
  }));
  return {
    evaluatedAt: 10_000,
    requestedStartQuantity: 100,
    startAsset: unit("USDT"),
    markets,
    books,
    graph: { minLegs: 4, maxLegs: 4, maxCycles: 10, maxTraversalSteps: 1_000 },
    limits: { minNetReturnBps: 0, maxQuoteAgeMs: 100, maxLegSkewMs: 10, maxFutureClockSkewMs: 10, depthSearchIterations: 16, maxDepthWalkSteps: 10_000 }
  };
}
