// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPaperMultiLegRun } from "../src/trading/paperMultiLegClient";
import { parsePaperMultiLegListResponse, parsePaperMultiLegPlanJson, parsePaperMultiLegRecoveryResponse, parsePaperMultiLegRunResponse } from "../src/trading/paperMultiLegParser";
import type { PaperMultiLegFill, PaperMultiLegPlan, PaperMultiLegRunView } from "../src/trading/paperMultiLegTypes";

const NOW = 2_000_000_000_000;
const SAFETY = { executionMode: "paper-only", liveOrders: false, privateRequests: false, credentialsAccepted: false } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("paper multi-leg browser boundary", () => {
  it("accepts an exact short-lived plan and rejects credentials, unknown fields and oversized input", () => {
    const value = plan();
    expect(parsePaperMultiLegPlanJson(JSON.stringify(value))).toEqual(value);
    expect(() => parsePaperMultiLegPlanJson(JSON.stringify({ ...value, apiKey: "must-never-enter" }))).toThrow(/unknown fields/);
    expect(() => parsePaperMultiLegPlanJson(JSON.stringify({ ...value, source: { ...value.source, secret: "must-never-enter" } }))).toThrow(/unknown fields/);
    expect(() => parsePaperMultiLegPlanJson(" ".repeat(64 * 1024 + 1))).toThrow(/64 KB/);
  });

  it("validates the safety envelope, append-only sequence and deterministic fill evidence", () => {
    const response = runResponse();
    expect(parsePaperMultiLegRunResponse(response).run.state.status).toBe("completed");

    const liveSafety = structuredClone(response);
    liveSafety.safety.liveOrders = true as false;
    expect(() => parsePaperMultiLegRunResponse(liveSafety)).toThrow(/safety.liveOrders/);

    const reordered = structuredClone(response);
    reordered.run.events[2]!.sequence = 9;
    expect(() => parsePaperMultiLegRunResponse(reordered)).toThrow(/sequence/);

    const forgedFill = structuredClone(response);
    forgedFill.run.state.originalFills[0]!.filledQuantity = 0.5;
    forgedFill.run.state.originalFills[0]!.unfilledQuantity = 0.5;
    forgedFill.run.state.originalFills[0]!.fillRatioBps = 5_000;
    forgedFill.run.state.originalFills[0]!.status = "partially-filled";
    forgedFill.run.events[1]!.data = { fill: structuredClone(forgedFill.run.state.originalFills[0]!) };
    expect(() => parsePaperMultiLegRunResponse(forgedFill)).toThrow(/deterministic plan leg/);

    const credentialLeak = structuredClone(response) as typeof response & { apiSecret?: string };
    credentialLeak.apiSecret = "must-never-render";
    expect(() => parsePaperMultiLegRunResponse(credentialLeak)).toThrow(/unknown fields/);
  });

  it("bounds lists and requires completed recovery evidence", () => {
    const summary = { runId: plan().runId, sourceKind: "n-leg", opportunityId: "opportunity:frontend-paper-run", status: "completed", legCount: 4, createdAt: NOW, updatedAt: NOW + 5 };
    expect(parsePaperMultiLegListResponse(envelope({ runs: [summary] })).runs).toHaveLength(1);
    expect(() => parsePaperMultiLegListResponse(envelope({ runs: Array.from({ length: 101 }, (_, index) => ({ ...summary, runId: `frontend-paper-${index}` })) }))).toThrow(/100 rows/);
    expect(parsePaperMultiLegRecoveryResponse(envelope({ recovery: { status: "ready", recoveredRuns: 2, startedAt: NOW, completedAt: NOW + 10 } })).recovery.recoveredRuns).toBe(2);
    expect(() => parsePaperMultiLegRecoveryResponse(envelope({ recovery: { status: "ready", recoveredRuns: 0 } }))).toThrow(/timestamps/);
  });

  it("uses the internal cookie session, CSRF token and idempotency key on mutation", async () => {
    sessionStorage.setItem("sbv2:session", "1");
    sessionStorage.setItem("sbv2:csrf", "csrf-paper-test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPaperMultiLegRun(plan(), "idem-frontend-paper")).rejects.toThrow(/missing or unknown fields/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/trade/paper-multi-leg/runs");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(headers.get("X-CSRF-Token")).toBe("csrf-paper-test");
    expect(headers.get("Idempotency-Key")).toBe("idem-frontend-paper");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ plan: plan() });
  });
});

function plan(): PaperMultiLegPlan {
  return {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId: "frontend-paper-run",
    source: { kind: "n-leg", engine: "n-leg-v1", opportunityId: "opportunity:frontend-paper-run", evaluatedAt: NOW - 10, provenanceHash: "a".repeat(64) },
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: Array.from({ length: 4 }, (_, index) => ({
      legId: `leg-${index}`,
      venue: "test",
      instrumentId: `test:spot:ASSET${index}`,
      side: index % 2 === 0 ? ("buy" as const) : ("sell" as const),
      quantityUnit: "base" as const,
      plannedQuantity: index + 1,
      referencePrice: 100 + index,
      feeBps: 2,
      paperFillRatioBps: 10_000,
      paperCompensationFillRatioBps: 10_000,
      paperCompensationPrice: 100.5 + index,
      paperCompensationFeeBps: 3,
      evidenceId: `fixture:book:${index}`
    }))
  };
}

function runResponse() {
  const value = plan();
  const planHash = "b".repeat(64);
  const fills = value.legs.map(
    (leg, index): PaperMultiLegFill => ({
      kind: "original",
      legIndex: index,
      legId: leg.legId,
      venue: leg.venue,
      instrumentId: leg.instrumentId,
      side: leg.side,
      quantityUnit: leg.quantityUnit,
      requestedQuantity: leg.plannedQuantity,
      filledQuantity: leg.plannedQuantity,
      unfilledQuantity: 0,
      fillRatioBps: 10_000,
      status: "filled",
      averagePrice: leg.referencePrice,
      estimatedFee: rounded((leg.plannedQuantity * leg.referencePrice * leg.feeBps) / 10_000),
      evidenceId: leg.evidenceId
    })
  );
  const terminal = { status: "completed", reason: "all-paper-legs-filled", unresolvedExposure: [] } as const;
  const events: PaperMultiLegRunView["events"] = [
    { eventId: `${value.runId}:1`, runId: value.runId, sequence: 1, ts: NOW, type: "run-created", data: { plan: value, planHash, safety: SAFETY } },
    ...fills.map((fill, index) => ({ eventId: `${value.runId}:${index + 2}`, runId: value.runId, sequence: index + 2, ts: NOW + index + 1, type: "original-fill" as const, data: { fill } })),
    { eventId: `${value.runId}:6`, runId: value.runId, sequence: 6, ts: NOW + 5, type: "run-terminal", data: { terminal } }
  ];
  return envelope({
    run: {
      state: {
        runId: value.runId,
        planHash,
        plan: value,
        status: "completed",
        originalFills: fills,
        compensationFills: [],
        terminal,
        lastSequence: 6,
        createdAt: NOW,
        updatedAt: NOW + 5
      },
      events
    }
  });
}

function envelope<T extends Record<string, unknown>>(body: T): T & { schemaVersion: "paper-multi-leg-api-v1"; safety: typeof SAFETY } {
  return { schemaVersion: "paper-multi-leg-api-v1", safety: structuredClone(SAFETY), ...body };
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}
