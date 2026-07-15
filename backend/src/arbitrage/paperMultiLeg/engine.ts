import { paperMultiLegHash, stableJson } from "./canonical.js";
import { parsePaperMultiLegPlan } from "./schema.js";
import { PAPER_MULTI_LEG_SAFETY, type PaperMultiLegCompensationDecision, type PaperMultiLegEvent, type PaperMultiLegEventDraft, type PaperMultiLegFill, type PaperMultiLegPlan, type PaperMultiLegState, type PaperMultiLegTerminal, type PaperMultiLegUnresolvedExposure } from "./types.js";

const PRECISION = 12;

export function createPaperMultiLegInitialEvent(plan: PaperMultiLegPlan, planHash: string, ts: number): PaperMultiLegEvent {
  return stampPaperMultiLegEvent(plan.runId, 1, { type: "run-created", data: { plan, planHash, safety: PAPER_MULTI_LEG_SAFETY } }, ts);
}

export function stampPaperMultiLegEvent(runId: string, sequence: number, draft: PaperMultiLegEventDraft, ts: number): PaperMultiLegEvent {
  if (!runId || !Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(ts) || ts <= 0) {
    throw new Error("Invalid paper multi-leg event header");
  }
  return {
    ...draft,
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    ts
  } as PaperMultiLegEvent;
}

/** Returns exactly one deterministic next journal transition. */
export function nextPaperMultiLegEvent(state: PaperMultiLegState, ts: number): PaperMultiLegEvent | undefined {
  const draft = nextDraft(state);
  return draft ? stampPaperMultiLegEvent(state.runId, state.lastSequence + 1, draft, ts) : undefined;
}

export function replayPaperMultiLegEvents(input: readonly PaperMultiLegEvent[], idempotencyKey: string): PaperMultiLegState {
  if (input.length === 0) throw new Error("Paper multi-leg journal is empty");
  const events = [...input].sort((left, right) => left.sequence - right.sequence);
  const first = events[0];
  if (!first || first.type !== "run-created" || first.sequence !== 1) {
    throw new Error("Paper multi-leg journal must start with run-created at sequence 1");
  }
  validateHeader(first, first.runId, 1, 0);
  const created = parseCreatedData(first.data);
  const plan = parsePaperMultiLegPlan(created.plan);
  if (first.runId !== plan.runId) throw new Error("Paper multi-leg run identity mismatch");
  if (created.planHash !== paperMultiLegHash(plan)) throw new Error("Paper multi-leg plan hash mismatch");
  if (stableJson(created.safety) !== stableJson(PAPER_MULTI_LEG_SAFETY)) {
    throw new Error("Paper multi-leg safety boundary is invalid");
  }
  let state: PaperMultiLegState = {
    runId: plan.runId,
    idempotencyKey,
    planHash: created.planHash,
    plan,
    status: "executing",
    originalFills: [],
    compensationFills: [],
    lastSequence: 1,
    createdAt: first.ts,
    updatedAt: first.ts
  };
  for (const event of events.slice(1)) {
    validateHeader(event, state.runId, state.lastSequence + 1, state.updatedAt);
    const expected = nextPaperMultiLegEvent(state, event.ts);
    if (!expected) throw new Error("Paper multi-leg journal contains an event after terminal state");
    if (stableJson({ type: event.type, data: event.data }) !== stableJson({ type: expected.type, data: expected.data })) {
      throw new Error(`Paper multi-leg event ${event.sequence} is not the deterministic next transition`);
    }
    state = applyEvent(state, event);
  }
  return state;
}

function nextDraft(state: PaperMultiLegState): PaperMultiLegEventDraft | undefined {
  if (state.terminal) return undefined;
  const incomplete = state.originalFills.find((fill) => fill.status !== "filled");
  if (!incomplete && state.originalFills.length < state.plan.legs.length) {
    const legIndex = state.originalFills.length;
    return { type: "original-fill", data: { fill: originalFill(state.plan, legIndex) } };
  }
  if (!incomplete) {
    return {
      type: "run-terminal",
      data: { terminal: terminal("completed", "all-paper-legs-filled", []) }
    };
  }
  const targets = compensationTargets(state);
  if (!state.compensationDecision) {
    return {
      type: "compensation-decision",
      data: {
        decision: {
          action: targets.length > 0 ? "reverse-filled-legs" : "none-no-exposure",
          reason: "original-leg-incomplete",
          targetLegIds: targets.map((fill) => fill.legId),
          expectedFullCompensation: targets.every((fill) => state.plan.legs[fill.legIndex]?.paperCompensationFillRatioBps === 10_000)
        }
      }
    };
  }
  if (state.compensationDecision.action === "none-no-exposure") {
    return {
      type: "run-terminal",
      data: { terminal: terminal("aborted-no-exposure", "no-paper-exposure-created", []) }
    };
  }
  if (state.compensationFills.length < targets.length) {
    const original = targets[state.compensationFills.length];
    if (!original) throw new Error("Paper compensation target is missing");
    return {
      type: "compensation-fill",
      data: { fill: compensationFill(state.plan, original) }
    };
  }
  const unresolved = unresolvedExposure(targets, state.compensationFills);
  return unresolved.length === 0
    ? {
        type: "run-terminal",
        data: { terminal: terminal("compensated", "all-paper-exposure-reversed", []) }
      }
    : {
        type: "run-terminal",
        data: {
          terminal: terminal("manual-review-required", "paper-compensation-incomplete", unresolved)
        }
      };
}

function applyEvent(state: PaperMultiLegState, event: PaperMultiLegEvent): PaperMultiLegState {
  const next: PaperMultiLegState = {
    ...state,
    originalFills: [...state.originalFills],
    compensationFills: [...state.compensationFills],
    lastSequence: event.sequence,
    updatedAt: event.ts
  };
  switch (event.type) {
    case "original-fill":
      next.originalFills.push(event.data.fill);
      next.status = event.data.fill.status === "filled" ? "executing" : "awaiting-compensation-decision";
      return next;
    case "compensation-decision":
      next.compensationDecision = event.data.decision;
      next.status = event.data.decision.action === "reverse-filled-legs" ? "compensating" : "awaiting-compensation-decision";
      return next;
    case "compensation-fill":
      next.compensationFills.push(event.data.fill);
      next.status = "compensating";
      return next;
    case "run-terminal":
      next.terminal = event.data.terminal;
      next.status = event.data.terminal.status;
      return next;
    case "run-created":
      throw new Error("Paper multi-leg run may only be created once");
  }
}

function originalFill(plan: PaperMultiLegPlan, legIndex: number): PaperMultiLegFill {
  const leg = plan.legs[legIndex];
  if (!leg) throw new Error(`Paper multi-leg leg ${legIndex} is unavailable`);
  return makeFill({
    kind: "original",
    legIndex,
    legId: leg.legId,
    venue: leg.venue,
    instrumentId: leg.instrumentId,
    side: leg.side,
    quantityUnit: leg.quantityUnit,
    requestedQuantity: leg.plannedQuantity,
    fillRatioBps: leg.paperFillRatioBps,
    averagePrice: leg.referencePrice,
    feeBps: leg.feeBps,
    evidenceId: leg.evidenceId
  });
}

function compensationFill(plan: PaperMultiLegPlan, original: PaperMultiLegFill): PaperMultiLegFill {
  const leg = plan.legs[original.legIndex];
  if (!leg || leg.legId !== original.legId) throw new Error("Paper compensation leg identity mismatch");
  return makeFill({
    kind: "compensation",
    legIndex: original.legIndex,
    legId: original.legId,
    venue: original.venue,
    instrumentId: original.instrumentId,
    side: original.side === "buy" ? "sell" : "buy",
    quantityUnit: original.quantityUnit,
    requestedQuantity: original.filledQuantity,
    fillRatioBps: leg.paperCompensationFillRatioBps,
    averagePrice: leg.paperCompensationPrice,
    feeBps: leg.paperCompensationFeeBps,
    evidenceId: leg.evidenceId
  });
}

function makeFill(input: {
  kind: PaperMultiLegFill["kind"];
  legIndex: number;
  legId: string;
  venue: string;
  instrumentId: string;
  side: PaperMultiLegFill["side"];
  quantityUnit: PaperMultiLegFill["quantityUnit"];
  requestedQuantity: number;
  fillRatioBps: number;
  averagePrice: number;
  feeBps: number;
  evidenceId: string;
}): PaperMultiLegFill {
  const filledQuantity = rounded((input.requestedQuantity * input.fillRatioBps) / 10_000);
  const unfilledQuantity = rounded(input.requestedQuantity - filledQuantity);
  return {
    kind: input.kind,
    legIndex: input.legIndex,
    legId: input.legId,
    venue: input.venue,
    instrumentId: input.instrumentId,
    side: input.side,
    quantityUnit: input.quantityUnit,
    requestedQuantity: rounded(input.requestedQuantity),
    filledQuantity,
    unfilledQuantity,
    fillRatioBps: input.fillRatioBps,
    status: filledQuantity === 0 ? "unfilled" : unfilledQuantity === 0 ? "filled" : "partially-filled",
    averagePrice: input.averagePrice,
    estimatedFee: rounded((filledQuantity * input.averagePrice * input.feeBps) / 10_000),
    evidenceId: input.evidenceId
  };
}

function compensationTargets(state: PaperMultiLegState): PaperMultiLegFill[] {
  return state.originalFills.filter((fill) => fill.filledQuantity > 0).reverse();
}

function unresolvedExposure(targets: readonly PaperMultiLegFill[], compensation: readonly PaperMultiLegFill[]): PaperMultiLegUnresolvedExposure[] {
  return targets.flatMap((original, index) => {
    const reversed = compensation[index];
    const quantity = rounded(original.filledQuantity - (reversed?.filledQuantity ?? 0));
    return quantity > 0 ? [{ legId: original.legId, instrumentId: original.instrumentId, quantityUnit: original.quantityUnit, quantity }] : [];
  });
}

function terminal(status: PaperMultiLegTerminal["status"], reason: PaperMultiLegTerminal["reason"], unresolvedExposure: PaperMultiLegUnresolvedExposure[]): PaperMultiLegTerminal {
  return { status, reason, unresolvedExposure };
}

function parseCreatedData(input: unknown): Extract<PaperMultiLegEventDraft, { type: "run-created" }>["data"] {
  if (!input || typeof input !== "object") throw new Error("Paper multi-leg creation event is invalid");
  const data = input as Record<string, unknown>;
  if (typeof data.planHash !== "string" || !data.plan || !data.safety) {
    throw new Error("Paper multi-leg creation event is incomplete");
  }
  return data as unknown as Extract<PaperMultiLegEventDraft, { type: "run-created" }>["data"];
}

function validateHeader(event: PaperMultiLegEvent, runId: string, expectedSequence: number, previousTs: number): void {
  if (event.runId !== runId || event.eventId !== `${runId}:${event.sequence}` || event.sequence !== expectedSequence || !Number.isSafeInteger(event.ts) || event.ts <= 0 || event.ts < previousTs) {
    throw new Error(`Invalid paper multi-leg event header at sequence ${event.sequence}`);
  }
}

function rounded(value: number): number {
  const roundedValue = Number(value.toFixed(PRECISION));
  return Object.is(roundedValue, -0) ? 0 : roundedValue;
}
