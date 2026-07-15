import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { PaperMultiLegJournal, PaperMultiLegService, createPaperMultiLegRouter, paperMultiLegPlanFromNLeg, paperMultiLegPlanFromRouteFamily, type PaperMultiLegPlan } from "../src/arbitrage/paperMultiLeg/index.js";
import type { NLegOpportunity } from "../src/arbitrage/engines/nLeg/index.js";
import type { PairwiseOpportunity } from "../src/arbitrage/engines/pairwise/index.js";

const NOW = 2_000_000_000_000;
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const journals: PaperMultiLegJournal[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const journal of journals.splice(0)) journal.close();
});

describe("paper multi-leg engine builders", () => {
  it("converts exact N-leg and route-family opportunities without inventing live execution", () => {
    const nLeg = paperMultiLegPlanFromNLeg(nLegOpportunity(), {
      runId: "builder-n-leg-run",
      createdAt: NOW,
      expiresAt: NOW + 30_000,
      scenarios: [{}, { fillRatioBps: 5_000, compensationFillRatioBps: 8_000 }]
    });
    expect(nLeg).toMatchObject({
      source: { kind: "n-leg", engine: "n-leg-v1", opportunityId: "n-leg-opportunity:fixture" },
      executionMode: "paper-sequential-legs",
      simulationPolicy: "explicit-deterministic-fill-ratios-v1"
    });
    expect(nLeg.legs).toHaveLength(4);
    expect(nLeg.legs[1]).toMatchObject({
      instrumentId: "fixture-market-1",
      plannedQuantity: 2,
      paperFillRatioBps: 5_000,
      paperCompensationFillRatioBps: 8_000
    });

    const routeFamily = paperMultiLegPlanFromRouteFamily(routeFamilyOpportunity(), "spot-dated-future", { runId: "builder-route-run", createdAt: NOW, expiresAt: NOW + 30_000 });
    expect(routeFamily.source).toMatchObject({
      kind: "route-family",
      engine: "route-families-v1",
      family: "spot-dated-future"
    });
    expect(routeFamily.legs.map(({ instrumentId, side, quantityUnit }) => [instrumentId, side, quantityUnit])).toEqual([
      ["fixture-spot", "buy", "base"],
      ["fixture-future", "sell", "contract"]
    ]);
    expect(JSON.stringify([nLeg, routeFamily])).not.toMatch(/apiKey|secret|liveOrders|privateRequests/i);

    const forged = { ...nLegOpportunity(), executable: true } as unknown as NLegOpportunity;
    expect(() => paperMultiLegPlanFromNLeg(forged, { runId: "builder-forged-run", createdAt: NOW, expiresAt: NOW + 30_000 })).toThrow("exact non-executable");
  });
});

describe("paper multi-leg HTTP facade", () => {
  it("runs, lists and reads a compensated paper scenario over real HTTP", async () => {
    const { baseUrl } = serve();
    const input = plan("http-partial-run", [10_000, 5_000, 10_000, 10_000]);
    const response = await post(baseUrl, input, "idem-http-partial");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toMatchObject({
      schemaVersion: "paper-multi-leg-api-v1",
      created: true,
      safety: {
        executionMode: "paper-only",
        liveOrders: false,
        privateRequests: false,
        credentialsAccepted: false
      },
      run: { state: { runId: input.runId, status: "compensated" } }
    });
    expect(JSON.stringify(body)).not.toMatch(/idempotencyKey|apiKey|apiSecret|placeOrder|"liveOrders":true/i);

    const recovery = await (await fetch(`${baseUrl}/recovery`)).json();
    expect(recovery).toMatchObject({
      safety: { executionMode: "paper-only", liveOrders: false },
      recovery: { status: "ready", recoveredRuns: 0, startedAt: NOW, completedAt: NOW }
    });
    const list = await (await fetch(`${baseUrl}/runs?limit=10`)).json();
    expect(list).toMatchObject({ runs: [{ runId: input.runId, status: "compensated", legCount: 4 }] });
    const detail = await (await fetch(`${baseUrl}/runs/${input.runId}`)).json();
    expect(detail).toMatchObject({ run: { state: { status: "compensated", lastSequence: 7 } } });
  });

  it("collapses concurrent retries to one journal and rejects conflicting reuse", async () => {
    const { baseUrl } = serve();
    const input = plan("http-concurrent-run", [10_000, 10_000, 10_000, 10_000]);
    const [first, second] = await Promise.all([post(baseUrl, input, "idem-http-concurrent"), post(baseUrl, structuredClone(input), "idem-http-concurrent")]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const bodies = (await Promise.all([first.json(), second.json()])) as Array<{ run: { events: unknown[] } }>;
    expect(bodies[0]!.run.events).toHaveLength(6);
    expect(bodies[1]!.run.events).toEqual(bodies[0]!.run.events);

    const conflict = structuredClone(input);
    conflict.runId = "http-conflict-run";
    const conflictResponse = await post(baseUrl, conflict, "idem-http-concurrent");
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({ error: "paper-idempotency-conflict" });
  });

  it("rejects credentials, unknown fields, missing idempotency and stale plans", async () => {
    const { baseUrl } = serve();
    const input = plan("http-safety-run", [10_000, 10_000, 10_000, 10_000]);
    const credentialPayload = { plan: input, apiKey: "must-not-enter-paper-journal" };
    const credentialResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-http-credential" },
      body: JSON.stringify(credentialPayload)
    });
    expect(credentialResponse.status).toBe(400);
    expect(JSON.stringify(await credentialResponse.json())).not.toContain("must-not-enter-paper-journal");

    expect((await post(baseUrl, input, undefined)).status).toBe(400);
    const expired = structuredClone(input);
    expired.runId = "http-expired-run";
    expired.createdAt = NOW - 120_000;
    expired.expiresAt = NOW - 60_000;
    expired.source.evaluatedAt = expired.createdAt - 10;
    const expiredResponse = await post(baseUrl, expired, "idem-http-expired");
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toMatchObject({ error: "paper-plan-expired" });

    const staleEvidence = structuredClone(input);
    staleEvidence.runId = "http-stale-evidence-run";
    staleEvidence.createdAt = NOW - 59_000;
    staleEvidence.expiresAt = NOW + 1_000;
    staleEvidence.source.evaluatedAt = NOW - 60_001;
    const staleResponse = await post(baseUrl, staleEvidence, "idem-http-stale-evidence");
    expect(staleResponse.status).toBe(410);
  });

  it("returns bounded not-found and query-validation errors", async () => {
    const { baseUrl } = serve();
    expect((await fetch(`${baseUrl}/runs/unknown-run`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/runs?limit=101`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/runs?limit=5&credentials=x`)).status).toBe(400);
    const oversized = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-http-oversized" },
      body: JSON.stringify({ plan: plan("http-oversized-run", [10_000, 10_000, 10_000, 10_000]), padding: "x".repeat(70_000) })
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "paper-request-too-large" });
  });
});

function serve() {
  const journal = PaperMultiLegJournal.open(":memory:");
  journals.push(journal);
  const service = new PaperMultiLegService(journal, () => NOW);
  const app = express();
  app.use("/paper", createPaperMultiLegRouter(service, { now: () => NOW }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/paper` };
}

function post(baseUrl: string, plan: PaperMultiLegPlan, idempotencyKey: string | undefined) {
  return fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
    },
    body: JSON.stringify({ plan })
  });
}

function plan(runId: string, fillRatios: readonly [number, number, number, number]): PaperMultiLegPlan {
  return {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId,
    source: {
      kind: "n-leg",
      engine: "n-leg-v1",
      opportunityId: `opportunity:${runId}`,
      evaluatedAt: NOW - 10,
      provenanceHash: "a".repeat(64)
    },
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: fillRatios.map((paperFillRatioBps, index) => ({
      legId: `leg-${index}`,
      venue: "test",
      instrumentId: `test:spot:ASSET${index}`,
      side: index % 2 === 0 ? "buy" : "sell",
      quantityUnit: "base",
      plannedQuantity: index + 1,
      referencePrice: 100 + index,
      feeBps: 2,
      paperFillRatioBps,
      paperCompensationFillRatioBps: 10_000,
      paperCompensationPrice: 100 + index + 0.5,
      paperCompensationFeeBps: 3,
      evidenceId: `fixture:book:${index}`
    }))
  };
}

function nLegOpportunity(): NLegOpportunity {
  return {
    id: "n-leg-opportunity:fixture",
    strategyKind: "n-leg-cycle",
    edgeKind: "research-simulation",
    executable: false,
    executionModel: "sequential-visible-depth",
    cycleId: "fixture-cycle",
    venue: "fixture",
    legCount: 4,
    start: { venue: "fixture", assetId: "USDT", unitId: "native" },
    startKey: "fixture:USDT:native",
    requestedStartQuantity: 100,
    startQuantity: 100,
    endQuantity: 101,
    netReturnBps: 100,
    capacityUtilizationPct: 100,
    depthLimited: false,
    legs: Array.from({ length: 4 }, (_, index) => ({
      index,
      instrumentId: `fixture-market-${index}`,
      venue: "fixture",
      symbol: `M${index}`,
      side: index % 2 === 0 ? ("buy" as const) : ("sell" as const),
      from: { venue: "fixture", assetId: `A${index}`, unitId: "native" },
      to: { venue: "fixture", assetId: `A${index + 1}`, unitId: "native" },
      fromKey: `fixture:A${index}:native`,
      toKey: `fixture:A${index + 1}:native`,
      inputQuantity: index + 1,
      tradeInputQuantity: index + 1,
      totalInputDebitedQuantity: index + 1,
      inputDustQuantity: 0,
      orderBaseQuantity: index + 1,
      averagePrice: 100 + index,
      worstPrice: 100 + index,
      quoteNotional: (index + 1) * (100 + index),
      grossOutputQuantity: index + 1,
      feeScheduleId: `fee-${index}`,
      feeTierId: "tier-0",
      feeBps: 2,
      feeAsset: { venue: "fixture", assetId: `A${index + 1}`, unitId: "native" },
      feeAssetKey: `fixture:A${index + 1}:native`,
      feeDebit: "output" as const,
      feeQuantity: 0.001,
      outputQuantity: index + 1,
      levelsUsed: 1,
      exchangeTs: NOW - 20,
      receivedAt: NOW - 15,
      sequence: 1
    })),
    residuals: [],
    dustByAssetUnit: {},
    feesByAssetUnit: {},
    timestamps: {
      evaluatedAt: NOW - 10,
      oldestExchangeTs: NOW - 20,
      newestExchangeTs: NOW - 20,
      oldestReceivedAt: NOW - 15,
      newestReceivedAt: NOW - 15,
      quoteAgeMs: 20,
      legSkewMs: 0,
      sequenceVerified: true,
      exchangeTimestampsVerified: true
    },
    provenance: {
      engine: "n-leg-v1",
      canonicalSignature: "fixture-signature",
      instrumentIds: Array.from({ length: 4 }, (_, index) => `fixture-market-${index}`),
      feeScheduleIds: Array.from({ length: 4 }, (_, index) => `fee-${index}`),
      bookSourceIds: Array.from({ length: 4 }, (_, index) => `fixture-book-${index}`)
    }
  };
}

function routeFamilyOpportunity(): PairwiseOpportunity {
  const legs = [
    {
      role: "long",
      instrumentId: "fixture-spot",
      venue: "fixture-a",
      symbol: "BTCUSDT",
      marketType: "spot",
      side: "buy",
      bookSide: "asks",
      nativeQuantity: 1,
      quantityUnit: "base",
      baseEquivalentQuantity: 1,
      averagePrice: 100,
      worstPrice: 100,
      quoteNotional: 100,
      entryFeeBps: 2,
      entryFeeQuote: 0.02,
      levelsUsed: 1,
      depthLimited: false,
      exchangeTs: NOW - 20,
      receivedAt: NOW - 15
    },
    {
      role: "short",
      instrumentId: "fixture-future",
      venue: "fixture-b",
      symbol: "BTC-FUT",
      marketType: "future",
      side: "sell",
      bookSide: "bids",
      nativeQuantity: 10,
      quantityUnit: "contract",
      baseEquivalentQuantity: 1,
      averagePrice: 105,
      worstPrice: 105,
      quoteNotional: 105,
      entryFeeBps: 2,
      entryFeeQuote: 0.021,
      levelsUsed: 1,
      depthLimited: false,
      exchangeTs: NOW - 19,
      receivedAt: NOW - 14
    }
  ];
  return {
    id: "pairwise-opportunity:fixture",
    strategyKind: "spot-dated-future",
    edgeKind: "research-simulation",
    executable: false,
    routeId: "rf:spot-dated-future:fixture",
    legs,
    timestamps: { evaluatedAt: NOW - 10 },
    provenance: { engine: "pairwise-v1", books: [{ sourceId: "fixture-spot-book" }, { sourceId: "fixture-future-book" }] }
  } as unknown as PairwiseOpportunity;
}
