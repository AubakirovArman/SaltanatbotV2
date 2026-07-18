import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createPaperMultiLegInitialEvent, nextPaperMultiLegEvent, replayPaperMultiLegEvents } from "../src/arbitrage/paperMultiLeg/engine.js";
import { paperMultiLegHash } from "../src/arbitrage/paperMultiLeg/canonical.js";
import type { PaperMultiLegPlan } from "../src/arbitrage/paperMultiLeg/types.js";
import {
  appendPaperMultiLegIntentEventIn,
  countRunningPaperMultiLegIntentsFrom,
  createPaperMultiLegIntentIn,
  finalizePaperMultiLegIntentIn,
  getPaperMultiLegIntentFrom,
  listPaperMultiLegIntentEventsFrom,
  listPaperMultiLegIntentsFrom,
  listRunningPaperMultiLegIntentIdentitiesFrom,
  paperMultiLegEventIdempotencyKey,
  paperMultiLegIntentIdFor,
  recordPaperMultiLegReceiptIn,
  sumRunningPaperMultiLegReservedMicrosFrom
} from "../src/trading/multiLeg/intentStore.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";

const NOW = 2_000_000_000_000;
const OWNER = "intent-store-owner";
const OTHER = "intent-store-other";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  databases.push(value);
  migrateTradingStore(value, () => NOW, { legacyOwnerUserId: OWNER });
  return value;
}

function plan(runId: string): PaperMultiLegPlan {
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
    legs: [10_000, 10_000, 10_000, 10_000].map((paperFillRatioBps, index) => ({
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
      paperCompensationPrice: 100 + index,
      paperCompensationFeeBps: 2,
      evidenceId: `fixture:book:${index}`
    }))
  };
}

function createIntent(
  value: DatabaseSync,
  owner: string,
  key: string,
  overrides: { portfolioId?: string; reservedCapitalMicros?: number; now?: number } = {}
) {
  const intentId = paperMultiLegIntentIdFor(owner, key);
  const built = plan(intentId);
  return createPaperMultiLegIntentIn(value, owner, {
    intentId,
    portfolioId: overrides.portfolioId ?? "portfolio-1",
    portfolioEpoch: 1,
    plan: built,
    planHash: paperMultiLegHash(built),
    reservedCapitalMicros: overrides.reservedCapitalMicros ?? 1_000_000,
    now: overrides.now ?? NOW
  });
}

describe("multi-leg intent identity", () => {
  it("derives stable owner-scoped intent ids and the canonical event idempotency key", () => {
    const id = paperMultiLegIntentIdFor(OWNER, "submit-key-1");
    expect(id).toMatch(/^mleg-[0-9a-f]{32}$/);
    expect(paperMultiLegIntentIdFor(` ${OWNER} `, " submit-key-1 ")).toBe(id);
    expect(paperMultiLegIntentIdFor(OTHER, "submit-key-1")).not.toBe(id);
    expect(paperMultiLegIntentIdFor(OWNER, "submit-key-2")).not.toBe(id);

    expect(paperMultiLegEventIdempotencyKey(id, 3)).toBe(`mleg:${id}:3`);
    expect(() => paperMultiLegEventIdempotencyKey(id, 0)).toThrow(/positive/i);
  });
});

describe("multi-leg intent rows", () => {
  it("creates and lists intents strictly per owner and portfolio", () => {
    const value = database();
    const first = createIntent(value, OWNER, "list-1", { portfolioId: "portfolio-1", reservedCapitalMicros: 100, now: NOW });
    const second = createIntent(value, OWNER, "list-2", { portfolioId: "portfolio-2", reservedCapitalMicros: 200, now: NOW + 1_000 });
    const foreign = createIntent(value, OTHER, "list-1", { portfolioId: "portfolio-1", reservedCapitalMicros: 400, now: NOW + 2_000 });

    expect(first).toMatchObject({
      ownerUserId: OWNER,
      status: "running",
      sourceEngine: "n-leg-v1",
      sourceOpportunityId: `opportunity:${first.intentId}`,
      sourceEvaluatedAt: NOW - 10,
      reservedCapitalMicros: 100
    });
    expect(first.terminalOutcome).toBeUndefined();
    expect(first.netPnlMicros).toBeUndefined();

    expect(getPaperMultiLegIntentFrom(value, OTHER, first.intentId)).toBeUndefined();
    expect(listPaperMultiLegIntentsFrom(value, OWNER).map((intent) => intent.intentId))
      .toEqual([second.intentId, first.intentId]);
    expect(listPaperMultiLegIntentsFrom(value, OWNER, { portfolioId: "portfolio-2" }).map((intent) => intent.intentId))
      .toEqual([second.intentId]);
    expect(countRunningPaperMultiLegIntentsFrom(value, OWNER)).toBe(2);
    expect(countRunningPaperMultiLegIntentsFrom(value, OWNER, "portfolio-1")).toBe(1);
    expect(sumRunningPaperMultiLegReservedMicrosFrom(value, OWNER, "portfolio-1")).toBe(100);
    expect(sumRunningPaperMultiLegReservedMicrosFrom(value, OTHER, "portfolio-1")).toBe(400);
    expect(listRunningPaperMultiLegIntentIdentitiesFrom(value)).toEqual([
      { ownerUserId: OWNER, intentId: first.intentId },
      { ownerUserId: OWNER, intentId: second.intentId },
      { ownerUserId: OTHER, intentId: foreign.intentId }
    ]);
  });

  it("rejects duplicate intents and malformed creation input", () => {
    const value = database();
    createIntent(value, OWNER, "duplicate-key");
    expect(() => createIntent(value, OWNER, "duplicate-key")).toThrow(/already exists/i);

    const intentId = paperMultiLegIntentIdFor(OWNER, "bad-hash");
    const built = plan(intentId);
    expect(() => createPaperMultiLegIntentIn(value, OWNER, {
      intentId,
      portfolioId: "portfolio-1",
      portfolioEpoch: 1,
      plan: built,
      planHash: "not-a-hash",
      reservedCapitalMicros: 1_000_000,
      now: NOW
    })).toThrow(/64 hexadecimal/i);
    expect(() => createPaperMultiLegIntentIn(value, OWNER, {
      intentId,
      portfolioId: "portfolio-1",
      portfolioEpoch: 1,
      plan: built,
      planHash: paperMultiLegHash(built),
      reservedCapitalMicros: 0,
      now: NOW
    })).toThrow(/reserved capital/i);
  });
});

describe("multi-leg intent event journal", () => {
  it("appends engine events with contiguous sequences and rejects mismatched runs", () => {
    const value = database();
    const intent = createIntent(value, OWNER, "journal-key");
    const built = intent.plan;
    const initial = createPaperMultiLegInitialEvent(built, paperMultiLegHash(built), NOW);

    appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, initial);
    // Re-delivering the same sequence never lands twice.
    expect(() => appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, initial))
      .toThrow(/not contiguous/i);

    const state = replayPaperMultiLegEvents([initial], intent.intentId);
    const second = nextPaperMultiLegEvent(state, NOW + 1)!;
    const skipped = { ...second, sequence: 3, eventId: `${intent.intentId}:3` };
    expect(() => appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, skipped))
      .toThrow(/not contiguous/i);
    expect(() => appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, { ...second, runId: "other-run" }))
      .toThrow(/does not belong/i);

    appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, second);
    expect(listPaperMultiLegIntentEventsFrom(value, OWNER, intent.intentId).map((event) => event.sequence)).toEqual([1, 2]);
    expect(() => listPaperMultiLegIntentEventsFrom(value, OTHER, intent.intentId)).toThrow(/not found/i);
  });

  it("enforces the unique idempotency key and append-only triggers at the schema boundary", () => {
    const value = database();
    const intent = createIntent(value, OWNER, "append-only-key");
    const built = intent.plan;
    appendPaperMultiLegIntentEventIn(value, OWNER, intent.intentId, createPaperMultiLegInitialEvent(built, paperMultiLegHash(built), NOW));

    expect(() => value.prepare(`
      INSERT INTO paper_multi_leg_intent_events (intentId, sequence, eventJson, idempotencyKey, ts)
      VALUES ('unrelated-intent', 1, '{}', ?, ?)
    `).run(paperMultiLegEventIdempotencyKey(intent.intentId, 1), NOW)).toThrow(/unique/i);
    expect(() => value.prepare("UPDATE paper_multi_leg_intent_events SET ts = ts + 1").run()).toThrow(/append-only/);
    expect(() => value.prepare("DELETE FROM paper_multi_leg_intent_events").run()).toThrow(/append-only/);
  });
});

describe("multi-leg reservation release", () => {
  it("releases the reservation exactly once through the guarded terminal flip", () => {
    const value = database();
    const intent = createIntent(value, OWNER, "release-key", { reservedCapitalMicros: 5_000_000 });
    expect(sumRunningPaperMultiLegReservedMicrosFrom(value, OWNER, "portfolio-1")).toBe(5_000_000);

    const finalized = finalizePaperMultiLegIntentIn(value, OWNER, {
      intentId: intent.intentId,
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000,
      now: NOW + 5_000
    });
    expect(finalized).toMatchObject({
      status: "terminal",
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000,
      updatedAt: NOW + 5_000
    });
    expect(sumRunningPaperMultiLegReservedMicrosFrom(value, OWNER, "portfolio-1")).toBe(0);
    expect(countRunningPaperMultiLegIntentsFrom(value, OWNER)).toBe(0);

    // The WHERE status='running' guard makes a second release impossible.
    expect(() => finalizePaperMultiLegIntentIn(value, OWNER, {
      intentId: intent.intentId,
      terminalOutcome: "manual-review-required",
      netPnlMicros: -50_030_000,
      feesMicros: 30_000,
      now: NOW + 6_000
    })).toThrow(/already released/i);

    const built = intent.plan;
    expect(() => appendPaperMultiLegIntentEventIn(
      value, OWNER, intent.intentId,
      createPaperMultiLegInitialEvent(built, paperMultiLegHash(built), NOW)
    )).toThrow(/running intent/i);
  });

  it("rejects non-representable terminal money", () => {
    const value = database();
    const intent = createIntent(value, OWNER, "money-key");
    expect(() => finalizePaperMultiLegIntentIn(value, OWNER, {
      intentId: intent.intentId,
      terminalOutcome: "completed",
      netPnlMicros: 0.5,
      feesMicros: 0,
      now: NOW
    })).toThrow(/safe integer/i);
    expect(() => finalizePaperMultiLegIntentIn(value, OWNER, {
      intentId: intent.intentId,
      terminalOutcome: "completed",
      netPnlMicros: 0,
      feesMicros: -1,
      now: NOW
    })).toThrow(/fees/i);
    expect(getPaperMultiLegIntentFrom(value, OWNER, intent.intentId)).toMatchObject({ status: "running" });
  });
});

describe("multi-leg portfolio-less receipts", () => {
  it("records the kill-switch receipt idempotently with the paper mutation discipline", () => {
    const value = database();
    const identity = {
      mutationId: "mutation-1",
      idempotencyKey: "kill-switch-key",
      requestHash: "b".repeat(64),
      now: NOW
    };
    const first = recordPaperMultiLegReceiptIn(value, OWNER, identity, "multi-leg-kill-switch", { enabled: true });
    expect(first).toEqual({ enabled: true });

    const replayed = recordPaperMultiLegReceiptIn(value, OWNER, identity, "multi-leg-kill-switch", { enabled: true });
    expect(replayed).toEqual({ enabled: true });
    expect(value.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get()).toMatchObject({ value: 1 });

    expect(() => recordPaperMultiLegReceiptIn(
      value, OWNER,
      { ...identity, requestHash: "c".repeat(64) },
      "multi-leg-kill-switch",
      { enabled: false }
    )).toThrow(/already used/i);
  });
});
