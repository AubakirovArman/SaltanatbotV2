import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseLifecycleResponse } from "./lifecycle.js";

describe("opportunity lifecycle SDK", () => {
  it("parses bounded read-only lifecycle state", () => {
    const parsed = parseLifecycleResponse(fixture());
    expect(parsed).toMatchObject({
      readOnly: true,
      executionPermission: false,
      summary: { returnedRoutes: 1, returnedEvents: 2 },
      routes: [{ status: "confirmed", actionable: true }]
    });
  });

  it("rejects forged permission, route keys, evidence and event order", () => {
    expect(() => parseLifecycleResponse({ ...fixture(), executionPermission: true })).toThrow(/safety envelope/);
    const key = structuredClone(fixture());
    key.routes[0]!.key = "forged";
    expect(() => parseLifecycleResponse(key)).toThrow(/key/);
    const evidence = structuredClone(fixture());
    evidence.routes[0]!.effectiveEvidenceQuality = "degraded";
    expect(() => parseLifecycleResponse(evidence)).toThrow(/actionable/);
    const order = structuredClone(fixture());
    order.events.reverse();
    expect(() => parseLifecycleResponse(order)).toThrow(/newest first/);
  });

  it("calls the public lifecycle endpoint with bounded filters", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
    const client = new SaltanatArbitrageClient({ baseUrl: "https://scanner.example", fetch: fetcher });
    await expect(client.lifecycle({ kind: "basis", actionable: true, routeLimit: 25 })).resolves.toMatchObject({ readOnly: true });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/arbitrage/lifecycle");
    expect(url.searchParams.get("kind")).toBe("basis");
    expect(url.searchParams.get("actionable")).toBe("true");
    expect(url.searchParams.get("routeLimit")).toBe("25");
  });
});

function fixture() {
  const universeId = "basis:test";
  const policyId = "basis-policy:v1";
  const routeId = "BTCUSDT:binance:bybit";
  return {
    schemaVersion: 1,
    readOnly: true,
    executionPermission: false,
    generatedAt: 2_000,
    runtime: { acceptedSnapshots: 2, rejectedSnapshots: 0, lastAcceptedAt: 1_500 },
    summary: {
      universeCount: 1,
      retainedRoutes: 1,
      matchedRoutes: 1,
      returnedRoutes: 1,
      routesTruncated: false,
      retainedEvents: 2,
      matchedEvents: 2,
      returnedEvents: 2,
      eventsTruncated: false,
      nextEventSequence: 3
    },
    universes: [{ universeId, lastPolicyId: policyId, lastSnapshotId: "basis:1500:abc", lastSnapshotFingerprint: `sha256:${"a".repeat(64)}`, lastEvaluatedAt: 1_500, coverageComplete: true, lastCoverageReason: "universe-restored" }],
    routes: [
      {
        key: `${universeId}\u001fbasis\u001f${routeId}`,
        universeId,
        policyId,
        kind: "basis",
        routeId,
        status: "confirmed",
        actionable: true,
        firstSeenAt: 1_000,
        lastSeenAt: 1_500,
        lastObservationAt: 1_490,
        lastObservationId: "basis-observation:abc",
        recentObservationIds: ["basis-observation:abc", "basis-observation:def"],
        score: 25,
        rawEvidenceQuality: "verified",
        effectiveEvidenceQuality: "verified",
        evidenceSourceIds: ["binance:spot:BTCUSDT", "bybit:perpetual:BTCUSDT"],
        evidenceComplete: true,
        confirmationCount: 2,
        confirmationStartedAt: 1_000,
        confirmedAt: 1_500,
        lastReason: "confirmation-complete"
      }
    ],
    events: [
      { id: "opportunity-lifecycle:2", sequence: 2, type: "transition", universeId, policyId, kind: "basis", routeId, from: "first-seen", to: "confirmed", reason: "confirmation-complete", effectiveAt: 1_500, evaluatedAt: 1_500, observationId: "basis-observation:def" },
      { id: "opportunity-lifecycle:1", sequence: 1, type: "transition", universeId, policyId, kind: "basis", routeId, to: "first-seen", reason: "candidate-observed", effectiveAt: 1_000, evaluatedAt: 1_000, observationId: "basis-observation:abc" }
    ]
  };
}
