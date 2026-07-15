import express, { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessResearchAlertCandidate,
  createResearchAlertState,
  evaluateResearchAlertSnapshot,
  lifecycleRouteToResearchAlertEvidence,
  registerResearchAlertRoutes,
  researchAlertDedupKey,
  researchAlertPolicyInputSchema,
  researchAlertSnapshotSchema,
  ResearchAlertService,
  type ResearchAlertCandidate,
  type ResearchAlertPersistedState,
  type ResearchAlertPolicy,
  type ResearchAlertSnapshot,
  type ResearchAlertStorage
} from "../src/arbitrage/researchAlerts/index.js";

const NOW = 1_000_000;
const HOUR = 3_600_000;
const services: ResearchAlertService[] = [];

afterEach(() => {
  services.splice(0).forEach((service) => service.close());
});

describe("generic research alert policy", () => {
  it("strictly parses bounded policies and rejects credential/unknown snapshot fields", () => {
    expect(researchAlertPolicyInputSchema.parse({ name: "all", minimumNetEdgeBps: 10 }).families).toHaveLength(12);
    expect(researchAlertPolicyInputSchema.safeParse({ name: "x", minimumNetEdgeBps: 0, cooldownSeconds: 59 }).success).toBe(false);
    expect(researchAlertPolicyInputSchema.safeParse({ name: "x", minimumNetEdgeBps: 0, apiKey: "must-not-enter-this-boundary" }).success).toBe(false);
    expect(researchAlertSnapshotSchema.safeParse({ ...snapshot("s1", [candidate()]), secret: "no" }).success).toBe(false);
    expect(researchAlertSnapshotSchema.safeParse({ ...snapshot("s1", [candidate()]), candidates: Array.from({ length: 201 }, () => candidate()) }).success).toBe(false);
  });

  it("uses a family-independent exact economic-route dedup key", () => {
    const left = candidate({ family: "basis" });
    const right = candidate({ family: "perpetual-future", lifecycleKind: "pairwise", routeId: "route-other" });
    expect(researchAlertDedupKey(left.economicIdentity)).toBe(researchAlertDedupKey(right.economicIdentity));
    const reverse = structuredClone(left.economicIdentity);
    reverse.legs = reverse.legs.map((leg) => ({ ...leg, side: leg.side === "buy" ? "sell" : "buy" }));
    expect(researchAlertDedupKey(reverse)).not.toBe(researchAlertDedupKey(left.economicIdentity));
  });

  it("adapts the existing lifecycle route exactly and rejects a family-kind mismatch", () => {
    const lifecycle = lifecycleRouteToResearchAlertEvidence(lifecycleRoute(), "cross-venue-spot-spot");
    expect(lifecycle).toEqual({
      universeId: "pairwise-v1",
      policyId: "pairwise-policy-v1",
      kind: "pairwise",
      routeId: "route-a",
      observationId: "observation-a",
      status: "confirmed",
      actionable: true,
      lastObservationAt: NOW,
      effectiveEvidenceQuality: "fresh",
      evidenceComplete: true,
      evidenceSourceIds: ["binance:spot", "bybit:perpetual"]
    });
    expect(() => lifecycleRouteToResearchAlertEvidence(lifecycleRoute(), "triangular")).toThrow(/cannot evidence triangular/);
  });

  it("accepts only confirmed, fresh, reviewed and account-funded conservative economics", () => {
    const accepted = assessResearchAlertCandidate(candidate(), policy(), NOW);
    expect(accepted).toMatchObject({ eligible: true, conservativeNetProfit: 479.5, policyId: "policy-1" });
    expect(accepted.riskCapitalValuation).toBeCloseTo(12_015.5);
    expect(accepted.netEdgeBps).toBeGreaterThan(390);
    expect(accepted.economics).toMatchObject({ modelVersion: "route-economics-v1", eligible: true, failures: [] });

    const staleIdentity = candidate();
    staleIdentity.economicIdentity.asOf = NOW - 200_000;
    expect(codes(staleIdentity)).toContain("identity-stale");

    const mismatched = candidate();
    mismatched.economicIdentity.legs[0] = { ...mismatched.economicIdentity.legs[0]!, instrumentId: "other:spot:BTCUSDT" };
    expect(codes(mismatched)).toContain("identity-mismatch");

    const decaying = candidate();
    decaying.lifecycle.status = "decaying";
    decaying.lifecycle.actionable = false;
    expect(codes(decaying)).toContain("lifecycle-invalid");

    const staleObservation = candidate();
    staleObservation.lifecycle.lastObservationAt = NOW - 20_000;
    expect(codes(staleObservation)).toContain("observation-stale");

    const insufficient = candidate();
    insufficient.economicsRequest.capital![0]!.available = 1;
    expect(codes(insufficient)).toContain("economics-ineligible");

    const staleProfit = candidate();
    staleProfit.routeEvidence.validUntil = NOW - 1;
    expect(codes(staleProfit)).toContain("route-evidence-invalid");

    const duplicateCapital = candidate();
    duplicateCapital.economicsRequest.capital!.push(structuredClone(duplicateCapital.economicsRequest.capital![0]!));
    expect(codes(duplicateCapital)).toContain("economics-ineligible");

    expect(codes(candidate({ grossProfitValuation: 10 }))).toEqual(expect.arrayContaining(["profit-threshold", "edge-threshold"]));
    expect(codes(candidate(), { maximumRiskCapitalValuation: 10_000 })).toContain("capital-threshold");
    expect(codes(candidate({ capacityValuation: 10 }), { minimumCapacityValuation: 20 })).toContain("capacity-threshold");
  });

  it("arms without startup noise, then selects one deterministic winner across families", () => {
    const state = withPolicy(createResearchAlertState());
    const lowA = candidate({ grossProfitValuation: 10, observationId: "obs-low-a" });
    const lowB = candidate({ family: "perpetual-future", lifecycleKind: "pairwise", routeId: "route-b", grossProfitValuation: 5, observationId: "obs-low-b" });
    const armed = evaluateResearchAlertSnapshot(state, snapshot("snap-1", [lowA, lowB]), NOW);
    expect(armed.result.intents).toEqual([]);
    expect(armed.result.selected).toHaveLength(1);
    expect(armed.result.selected[0]?.eligible).toBe(false);

    const highA = candidate({ grossProfitValuation: 500, observationId: "obs-high-a" });
    const highB = candidate({ family: "perpetual-future", lifecycleKind: "pairwise", routeId: "route-b", grossProfitValuation: 700, observationId: "obs-high-b" });
    const crossed = evaluateResearchAlertSnapshot(armed.state, snapshot("snap-2", [highA, highB], NOW + 1), NOW + 1);
    expect(crossed.result.assessments).toHaveLength(2);
    expect(crossed.result.selected).toHaveLength(1);
    expect(crossed.result.selected[0]).toMatchObject({ routeId: "route-b", family: "perpetual-future", eligible: true });
    expect(crossed.result.intents).toHaveLength(1);
    expect(crossed.result.intents[0]).toMatchObject({ routeId: "route-b", researchOnly: true, executionPermission: false });
    expect(JSON.stringify(crossed.result)).not.toMatch(/apiKey|apiSecret|placeOrder|credential/i);
  });

  it("preserves state on incomplete absence, rearms on complete absence and rejects equivocation", () => {
    const armed = evaluateResearchAlertSnapshot(withPolicy(createResearchAlertState()), snapshot("snap-1", [candidate({ grossProfitValuation: 10, observationId: "obs-low" })]), NOW);
    const crossed = evaluateResearchAlertSnapshot(armed.state, snapshot("snap-2", [candidate({ observationId: "obs-high" })], NOW + 1), NOW + 1);
    expect(crossed.result.intents).toHaveLength(1);

    const incomplete = evaluateResearchAlertSnapshot(crossed.state, snapshot("snap-3", [], NOW + 2, false), NOW + 2);
    const stillHigh = evaluateResearchAlertSnapshot(incomplete.state, snapshot("snap-4", [candidate({ observationId: "obs-high-2" })], NOW + 61_001), NOW + 61_001);
    expect(stillHigh.result.intents).toEqual([]);

    const absent = evaluateResearchAlertSnapshot(stillHigh.state, snapshot("snap-5", [], NOW + 61_002, true), NOW + 61_002);
    const recross = evaluateResearchAlertSnapshot(absent.state, snapshot("snap-6", [candidate({ observationId: "obs-high-3" })], NOW + 122_001), NOW + 122_001);
    expect(recross.result.intents).toHaveLength(1);

    const replay = evaluateResearchAlertSnapshot(recross.state, snapshot("snap-6", [candidate({ observationId: "obs-high-3" })], NOW + 122_001), NOW + 122_001);
    expect(replay.result).toMatchObject({ idempotent: true, intents: [] });
    expect(() => evaluateResearchAlertSnapshot(recross.state, snapshot("snap-6", [], NOW + 122_001), NOW + 122_001)).toThrow(/reused with different content/);
    expect(() => evaluateResearchAlertSnapshot(recross.state, snapshot("snap-old", [], NOW + 100), NOW + 122_001)).toThrow(/older than durable state/);
  });

  it("serializes concurrent duplicate ingest and delivers exactly once", async () => {
    const delivered: string[] = [];
    const service = tracked(new ResearchAlertService({ storage: memoryStorage(), now: () => NOW + 1, deliver: async (payload) => delivered.push(payload.text) }));
    service.savePolicy(policyInput(), NOW - 100);
    await service.ingest(snapshot("snap-low", [candidate({ grossProfitValuation: 10, observationId: "obs-low" })]), NOW);
    const crossing = snapshot("snap-high", [candidate({ observationId: "obs-high" })], NOW + 1);
    const [first, duplicate] = await Promise.all([service.ingest(crossing, NOW + 1), service.ingest(crossing, NOW + 1)]);

    expect(new Set([...first.deliveredDeliveryIds, ...duplicate.deliveredDeliveryIds])).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(service.listDeliveries()).toEqual([expect.objectContaining({ status: "delivered", attempts: 1, researchOnly: true, executionPermission: false })]);
  });

  it("persists retry state and recovers delivery after restart", async () => {
    const storage = memoryStorage();
    const first = tracked(
      new ResearchAlertService({
        storage,
        now: () => NOW + 1,
        retryBaseMs: 100,
        maxAttempts: 3,
        deliver: async () => {
          throw new Error("offline");
        }
      })
    );
    first.savePolicy(policyInput(), NOW - 100);
    await first.ingest(snapshot("snap-low", [candidate({ grossProfitValuation: 10, observationId: "obs-low" })]), NOW);
    const failed = await first.ingest(snapshot("snap-high", [candidate({ observationId: "obs-high" })], NOW + 1), NOW + 1);
    expect(failed.retryingDeliveryIds).toHaveLength(1);
    expect(first.listDeliveries()[0]).toMatchObject({ status: "retrying", attempts: 1, nextAttemptAt: NOW + 101 });
    first.close();

    const recovered: string[] = [];
    const restarted = tracked(new ResearchAlertService({ storage, now: () => NOW + 101, retryBaseMs: 100, maxAttempts: 3, deliver: async (payload) => recovered.push(payload.text) }));
    const result = await restarted.flush(NOW + 101);
    expect(result.deliveredDeliveryIds).toEqual(failed.retryingDeliveryIds);
    expect(recovered).toHaveLength(1);
    expect(restarted.listPolicies()[0]?.lastDelivery).toMatchObject({ status: "delivered", attempts: 2 });
  });
});

describe("generic research alert HTTP contract", () => {
  it("is protected, bounded, strict and permanently notification-only", async () => {
    const service = tracked(new ResearchAlertService({ storage: memoryStorage(), now: () => NOW, deliver: async () => {} }));
    const app = express();
    const router = Router();
    const requireToken: express.RequestHandler = (request, response, next) => (request.headers.authorization === "Bearer paper" ? next() : response.status(401).json({ error: "Unauthorized" }));
    registerResearchAlertRoutes(router, service, requireToken);
    app.use(express.json());
    app.use(router);
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/arbitrage-alerts/research`;
    try {
      expect((await fetch(base)).status).toBe(401);
      const headers = { authorization: "Bearer paper", "content-type": "application/json" };
      const invalid = await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...policyInput(), apiSecret: "forbidden" }) });
      expect(invalid.status).toBe(400);
      const created = await fetch(base, { method: "POST", headers, body: JSON.stringify(policyInput()) });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ schemaVersion: 1, researchOnly: true, executionPermission: false });

      const listed = await fetch(base, { headers });
      expect(listed.headers.get("cache-control")).toBe("no-store");
      expect(await listed.json()).toMatchObject({ schemaVersion: 1, researchOnly: true, executionPermission: false, policies: [expect.any(Object)] });
      expect((await fetch(`${base}/deliveries?limit=501`, { headers })).status).toBe(400);
      expect((await fetch(`${base}/evaluate`, { method: "POST", headers, body: JSON.stringify(snapshot("snap-http", [candidate()])) })).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function policy(overrides: Partial<ResearchAlertPolicy> = {}): ResearchAlertPolicy {
  return { ...policyInput(), id: "policy-1", createdAt: NOW - 1_000, updatedAt: NOW - 1_000, ...overrides };
}

function policyInput() {
  return {
    name: "strict research",
    families: ["basis", "perpetual-future"] as const,
    economicAssetIds: [] as string[],
    minimumConservativeNetProfit: 100,
    minimumNetEdgeBps: 100,
    minimumCapacityValuation: 1_000,
    maximumRiskCapitalValuation: 20_000,
    minimumEvidenceQuality: "fresh" as const,
    maximumObservationAgeMs: 10_000,
    maximumEconomicsAgeMs: 10_000,
    maximumIdentityAgeMs: 100_000,
    cooldownSeconds: 60,
    enabled: true
  };
}

function candidate(overrides: { family?: ResearchAlertCandidate["family"]; lifecycleKind?: ResearchAlertCandidate["lifecycle"]["kind"]; routeId?: string; observationId?: string; grossProfitValuation?: number; capacityValuation?: number } = {}): ResearchAlertCandidate {
  const routeId = overrides.routeId ?? "route-a";
  const family = overrides.family ?? "basis";
  const identityLegs: ResearchAlertCandidate["economicIdentity"]["legs"] = [
    { venue: "binance", instrumentId: "binance:spot:BTCUSDT", marketType: "spot", side: "buy" },
    { venue: "bybit", instrumentId: "bybit:perpetual:BTCUSDT", marketType: "perpetual", side: "sell" }
  ];
  const evidence = (source: string) => ({ source, version: "v1", asOf: NOW - 100, validUntil: NOW + 2 * HOUR });
  return {
    routeId,
    family,
    economicIdentity: { schemaVersion: 1, economicAssetId: "crypto:bitcoin", status: "reviewed", source: "reviewed-map", version: "2026-07", asOf: NOW - 100, validUntil: NOW + HOUR, legs: identityLegs },
    lifecycle: {
      universeId: "basis-v1",
      policyId: "basis-policy-v1",
      kind: overrides.lifecycleKind ?? (family === "basis" ? "basis" : "pairwise"),
      routeId,
      observationId: overrides.observationId ?? "obs-a",
      status: "confirmed",
      actionable: true,
      lastObservationAt: NOW,
      effectiveEvidenceQuality: "fresh",
      evidenceComplete: true,
      evidenceSourceIds: ["binance:spot", "bybit:perpetual"]
    },
    economicsRequest: {
      routeId,
      evaluatedAt: NOW,
      horizonStart: NOW,
      horizonEnd: NOW + HOUR,
      valuationAsset: "USDT",
      maximumEvidenceAgeMs: 10_000,
      maximumFutureClockSkewMs: 1_000,
      maximumTransferArrivalMs: HOUR,
      execution: { requestedBaseQuantity: 1, executableBaseQuantity: 1, residualBaseQuantity: 0, maximumResidualBps: 1, atomicity: "independent-venues", observedLegSkewMs: 10, maximumLeggingMs: 500 },
      settlement: { kind: "convergence-assumption", evidence: evidence("settlement") },
      legs: [
        {
          legId: "buy-spot",
          ...identityLegs[0]!,
          liquidity: "taker",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          baseQuantity: 1,
          price: 10_000,
          feeTier: { venue: "binance", accountScope: "account-a", tier: "vip0", makerBps: 1, takerBps: 10, feeAsset: "USDT", rebateCreditVerified: false, evidence: evidence("binance-fees") }
        },
        { legId: "sell-perp", ...identityLegs[1]!, liquidity: "taker", baseAsset: "BTC", quoteAsset: "USDT", baseQuantity: 1, price: 10_500, feeTier: { venue: "bybit", accountScope: "account-b", tier: "base", makerBps: 1, takerBps: 10, feeAsset: "USDT", rebateCreditVerified: false, evidence: evidence("bybit-fees") } }
      ],
      fxRates: [],
      margin: [{ venue: "bybit", instrumentId: "bybit:perpetual:BTCUSDT", collateralAsset: "USDT", notionalQuote: 10_500, initialMarginBps: 1_000, maintenanceMarginBps: 500, safetyBufferBps: 900, evidence: evidence("bybit-margin") }],
      capital: [
        { venue: "binance", asset: "USDT", available: 20_000, reserved: 0, haircutBps: 0, evidence: evidence("binance-capital") },
        { venue: "bybit", asset: "USDT", available: 5_000, reserved: 0, haircutBps: 0, evidence: evidence("bybit-capital") }
      ]
    },
    grossProfitValuation: overrides.grossProfitValuation ?? 500,
    capacityValuation: overrides.capacityValuation ?? 10_000,
    routeEvidence: evidence("route-engine")
  };
}

function snapshot(id: string, candidates: ResearchAlertCandidate[], evaluatedAt = NOW, complete = true): ResearchAlertSnapshot {
  const adjusted = candidates.map((value) => {
    const row = structuredClone(value);
    const refresh = (evidence: { asOf: number; validUntil: number }) => {
      evidence.asOf = evaluatedAt - 100;
      evidence.validUntil = evaluatedAt + 2 * HOUR;
    };
    row.economicIdentity.asOf = evaluatedAt - 100;
    row.economicIdentity.validUntil = evaluatedAt + HOUR;
    refresh(row.routeEvidence);
    refresh(row.economicsRequest.settlement.evidence);
    row.economicsRequest.legs.forEach((leg) => refresh(leg.feeTier.evidence));
    row.economicsRequest.fxRates.forEach((rate) => refresh(rate.evidence));
    row.economicsRequest.funding?.forEach((item) => refresh(item.evidence));
    row.economicsRequest.borrow?.forEach((item) => refresh(item.evidence));
    row.economicsRequest.transfers?.forEach((item) => refresh(item.evidence));
    row.economicsRequest.margin?.forEach((item) => refresh(item.evidence));
    row.economicsRequest.capital?.forEach((item) => refresh(item.evidence));
    row.lifecycle.lastObservationAt = evaluatedAt;
    row.economicsRequest.evaluatedAt = evaluatedAt;
    row.economicsRequest.horizonStart = evaluatedAt;
    row.economicsRequest.horizonEnd = evaluatedAt + HOUR;
    return row;
  });
  return { schemaVersion: 1, snapshotId: id, evaluatedAt, coverage: { complete, stale: false, truncated: false, failedSources: complete ? [] : ["source-unavailable"] }, candidates: adjusted };
}

function codes(value: ResearchAlertCandidate, overrides: Partial<ResearchAlertPolicy> = {}) {
  return assessResearchAlertCandidate(value, policy(overrides), NOW).rejections.map((item) => item.code);
}

function withPolicy(state: ResearchAlertPersistedState) {
  state.policies = [policy()];
  return state;
}

function memoryStorage(): ResearchAlertStorage {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, set: (key, value) => values.set(key, structuredClone(value)) };
}

function tracked(service: ResearchAlertService) {
  services.push(service);
  return service;
}

function listen(app: express.Express) {
  return new Promise<ReturnType<express.Express["listen"]>>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function lifecycleRoute() {
  return {
    key: "pairwise-v1\u001froute-a",
    universeId: "pairwise-v1",
    policyId: "pairwise-policy-v1",
    kind: "pairwise" as const,
    routeId: "route-a",
    status: "confirmed" as const,
    actionable: true,
    firstSeenAt: NOW - 1_000,
    lastSeenAt: NOW,
    lastObservationAt: NOW,
    lastObservationId: "observation-a",
    recentObservationIds: ["observation-a"],
    score: 200,
    rawEvidenceQuality: "fresh" as const,
    effectiveEvidenceQuality: "fresh" as const,
    evidenceSourceIds: ["binance:spot", "bybit:perpetual"],
    evidenceComplete: true,
    confirmationCount: 2,
    confirmedAt: NOW,
    lastReason: "confirmation-complete" as const
  };
}
