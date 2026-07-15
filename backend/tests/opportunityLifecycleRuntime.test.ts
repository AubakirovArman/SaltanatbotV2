import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PairwiseOpportunity } from "../src/arbitrage/engines/pairwise/index.js";
import type { TriangularScanResponse } from "../src/arbitrage/engines/triangular/index.js";
import {
  attachBasisOpportunityLifecycle,
  basisScanToLifecycleSnapshot,
  createOpportunityLifecycleHandler,
  nativeSpreadScanToLifecycleSnapshot,
  OpportunityLifecycleCoordinator,
  routeFamilyEvaluationToLifecycleSnapshot,
  triangularScanToLifecycleSnapshot,
  type BasisLifecycleSource,
  type BasisLifecycleScan
} from "../src/arbitrage/lifecycle/index.js";
import type { NativeSpreadScan } from "../src/arbitrage/nativeSpreads/index.js";
import type { RouteFamilyEvaluationResponse } from "../src/arbitrage/routeFamilies/index.js";
import type { ArbitrageOpportunity, ArbitrageSourceStatus } from "../src/arbitrage/types.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("opportunity lifecycle runtime", () => {
  it("adapts complete basis scans with stable observation identity and local receipt clocks", () => {
    const first = basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30)));
    const aged = basisScanToLifecycleSnapshot({ ...scan(1_500, opportunity(1_000, 30)), opportunities: [{ ...opportunity(1_000, 30), capturedAt: 1_500, quoteAgeMs: 500 }] });

    expect(first.coverage).toEqual({ complete: true, stale: false, truncated: false, failedSources: [] });
    expect(first.snapshotId).not.toBe(aged.snapshotId);
    expect(first.candidates[0]?.observationId).toBe(aged.candidates[0]?.observationId);
    expect(first.candidates[0]?.evidence).toEqual([expect.objectContaining({ sourceId: "binance:spot:binance:spot:BTCUSDT", observedAt: 990, quality: "fresh", complete: true }), expect.objectContaining({ sourceId: "bybit:perpetual:bybit:perpetual:BTCUSDT", observedAt: 1_000, quality: "fresh", complete: true })]);
    expect(first.candidates[0]?.evidence.every((row) => row.quality !== "verified")).toBe(true);

    const corrected = basisScanToLifecycleSnapshot(
      scan(1_000, {
        ...opportunity(1_000, 30),
        clockCorrection: {
          modelVersion: "venue-clock-v1",
          spot: { sourceId: "binance:public", clockStatus: "calibrated", eligible: true, quality: "verified", offsetLowerMs: 0, offsetUpperMs: 1, ageLowerMs: 10, ageUpperMs: 11 },
          futures: { sourceId: "bybit:public", clockStatus: "calibrated", eligible: true, quality: "verified", offsetLowerMs: 0, offsetUpperMs: 1, ageLowerMs: 10, ageUpperMs: 11 },
          skewEligible: true,
          minimumPossibleSkewMs: 0,
          maximumPossibleSkewMs: 1
        }
      })
    );
    expect(corrected.candidates[0]?.evidence.every((row) => row.quality === "verified")).toBe(true);
  });

  it("fails universe coverage closed for missing, failed, stale or truncated basis data", () => {
    const failedSources = sources().filter((row) => !(row.exchange === "bybit" && row.market === "perpetual"));
    failedSources[0] = { ...failedSources[0]!, ok: false, message: "injected failure" };
    const snapshot = basisScanToLifecycleSnapshot({ ...scan(1_000, opportunity(1_000, 30)), stale: true, truncated: true, totalOpportunities: 2, sources: failedSources });

    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.stale).toBe(true);
    expect(snapshot.coverage.truncated).toBe(true);
    expect(snapshot.coverage.failedSources).toEqual(["binance:spot", "missing:bybit:perpetual"]);
  });

  it("does not infer identity-registry completeness from healthy ticker sources", () => {
    const { identityCoverage: _omitted, ...withoutIdentityProof } = scan(1_000, opportunity(1_000, 30));
    const snapshot = basisScanToLifecycleSnapshot(withoutIdentityProof);

    expect(snapshot.coverage.complete).toBe(false);
    expect(snapshot.coverage.failedSources).toEqual(["identity-registry:coverage-unproven"]);
  });

  it("confirms only distinct complete observations and makes incomplete universes non-actionable", () => {
    const coordinator = new OpportunityLifecycleCoordinator({ now: () => 2_000 });
    const policy = { confirmationObservations: 2, confirmationMinDurationMs: 0, minimumEvidenceSources: 2, minimumEvidenceQuality: "fresh" as const, enterScore: 10, exitScore: 5, observationFreshForMs: 5_000 };
    coordinator.ingest(basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30))), policy);
    coordinator.ingest(basisScanToLifecycleSnapshot(scan(1_100, opportunity(1_100, 30))), policy);

    expect(coordinator.read({ kind: "basis" }).routes[0]).toMatchObject({ status: "confirmed", actionable: true, confirmationCount: 2 });

    coordinator.ingest(
      basisScanToLifecycleSnapshot({
        ...scan(1_200, opportunity(1_200, 30)),
        stale: true,
        sources: sources().map((row) => (row.exchange === "bybit" && row.market === "perpetual" ? { ...row, ok: false } : row))
      }),
      policy
    );
    const response = coordinator.read({ actionable: false, routeLimit: 1, eventLimit: 2 });
    expect(response.executionPermission).toBe(false);
    expect(response.universes[0]?.coverageComplete).toBe(false);
    expect(response.routes[0]).toMatchObject({ status: "confirmed", actionable: false });
    expect(response.summary.returnedEvents).toBeLessThanOrEqual(2);
    expect(response.events[0]!.sequence).toBeGreaterThan(response.events.at(-1)!.sequence - 1);
  });

  it("keeps state transactional when the reducer throws and sanitizes bounded diagnostics", () => {
    const coordinator = new OpportunityLifecycleCoordinator({
      now: () => 9_999,
      evaluate(previous) {
        previous.nextEventSequence = 777;
        throw new Error(`injected\n${"x".repeat(400)}`);
      }
    });
    expect(() => coordinator.ingest(basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30))))).toThrow("injected");
    expect(coordinator.exportState().nextEventSequence).toBe(1);
    const runtime = coordinator.read().runtime;
    expect(runtime).toMatchObject({ acceptedSnapshots: 0, rejectedSnapshots: 1, lastRejectedAt: 1_000 });
    expect(runtime.lastError).not.toContain("\n");
    expect(runtime.lastError?.length).toBeLessThanOrEqual(240);
  });

  it("keeps both exported and runtime ingestion ownership boundaries detached", () => {
    const publicCoordinator = new OpportunityLifecycleCoordinator();
    const returned = publicCoordinator.ingest(basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30))));
    returned.state.nextEventSequence = 999;
    returned.routes[0]!.recentObservationIds.push("external-mutation");
    expect(publicCoordinator.exportState().nextEventSequence).not.toBe(999);
    expect(publicCoordinator.read().routes[0]?.recentObservationIds).not.toContain("external-mutation");

    let retainedEvaluatorState: ReturnType<OpportunityLifecycleCoordinator["exportState"]> | undefined;
    const runtimeCoordinator = new OpportunityLifecycleCoordinator({
      evaluate(previous) {
        retainedEvaluatorState = previous;
        return { state: previous, routes: [], events: [], idempotent: false, universeComplete: true };
      }
    });
    runtimeCoordinator.ingestRuntime(basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30))));
    retainedEvaluatorState!.nextEventSequence = 777;
    expect(runtimeCoordinator.exportState().nextEventSequence).toBe(1);
    expect(runtimeCoordinator.read().runtime).toMatchObject({ acceptedSnapshots: 1, rejectedSnapshots: 0 });
  });

  it("isolates adapter and reducer failures from the basis stream subscription", () => {
    let listener: ((value: BasisLifecycleScan) => void) | undefined;
    let unsubscribed = false;
    const source: BasisLifecycleSource = {
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      current: () => scan(1_000, opportunity(1_000, 30))
    };
    const coordinator = new OpportunityLifecycleCoordinator();
    const detach = attachBasisOpportunityLifecycle(source, coordinator, { policy: { confirmationObservations: 1, confirmationMinDurationMs: 0 } });
    expect(coordinator.read().runtime.acceptedSnapshots).toBe(1);

    expect(() => listener?.({ ...scan(1_100, opportunity(1_100, 30)), updatedAt: Number.NaN })).not.toThrow();
    expect(coordinator.read().runtime.rejectedSnapshots).toBe(1);
    detach();
    expect(unsubscribed).toBe(true);
  });

  it("exposes a bounded public GET API with strict filters and no mutation surface", async () => {
    const coordinator = new OpportunityLifecycleCoordinator({ now: () => 2_000 });
    coordinator.ingest(basisScanToLifecycleSnapshot(scan(1_000, opportunity(1_000, 30))), { confirmationObservations: 1, confirmationMinDurationMs: 0 });
    const app = express();
    app.get("/lifecycle", createOpportunityLifecycleHandler(coordinator));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/lifecycle`;

    const valid = await fetch(`${url}?kind=basis&actionable=true&routeLimit=1&eventLimit=1`);
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toBe("public, max-age=1");
    expect(await valid.json()).toMatchObject({ readOnly: true, executionPermission: false, summary: { returnedRoutes: 1 } });
    expect((await fetch(`${url}?routeLimit=501`)).status).toBe(400);
    expect((await fetch(`${url}?actionable=1`)).status).toBe(400);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  });

  it("keeps current triangular research scans incomplete and evaluates native/pairwise coverage explicitly", () => {
    const identity = { universeId: "test:family", policyId: "test:policy:v1" };
    const triangular = triangularScanToLifecycleSnapshot(
      {
        updatedAt: 1_000,
        totalOpportunities: 1,
        truncated: false,
        opportunities: [
          {
            id: "triangular:route",
            cycleId: "binance:USDT:route",
            netReturnBps: 12,
            sequenceVerified: false,
            marketDataMode: "rest-top-book",
            legs: [0, 1, 2].map((index) => ({ marketId: `binance:spot:M${index}`, receivedAt: 990 + index, averagePrice: 1, outputQuantity: 1, levelsUsed: 1 }))
          }
        ]
      } as unknown as TriangularScanResponse,
      identity
    );
    expect(triangular.coverage.complete).toBe(false);
    expect(triangular.candidates[0]?.evidence.every((row) => row.quality === "unverified")).toBe(true);

    const native = nativeSpreadScanToLifecycleSnapshot(nativeScan(), identity);
    expect(native.coverage.complete).toBe(true);
    expect(native.candidates[0]).toMatchObject({ kind: "native-spread", score: -2 });
    expect(nativeSpreadScanToLifecycleSnapshot({ ...nativeScan(), candidateTruncated: true, truncated: true }, identity).coverage.complete).toBe(false);

    const pairwise = routeFamilyEvaluationToLifecycleSnapshot(routeFamilyResponse(), identity);
    expect(pairwise.coverage.complete).toBe(true);
    expect(pairwise.candidates[0]).toMatchObject({ kind: "pairwise", score: 25 });
    const incomplete = routeFamilyEvaluationToLifecycleSnapshot({ ...routeFamilyResponse(), evaluatedRoutes: 0 }, identity);
    expect(incomplete.coverage).toMatchObject({ complete: false, failedSources: ["pairwise:unevaluated-candidates"] });
  });
});

function scan(updatedAt: number, row: ArbitrageOpportunity): BasisLifecycleScan {
  return {
    updatedAt,
    stale: false,
    scannedSymbols: 1,
    totalOpportunities: 1,
    truncated: false,
    estimatedTotalCostBps: 0,
    opportunities: [row],
    sources: sources(),
    identityCoverage: { complete: true, stale: false, failedSources: [] }
  };
}

function sources(): ArbitrageSourceStatus[] {
  return [
    { exchange: "binance", market: "spot", ok: true },
    { exchange: "binance", market: "perpetual", ok: true },
    { exchange: "bybit", market: "spot", ok: true },
    { exchange: "bybit", market: "perpetual", ok: true }
  ];
}

function opportunity(observedAt: number, netEdgeBps: number): ArbitrageOpportunity {
  return {
    id: "BTCUSDT:binance:bybit",
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: "cross-venue-reviewed",
    symbol: "BTCUSDT",
    assetId: "crypto:btc",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 10,
    futuresBid: 101,
    futuresAsk: 102,
    futuresBidSize: 9,
    grossSpreadBps: 100,
    estimatedTotalCostBps: 70,
    netEdgeBps,
    topBookCapacityUsd: 900,
    topBookMatchedQuantity: 9,
    expectedNetProfitUsd: 2.7,
    fundingRate: 0.0001,
    spotExchangeTs: observedAt - 500,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: observedAt - 10,
    futuresExchangeTs: observedAt + 400,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: observedAt,
    quoteAgeMs: 10,
    legSkewMs: 900,
    dataQuality: "fresh",
    capturedAt: observedAt
  };
}

function nativeScan(): NativeSpreadScan {
  return {
    venue: "bybit",
    marketDataMode: "venue-native-spread-orderbook",
    executionModel: "venue-matched-multi-leg",
    readOnly: true,
    updatedAt: 1_000,
    totalInstruments: 1,
    eligibleInstruments: 1,
    scannedInstruments: 1,
    healthyBooks: 1,
    totalOpportunities: 1,
    truncated: false,
    candidateTruncated: false,
    sourceErrors: [],
    opportunities: [
      {
        id: "bybit:native-spread:BTCUSDT",
        venue: "bybit",
        symbol: "BTCUSDT",
        sequence: 10,
        receivedAt: 990,
        relativeBookWidthBps: 2,
        executableQuantity: 1,
        bidPrice: 10,
        askPrice: 11
      }
    ]
  } as NativeSpreadScan;
}

function routeFamilyResponse(): RouteFamilyEvaluationResponse {
  const opportunity = {
    routeId: "a:spot:BTCUSDT|b:spot:BTCUSDT",
    netReturnBps: 25,
    provenance: {
      books: [
        { source: "websocket", sourceId: "a-feed", instrumentId: "a:spot:BTCUSDT", sequence: 1, exchangeTs: 900, receivedAt: 990 },
        { source: "websocket", sourceId: "b-feed", instrumentId: "b:spot:BTCUSDT", sequence: 2, exchangeTs: 910, receivedAt: 995 }
      ]
    },
    legs: [
      { instrumentId: "a:spot:BTCUSDT", averagePrice: 100, baseEquivalentQuantity: 1 },
      { instrumentId: "b:spot:BTCUSDT", averagePrice: 101, baseEquivalentQuantity: 1 }
    ]
  } as unknown as PairwiseOpportunity;
  return {
    engine: "route-families-v1",
    executionStatus: "research-only",
    executable: false,
    evaluatedAt: 1_000,
    totalCompatibleCandidates: 1,
    evaluatedRoutes: 1,
    truncated: false,
    candidates: [{ routeKey: "key", routeId: opportunity.routeId, family: "cross-venue-spot-spot", longInstrumentId: "a:spot:BTCUSDT", shortInstrumentId: "b:spot:BTCUSDT", longMarketType: "spot", shortMarketType: "spot", economicAssetId: "crypto:btc", edgeKind: "research-candidate", executable: false }],
    opportunities: [opportunity],
    rejections: [],
    rejectedInstruments: []
  };
}
