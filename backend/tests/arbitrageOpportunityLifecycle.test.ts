import { describe, expect, it } from "vitest";
import { createOpportunityLifecycleState, evaluateOpportunityLifecycle, type OpportunityEvidenceQuality, type OpportunityLifecycleCandidate, type OpportunityLifecycleKind, type OpportunityLifecyclePolicy, type OpportunityLifecycleSnapshot } from "../src/arbitrage/lifecycle/index.js";

describe("scanner-agnostic opportunity lifecycle", () => {
  it("confirms distinct observations deterministically without mutating its input", () => {
    const initial = createOpportunityLifecycleState();
    const original = structuredClone(initial);
    const first = evaluateOpportunityLifecycle(initial, snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-b", "b1", 120, 1_000), candidate("basis", "route-a", "a1", 110, 1_000)]), policy());

    expect(initial).toEqual(original);
    expect(first.routes.map(({ routeId, status, confirmationCount, actionable }) => ({ routeId, status, confirmationCount, actionable }))).toEqual([
      { routeId: "route-a", status: "first-seen", confirmationCount: 1, actionable: false },
      { routeId: "route-b", status: "first-seen", confirmationCount: 1, actionable: false }
    ]);
    expect(first.events.map(({ id, routeId, to }) => [id, routeId, to])).toEqual([
      ["opportunity-lifecycle:1", undefined, undefined],
      ["opportunity-lifecycle:2", "route-a", "first-seen"],
      ["opportunity-lifecycle:3", "route-b", "first-seen"]
    ]);

    const second = evaluateOpportunityLifecycle(first.state, snapshot("basis-feed", "s2", 1_100, [candidate("basis", "route-b", "b2", 121, 1_100), candidate("basis", "route-a", "a2", 111, 1_100)]), policy());
    expect(second.routes.every(({ status, confirmationCount, actionable }) => status === "confirmed" && confirmationCount === 2 && actionable)).toBe(true);
    expect(second.events.map(({ routeId, to }) => [routeId, to])).toEqual([
      ["route-a", "confirmed"],
      ["route-b", "confirmed"]
    ]);

    const independentlyReduced = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "a1", 110, 1_000), candidate("basis", "route-b", "b1", 120, 1_000)]), policy());
    expect(independentlyReduced.state).toEqual(first.state);
  });

  it("uses entry/exit hysteresis and requires a fresh confirmation cycle after decay", () => {
    const oneObservation = policy({ confirmationObservations: 1, enterScore: 100, exitScore: 80, decayGraceMs: 1_000 });
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "o1", 100, 1_000)]), oneObservation);
    expect(result.routes[0]).toMatchObject({ status: "confirmed", actionable: true });

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s2", 1_100, [candidate("basis", "route-a", "o2", 90, 1_100)]), oneObservation);
    expect(result.routes[0]).toMatchObject({ status: "confirmed", actionable: true });
    expect(result.events).toEqual([]);

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s3", 1_200, [candidate("basis", "route-a", "o3", 79, 1_200)]), oneObservation);
    expect(result.routes[0]).toMatchObject({ status: "decaying", actionable: false, decayStartedAt: 1_200, lastReason: "score-below-exit" });

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s4", 1_300, [candidate("basis", "route-a", "o4", 100, 1_300)]), oneObservation);
    expect(result.routes[0]).toMatchObject({ status: "confirmed", actionable: true, confirmationCount: 1, confirmedAt: 1_300 });
    expect(result.events.map(({ from, to }) => [from, to])).toEqual([
      ["decaying", "first-seen"],
      ["first-seen", "confirmed"]
    ]);
  });

  it("fails closed without treating an incomplete universe as route absence", () => {
    const configured = policy({ confirmationObservations: 1, observationFreshForMs: 5_000, decayGraceMs: 1_000 });
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "o1", 100, 1_000)]), configured);
    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s2", 1_100, [], false), configured);
    expect(result).toMatchObject({ universeComplete: false });
    expect(result.routes[0]).toMatchObject({ status: "confirmed", actionable: false, confirmedAt: 1_000 });
    expect(result.events.map(({ type, reason }) => [type, reason])).toEqual([["universe", "universe-incomplete"]]);

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s3", 1_200, [candidate("basis", "route-a", "o2", 90, 1_200)]), configured);
    expect(result.routes[0]).toMatchObject({ status: "confirmed", actionable: true, confirmedAt: 1_000 });
    expect(result.events.map(({ type, reason }) => [type, reason])).toEqual([["universe", "universe-restored"]]);

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s4", 6_201, [], false), configured);
    expect(result.routes[0]).toMatchObject({ status: "decaying", actionable: false, decayStartedAt: 6_200, lastReason: "evidence-stale" });
    expect(result.events.at(-1)).toMatchObject({ from: "confirmed", to: "decaying", reason: "evidence-stale", effectiveAt: 6_200, evaluatedAt: 6_201 });
  });

  it("derives incomplete coverage from stale, truncated or failed-source flags", () => {
    for (const [index, coverage] of [
      { complete: true, stale: true, truncated: false, failedSources: [] },
      { complete: true, stale: false, truncated: true, failedSources: [] },
      { complete: true, stale: false, truncated: false, failedSources: ["venue:failed"] }
    ].entries()) {
      const partial = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), { ...snapshot(`basis-feed-${index}`, `s${index}`, 1_000, [candidate("basis", "route-a", `o${index}`, 100, 1_000)]), coverage }, policy({ confirmationObservations: 1 }));
      expect(partial.universeComplete).toBe(false);
      expect(partial.routes[0]).toMatchObject({ status: "first-seen", confirmationCount: 0, actionable: false, lastReason: "universe-incomplete" });
    }
  });

  it("decays an absent route only after a complete scan and expires on the exact grace boundary", () => {
    const configured = policy({ confirmationObservations: 1, decayGraceMs: 500 });
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("pairwise-feed", "s1", 1_000, [candidate("pairwise", "route-a", "o1", 100, 1_000)]), configured);
    result = evaluateOpportunityLifecycle(result.state, snapshot("pairwise-feed", "s2", 1_100, []), configured);
    expect(result.routes[0]).toMatchObject({ status: "decaying", decayStartedAt: 1_100, lastReason: "route-absent" });

    result = evaluateOpportunityLifecycle(result.state, snapshot("pairwise-feed", "s3", 1_599, []), configured);
    expect(result.routes[0]?.status).toBe("decaying");
    result = evaluateOpportunityLifecycle(result.state, snapshot("pairwise-feed", "s4", 1_600, []), configured);
    expect(result.routes[0]).toMatchObject({ status: "expired", expiredAt: 1_600, lastReason: "decay-grace-elapsed" });
  });

  it("aggregates route evidence by its weakest leg and refuses incomplete evidence", () => {
    const evidence = [leg("venue:a", 1_000, "verified"), leg("venue:b", 1_000, "fresh"), leg("venue:c", 1_000, "degraded")];
    const degraded = candidate("triangular", "cycle-a", "o1", 100, 1_000, evidence);
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("triangular-feed", "s1", 1_000, [degraded]), policy({ minimumEvidenceSources: 3 }));
    expect(result.routes[0]).toMatchObject({ status: "decaying", rawEvidenceQuality: "degraded", effectiveEvidenceQuality: "degraded", evidenceSourceIds: ["venue:a", "venue:b", "venue:c"], lastReason: "evidence-quality" });

    const incomplete = candidate("triangular", "cycle-b", "o2", 100, 1_100, [leg("a", 1_100), leg("b", 1_100), { ...leg("c", 1_100), complete: false }]);
    result = evaluateOpportunityLifecycle(result.state, snapshot("triangular-feed", "s2", 1_100, [incomplete]), policy({ minimumEvidenceSources: 3 }));
    expect(result.routes.find(({ routeId }) => routeId === "cycle-b")).toMatchObject({ status: "decaying", evidenceComplete: false, lastReason: "evidence-incomplete" });
  });

  it("deduplicates exact candidates and observations while rejecting equivocation", () => {
    const configured = policy();
    const row = candidate("basis", "route-a", "o1", 100, 1_000);
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [row, structuredClone(row)]), configured);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.confirmationCount).toBe(1);

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s2", 1_100, [row]), configured);
    expect(result.routes[0]).toMatchObject({ status: "first-seen", confirmationCount: 1, actionable: false });
    expect(result.events).toEqual([expect.objectContaining({ type: "evidence-rejected", reason: "observation-replayed" })]);

    const conflict = evaluateOpportunityLifecycle(
      result.state,
      snapshot("basis-feed", "s3", 1_200, [
        { ...row, observationId: "o2", score: 100 },
        { ...row, observationId: "o2", score: 101 }
      ]),
      configured
    );
    expect(conflict.universeComplete).toBe(false);
    expect(conflict.routes[0]?.actionable).toBe(false);
    expect(conflict.events).toEqual([expect.objectContaining({ type: "universe", reason: "duplicate-route-conflict" }), expect.objectContaining({ type: "evidence-rejected", routeId: "route-a", reason: "duplicate-route-conflict" })]);
  });

  it("makes a semantically identical snapshot idempotent and rejects snapshot-id equivocation", () => {
    const firstSnapshot = snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-b", "b1", 100, 1_000), candidate("basis", "route-a", "a1", 100, 1_000)]);
    const first = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), firstSnapshot, policy());
    const reordered = { ...firstSnapshot, candidates: [...firstSnapshot.candidates].reverse() };
    const repeated = evaluateOpportunityLifecycle(first.state, reordered, policy());
    expect(repeated).toMatchObject({ idempotent: true, events: [] });
    expect(repeated.state).toEqual(first.state);
    expect(() => evaluateOpportunityLifecycle(first.state, { ...firstSnapshot, candidates: [{ ...firstSnapshot.candidates[0]!, score: 101 }] }, policy())).toThrow(/snapshotId cannot be reused/);
  });

  it("keeps universes independent and supports every current scanner family", () => {
    const kinds: OpportunityLifecycleKind[] = ["basis", "triangular", "native-spread", "pairwise"];
    let state = createOpportunityLifecycleState();
    for (const [index, kind] of kinds.entries()) {
      const result = evaluateOpportunityLifecycle(state, snapshot(`${kind}-feed`, `s${index}`, 1_000 + index, [candidate(kind, `route-${kind}`, `o${index}`, 100, 1_000 + index)]), policy({ confirmationObservations: 1 }));
      state = result.state;
    }
    expect(Object.values(state.routes).map(({ universeId, kind, status }) => [universeId, kind, status])).toEqual([
      ["basis-feed", "basis", "confirmed"],
      ["triangular-feed", "triangular", "confirmed"],
      ["native-spread-feed", "native-spread", "confirmed"],
      ["pairwise-feed", "pairwise", "confirmed"]
    ]);

    const incompleteBasis = evaluateOpportunityLifecycle(state, snapshot("basis-feed", "basis-incomplete", 2_000, [], false), policy({ confirmationObservations: 1 }));
    expect(incompleteBasis.routes).toHaveLength(1);
    expect(incompleteBasis.routes[0]).toMatchObject({ kind: "basis", actionable: false });
    expect(incompleteBasis.state.routes["triangular-feed\u001ftriangular\u001froute-triangular"]).toMatchObject({ actionable: true });
  });

  it("binds immutable policy values to an explicit policy version", () => {
    const first = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "o1", 100, 1_000)]), policy());
    expect(first.state.policies["policy-v1"]).toMatch(/^[a-f0-9]{64}$/);
    expect(() => evaluateOpportunityLifecycle(first.state, snapshot("basis-feed", "s2", 1_100, [candidate("basis", "route-a", "o2", 100, 1_100)]), policy({ enterScore: 101 }))).toThrow(/policyId cannot be reused/);

    const changed = evaluateOpportunityLifecycle(first.state, snapshot("basis-feed", "s2", 1_100, [candidate("basis", "route-a", "o2", 101, 1_100)], true, "policy-v2"), policy({ enterScore: 101 }));
    expect(changed.events[0]).toMatchObject({ type: "universe", reason: "policy-changed", policyId: "policy-v2" });
    expect(changed.routes[0]?.policyId).toBe("policy-v2");
  });

  it("accepts native triangular route/source identities and honors minimum confirmation duration", () => {
    const routeId = "binance:USDT:USDT>BTC>ETH>USDT";
    const configured = policy({ confirmationObservations: 2, confirmationMinDurationMs: 500 });
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("triangular-feed", "s1", 1_000, [candidate("triangular", routeId, "depth@1", 100, 1_000, [leg("binance:BTCUSDT@depth", 1_000), leg("binance:ETHBTC@depth", 1_000), leg("binance:ETHUSDT@depth", 1_000)])]), configured);
    result = evaluateOpportunityLifecycle(result.state, snapshot("triangular-feed", "s2", 1_100, [candidate("triangular", routeId, "depth@2", 100, 1_100, [leg("binance:BTCUSDT@depth", 1_100), leg("binance:ETHBTC@depth", 1_100), leg("binance:ETHUSDT@depth", 1_100)])]), configured);
    expect(result.routes[0]).toMatchObject({ status: "first-seen", confirmationCount: 2, actionable: false });
    result = evaluateOpportunityLifecycle(result.state, snapshot("triangular-feed", "s3", 1_500, [candidate("triangular", routeId, "depth@3", 100, 1_500, [leg("binance:BTCUSDT@depth", 1_500), leg("binance:ETHBTC@depth", 1_500), leg("binance:ETHUSDT@depth", 1_500)])]), configured);
    expect(result.routes[0]).toMatchObject({ routeId, status: "confirmed", confirmationCount: 3, actionable: true, confirmedAt: 1_500 });
  });

  it("bounds route tombstones and deterministic event history", () => {
    const configured = policy({ confirmationObservations: 1, maxRoutes: 2, maxEvents: 3, decayGraceMs: 0, expiredRetentionMs: 0 });
    let result = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "a1", 100, 1_000), candidate("basis", "route-b", "b1", 100, 1_000), candidate("basis", "route-c", "c1", 100, 1_000)]), configured);
    expect(result.routes).toHaveLength(2);
    expect(result.events.at(-1)).toMatchObject({ routeId: "route-c", reason: "route-capacity-reached" });
    expect(result.state.history).toHaveLength(3);

    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s2", 1_001, []), configured);
    expect(result.routes.every(({ status }) => status === "expired")).toBe(true);
    result = evaluateOpportunityLifecycle(result.state, snapshot("basis-feed", "s3", 1_002, [candidate("basis", "route-c", "c2", 100, 1_002)]), configured);
    expect(result.routes).toEqual([expect.objectContaining({ routeId: "route-c", status: "confirmed" })]);
    expect(result.state.history).toHaveLength(3);
    expect(result.state.nextEventSequence).toBeGreaterThan(3);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
  });

  it("rejects invalid policy, future evidence and non-monotonic snapshots fail closed", () => {
    expect(() => evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, []), policy({ enterScore: 10, exitScore: 11 }))).toThrow(/exitScore/);
    const future = evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "s1", 1_000, [candidate("basis", "route-a", "o1", 100, 2_001)]), policy({ maxFutureSkewMs: 1_000 }));
    expect(future.routes).toEqual([]);
    expect(future.events.at(-1)).toMatchObject({ type: "evidence-rejected", reason: "observation-future" });
    expect(() => evaluateOpportunityLifecycle(future.state, snapshot("basis-feed", "s2", 999, []), policy())).toThrow(/monotonic/);

    const oversized = Array<OpportunityLifecycleCandidate>(100_001).fill(candidate("basis", "route-a", "o1", 100, 1_000));
    expect(() => evaluateOpportunityLifecycle(createOpportunityLifecycleState(), snapshot("basis-feed", "oversized", 1_000, oversized), policy({ maxCandidatesPerSnapshot: 100_000 }))).toThrow(/absolute bound/);
  });
});

function policy(overrides: Partial<OpportunityLifecyclePolicy> = {}): Partial<OpportunityLifecyclePolicy> {
  return { enterScore: 100, exitScore: 80, confirmationObservations: 2, observationFreshForMs: 5_000, decayGraceMs: 1_000, ...overrides };
}

function snapshot(universeId: string, snapshotId: string, evaluatedAt: number, candidates: OpportunityLifecycleCandidate[], complete = true, policyId = "policy-v1"): OpportunityLifecycleSnapshot {
  return { universeId, policyId, snapshotId, evaluatedAt, coverage: { complete, stale: false, truncated: false, failedSources: complete ? [] : ["venue:offline"] }, candidates };
}

function candidate(kind: OpportunityLifecycleKind, routeId: string, observationId: string, score: number, observedAt: number, evidence = [leg("venue:spot", observedAt), leg("venue:derivative", observedAt)]): OpportunityLifecycleCandidate {
  return { kind, routeId, observationId, score, evidence };
}

function leg(sourceId: string, observedAt: number, quality: OpportunityEvidenceQuality = "verified") {
  return { sourceId, observedAt, quality, complete: true } as const;
}
