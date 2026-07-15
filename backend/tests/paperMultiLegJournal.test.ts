import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperMultiLegCapacityError, PaperMultiLegIdempotencyConflictError, PaperMultiLegJournal, PaperMultiLegService, replayPaperMultiLegEvents, type PaperMultiLegPlan } from "../src/arbitrage/paperMultiLeg/index.js";

const NOW = 2_000_000_000_000;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("paper multi-leg deterministic journal", () => {
  it("records a fully filled N-leg paper cycle without compensation", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const result = service.submitAndRun(plan("complete-run", [10_000, 10_000, 10_000, 10_000]), "idem-complete-run");

    expect(result.created).toBe(true);
    expect(result.run.state).toMatchObject({ status: "completed", lastSequence: 6 });
    expect(result.run.state.originalFills).toHaveLength(4);
    expect(result.run.state.compensationFills).toEqual([]);
    expect(result.run.state.terminal).toEqual({
      status: "completed",
      reason: "all-paper-legs-filled",
      unresolvedExposure: []
    });
    expect(result.run.events.map(({ type }) => type)).toEqual(["run-created", "original-fill", "original-fill", "original-fill", "original-fill", "run-terminal"]);
    journal.close();
  });

  it("stops at a partial leg and reverses every filled paper leg in reverse order", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const result = service.submitAndRun(plan("partial-compensated", [10_000, 4_000, 10_000, 10_000]), "idem-partial-compensated");
    const state = result.run.state;

    expect(state.status).toBe("compensated");
    expect(state.originalFills.map(({ legId, status, filledQuantity }) => [legId, status, filledQuantity])).toEqual([
      ["leg-0", "filled", 1],
      ["leg-1", "partially-filled", 0.8]
    ]);
    expect(state.compensationDecision).toEqual({
      action: "reverse-filled-legs",
      reason: "original-leg-incomplete",
      targetLegIds: ["leg-1", "leg-0"],
      expectedFullCompensation: true
    });
    expect(state.compensationFills.map(({ legId, side, filledQuantity }) => [legId, side, filledQuantity])).toEqual([
      ["leg-1", "buy", 0.8],
      ["leg-0", "sell", 1]
    ]);
    expect(state.terminal).toEqual({
      status: "compensated",
      reason: "all-paper-exposure-reversed",
      unresolvedExposure: []
    });
    journal.close();
  });

  it("fails closed with exact unresolved quantities when paper compensation is partial", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const input = plan("manual-review-run", [10_000, 5_000, 10_000, 10_000]);
    input.legs[1]!.paperCompensationFillRatioBps = 2_500;
    const result = service.submitAndRun(input, "idem-manual-review");

    expect(result.run.state.status).toBe("manual-review-required");
    expect(result.run.state.compensationDecision?.expectedFullCompensation).toBe(false);
    expect(result.run.state.terminal).toEqual({
      status: "manual-review-required",
      reason: "paper-compensation-incomplete",
      unresolvedExposure: [{ legId: "leg-1", instrumentId: "test:spot:ASSET1", quantityUnit: "base", quantity: 0.75 }]
    });
    journal.close();
  });

  it("records an explicit no-exposure abort when the first leg is unfilled", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const result = service.submitAndRun(plan("unfilled-first-run", [0, 10_000, 10_000, 10_000]), "idem-unfilled-first");

    expect(result.run.state.status).toBe("aborted-no-exposure");
    expect(result.run.state.compensationDecision).toEqual({
      action: "none-no-exposure",
      reason: "original-leg-incomplete",
      targetLegIds: [],
      expectedFullCompensation: true
    });
    expect(result.run.state.compensationFills).toEqual([]);
    journal.close();
  });

  it("is idempotent for an exact retry and rejects a conflicting payload", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const input = plan("idempotent-run", [10_000, 10_000, 10_000, 10_000]);
    const first = service.submitAndRun(input, "idem-exact-retry");
    const second = service.submitAndRun(structuredClone(input), "idem-exact-retry", NOW + 60_000);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.events).toEqual(first.run.events);
    const conflict = structuredClone(input);
    conflict.runId = "different-run-id";
    expect(() => service.submitAndRun(conflict, "idem-exact-retry")).toThrow(PaperMultiLegIdempotencyConflictError);
    journal.close();
  });

  it("recovers an interrupted partial-fill journal after a real close/reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "saltanat-paper-multileg-"));
    directories.push(directory);
    const path = join(directory, "paper-multi-leg.sqlite");
    const firstJournal = PaperMultiLegJournal.open(path);
    const input = plan("restart-recovery-run", [10_000, 5_000, 10_000, 10_000]);
    firstJournal.createRun(input, "idem-restart-recovery", NOW);
    firstJournal.advance(input.runId, NOW + 1);
    const interrupted = firstJournal.advance(input.runId, NOW + 2);
    expect(interrupted).toMatchObject({ status: "awaiting-compensation-decision", lastSequence: 3 });
    firstJournal.close();

    const reopened = PaperMultiLegJournal.open(path);
    const recovered = new PaperMultiLegService(reopened, () => NOW + 10);
    expect(recovered.recoverIncomplete()).toBe(1);
    const view = recovered.getRun(input.runId);
    expect(view?.state).toMatchObject({ status: "compensated", lastSequence: 7 });
    expect(view?.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(recovered.recoverIncomplete()).toBe(0);
    reopened.close();
  });

  it("blocks stored-event tampering and never replays a forged transition", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const input = plan("tamper-proof-run", [10_000, 5_000, 10_000, 10_000]);
    journal.createRun(input, "idem-tamper-proof", NOW);
    journal.advance(input.runId, NOW + 1);
    expect(() => journal.database.prepare("UPDATE paper_multi_leg_events SET data = ? WHERE runId = ? AND sequence = 2").run(JSON.stringify({ fill: { forged: true } }), input.runId)).toThrow("append-only");
    const view = journal.getRun(input.runId);
    const forged = structuredClone(view!.events);
    (forged[1] as unknown as { data: unknown }).data = { fill: { forged: true } };
    expect(() => replayPaperMultiLegEvents(forged, "idem-tamper-proof")).toThrow("is not the deterministic next transition");
    journal.close();
  });

  it("hard-stops at the configured run cap instead of deleting audit history", () => {
    const journal = PaperMultiLegJournal.open(":memory:", { maxRuns: 1 });
    const service = new PaperMultiLegService(journal, () => NOW);
    service.submitAndRun(plan("capacity-run-one", [10_000, 10_000, 10_000, 10_000]), "idem-capacity-one");
    expect(() => service.submitAndRun(plan("capacity-run-two", [10_000, 10_000, 10_000, 10_000]), "idem-capacity-two")).toThrow(PaperMultiLegCapacityError);
    expect(service.listRuns()).toHaveLength(1);
    journal.close();
  });

  it("rejects reordered, gapped and post-terminal event streams", () => {
    const journal = PaperMultiLegJournal.open(":memory:");
    const service = new PaperMultiLegService(journal, () => NOW);
    const view = service.submitAndRun(plan("replay-guard-run", [10_000, 10_000, 10_000, 10_000]), "idem-replay-guard").run;
    const gap = view.events.filter(({ sequence }) => sequence !== 3);
    expect(() => replayPaperMultiLegEvents(gap, "idem-replay-guard")).toThrow("Invalid paper multi-leg event header");
    const extra = { ...view.events.at(-1)!, sequence: 7, eventId: "replay-guard-run:7" };
    expect(() => replayPaperMultiLegEvents([...view.events, extra], "idem-replay-guard")).toThrow("after terminal state");
    journal.close();
  });
});

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
