import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createNLegEvaluationHandler } from "../src/arbitrage/nLegRoutes.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("bounded N-leg research API", () => {
  it("discovers and simulates a non-executable four-leg cycle", async () => {
    const response = await post(fixture());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ engine: "n-leg-v1", readOnly: true, researchOnly: true, executable: false, execution: "none", totalCycles: 2 });
    const opportunities = body.opportunities as Array<Record<string, unknown>>;
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({ strategyKind: "n-leg-cycle", edgeKind: "research-simulation", executable: false, legCount: 4 });
    expect(opportunities[0]).not.toHaveProperty("order");
  });

  it("rejects credential-shaped, oversized and duplicate-book requests", async () => {
    expect((await post({ ...fixture(), apiKey: "forbidden" })).status).toBe(400);
    const oversized = fixture();
    oversized.books[0]!.bids = Array.from({ length: 201 }, (_, index) => [0.99 - index / 10_000, 1]);
    expect((await post(oversized)).status).toBe(400);
    const duplicate = fixture();
    duplicate.books.push(structuredClone(duplicate.books[0]!));
    expect((await post(duplicate)).status).toBe(400);
  });

  it("returns explicit research rejections for unsequenced books", async () => {
    const request = fixture();
    request.books[0]!.sequenceVerified = false;
    const response = await post(request);
    const body = (await response.json()) as { opportunities: unknown[]; rejections: Array<{ code: string }> };

    expect(response.status).toBe(200);
    expect(body.opportunities).toEqual([]);
    expect(body.rejections.some(({ code }) => code === "unsequenced-book")).toBe(true);
  });

  it("is deterministic when caller arrays are reordered", async () => {
    const first = (await (await post(fixture())).json()) as { opportunities: Array<{ id: string }>; rejections: Array<{ cycleId: string; code: string }> };
    const reversed = fixture();
    reversed.markets.reverse();
    reversed.books.reverse();
    const second = (await (await post(reversed)).json()) as typeof first;

    expect(second.opportunities.map(({ id }) => id)).toEqual(first.opportunities.map(({ id }) => id));
    expect(second.rejections.map(({ cycleId, code }) => [cycleId, code])).toEqual(first.rejections.map(({ cycleId, code }) => [cycleId, code]));
  });
});

async function post(body: unknown) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/evaluate", createNLegEvaluationHandler());
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function fixture() {
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
    bids: [[row.instrumentId === "C-USDT" ? 1.2 : 0.99, 1_000]],
    asks: [[row.instrumentId === "C-USDT" ? 1.21 : 1, 1_000]],
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
