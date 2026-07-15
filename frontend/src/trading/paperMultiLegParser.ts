import type { PaperMultiLegDecision, PaperMultiLegEvent, PaperMultiLegFill, PaperMultiLegPlan, PaperMultiLegPlanLeg, PaperMultiLegRecoveryStatus, PaperMultiLegRunState, PaperMultiLegRunSummary, PaperMultiLegRunView, PaperMultiLegSafety, PaperMultiLegTerminal } from "./paperMultiLegTypes";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/;
const MARKET_ID = /^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const routeFamilies = ["cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future"] as const;
const statuses = ["executing", "awaiting-compensation-decision", "compensating", "completed", "compensated", "aborted-no-exposure", "manual-review-required"] as const;
const terminalStatuses = ["completed", "compensated", "aborted-no-exposure", "manual-review-required"] as const;
const quantityUnits = ["base", "quote", "contract", "native"] as const;

export function parsePaperMultiLegPlanJson(input: string): PaperMultiLegPlan {
  if (new TextEncoder().encode(input).byteLength > 64 * 1024) throw new Error("paper plan JSON exceeds 64 KB");
  try {
    return parsePaperMultiLegPlan(JSON.parse(input));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("paper plan is not valid JSON");
    throw error;
  }
}

export function parsePaperMultiLegPlan(input: unknown): PaperMultiLegPlan {
  const value = object(input, "plan");
  exact(value, ["schemaVersion", "runId", "source", "createdAt", "expiresAt", "executionMode", "simulationPolicy", "legs"], [], "plan");
  literal(value.schemaVersion, "paper-multi-leg-plan-v1", "plan.schemaVersion");
  const runId = text(value.runId, "plan.runId", 8, 160, RUN_ID);
  const source = parseSource(value.source);
  const createdAt = timestamp(value.createdAt, "plan.createdAt");
  const expiresAt = timestamp(value.expiresAt, "plan.expiresAt");
  if (expiresAt <= createdAt || expiresAt - createdAt > 300_000) throw new Error("plan expiry is invalid");
  if (source.evaluatedAt > createdAt + 1_000 || createdAt - source.evaluatedAt > 60_000) throw new Error("plan source evidence is stale");
  literal(value.executionMode, "paper-sequential-legs", "plan.executionMode");
  literal(value.simulationPolicy, "explicit-deterministic-fill-ratios-v1", "plan.simulationPolicy");
  const rows = array(value.legs, "plan.legs");
  const expected = source.kind === "route-family" ? [2, 2] : [4, 8];
  if (rows.length < expected[0] || rows.length > expected[1]) throw new Error("plan leg count is invalid");
  const legs = rows.map((row, index) => parseLeg(row, index));
  if (new Set(legs.map(({ legId }) => legId)).size !== legs.length) throw new Error("plan leg IDs must be unique");
  return { schemaVersion: "paper-multi-leg-plan-v1", runId, source, createdAt, expiresAt, executionMode: "paper-sequential-legs", simulationPolicy: "explicit-deterministic-fill-ratios-v1", legs };
}

export function parsePaperMultiLegListResponse(input: unknown): { safety: PaperMultiLegSafety; runs: PaperMultiLegRunSummary[] } {
  const value = envelope(input, ["runs"]);
  const rows = array(value.runs, "runs");
  if (rows.length > 100) throw new Error("run summary list exceeds 100 rows");
  const runs = rows.map(parseSummary);
  if (new Set(runs.map(({ runId }) => runId)).size !== runs.length) throw new Error("run summary IDs must be unique");
  return { safety: parseSafety(value.safety), runs };
}

export function parsePaperMultiLegRunResponse(input: unknown): { safety: PaperMultiLegSafety; run: PaperMultiLegRunView } {
  const value = envelope(input, ["run"]);
  return { safety: parseSafety(value.safety), run: parseRunView(value.run) };
}

export function parsePaperMultiLegSubmissionResponse(input: unknown): { safety: PaperMultiLegSafety; created: boolean; run: PaperMultiLegRunView } {
  const value = envelope(input, ["created", "run"]);
  return { safety: parseSafety(value.safety), created: boolean(value.created, "created"), run: parseRunView(value.run) };
}

export function parsePaperMultiLegRecoveryResponse(input: unknown): { safety: PaperMultiLegSafety; recovery: PaperMultiLegRecoveryStatus } {
  const value = envelope(input, ["recovery"]);
  const recovery = object(value.recovery, "recovery");
  exact(recovery, ["status", "recoveredRuns"], ["startedAt", "completedAt", "error"], "recovery");
  const status = oneOf(recovery.status, ["not-run", "running", "ready", "failed"] as const, "recovery.status");
  const parsed: PaperMultiLegRecoveryStatus = { status, recoveredRuns: integer(recovery.recoveredRuns, "recovery.recoveredRuns", 0, 100_000) };
  if (recovery.startedAt !== undefined) parsed.startedAt = timestamp(recovery.startedAt, "recovery.startedAt");
  if (recovery.completedAt !== undefined) parsed.completedAt = timestamp(recovery.completedAt, "recovery.completedAt");
  if (recovery.error !== undefined) parsed.error = literal(recovery.error, "recovery-failed", "recovery.error");
  if (parsed.startedAt && parsed.completedAt && parsed.completedAt < parsed.startedAt) throw new Error("recovery timestamps are not monotonic");
  if (status === "not-run" && (parsed.startedAt || parsed.completedAt || parsed.error)) throw new Error("not-run recovery contains unexpected evidence");
  if (status === "running" && (!parsed.startedAt || parsed.completedAt || parsed.error)) throw new Error("running recovery evidence is invalid");
  if (status === "ready" && (!parsed.startedAt || !parsed.completedAt || parsed.error)) throw new Error("ready recovery timestamps are missing");
  if (status === "failed" && (!parsed.startedAt || !parsed.completedAt || parsed.error !== "recovery-failed")) throw new Error("failed recovery evidence is incomplete");
  return { safety: parseSafety(value.safety), recovery: parsed };
}

function parseSource(input: unknown): PaperMultiLegPlan["source"] {
  const value = object(input, "plan.source");
  const kind = oneOf(value.kind, ["n-leg", "route-family"] as const, "plan.source.kind");
  exact(value, ["kind", "engine", "opportunityId", "evaluatedAt", "provenanceHash", ...(kind === "route-family" ? ["family"] : [])], [], "plan.source");
  const common = { opportunityId: opaque(value.opportunityId, "plan.source.opportunityId", 16_384), evaluatedAt: timestamp(value.evaluatedAt, "plan.source.evaluatedAt"), provenanceHash: text(value.provenanceHash, "plan.source.provenanceHash", 64, 64, HASH) };
  if (kind === "n-leg") {
    literal(value.engine, "n-leg-v1", "plan.source.engine");
    return { kind, engine: "n-leg-v1", ...common };
  }
  literal(value.engine, "route-families-v1", "plan.source.engine");
  return { kind, engine: "route-families-v1", family: oneOf(value.family, routeFamilies, "plan.source.family"), ...common };
}

function parseLeg(input: unknown, index: number): PaperMultiLegPlanLeg {
  const label = `plan.legs[${index}]`;
  const value = object(input, label);
  exact(value, ["legId", "venue", "instrumentId", "side", "quantityUnit", "plannedQuantity", "referencePrice", "feeBps", "paperFillRatioBps", "paperCompensationFillRatioBps", "paperCompensationPrice", "paperCompensationFeeBps", "evidenceId"], [], label);
  return {
    legId: text(value.legId, `${label}.legId`, 1, 200, SAFE_ID),
    venue: text(value.venue, `${label}.venue`, 1, 200, SAFE_ID),
    instrumentId: text(value.instrumentId, `${label}.instrumentId`, 1, 200, MARKET_ID),
    side: oneOf(value.side, ["buy", "sell"] as const, `${label}.side`),
    quantityUnit: oneOf(value.quantityUnit, quantityUnits, `${label}.quantityUnit`),
    plannedQuantity: finite(value.plannedQuantity, `${label}.plannedQuantity`, 1e-12, 1e15),
    referencePrice: finite(value.referencePrice, `${label}.referencePrice`, Number.MIN_VALUE, 1e15),
    feeBps: finite(value.feeBps, `${label}.feeBps`, 0, 10_000),
    paperFillRatioBps: integer(value.paperFillRatioBps, `${label}.paperFillRatioBps`, 0, 10_000),
    paperCompensationFillRatioBps: integer(value.paperCompensationFillRatioBps, `${label}.paperCompensationFillRatioBps`, 0, 10_000),
    paperCompensationPrice: finite(value.paperCompensationPrice, `${label}.paperCompensationPrice`, Number.MIN_VALUE, 1e15),
    paperCompensationFeeBps: finite(value.paperCompensationFeeBps, `${label}.paperCompensationFeeBps`, 0, 10_000),
    evidenceId: opaque(value.evidenceId, `${label}.evidenceId`, 1_024)
  };
}

function parseRunView(input: unknown): PaperMultiLegRunView {
  const value = object(input, "run");
  exact(value, ["state", "events"], [], "run");
  const state = parseState(value.state);
  const events = array(value.events, "run.events").map(parseEvent);
  if (events.length !== state.lastSequence || events.length > 24) throw new Error("run event count does not match state");
  let previousTs = 0;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.runId !== state.runId || event.eventId !== `${state.runId}:${event.sequence}` || event.ts < previousTs) throw new Error("run event sequence is invalid");
    previousTs = event.ts;
  }
  const first = events[0];
  if (!first || first.type !== "run-created" || first.data.planHash !== state.planHash || JSON.stringify(first.data.plan) !== JSON.stringify(state.plan)) throw new Error("run creation evidence does not match state");
  const last = events.at(-1);
  if (state.createdAt !== first.ts || state.updatedAt !== last?.ts) throw new Error("run timestamps do not match journal evidence");
  const originalFills = events.flatMap((event) => (event.type === "original-fill" ? [event.data.fill] : []));
  const compensationFills = events.flatMap((event) => (event.type === "compensation-fill" ? [event.data.fill] : []));
  const decisions = events.flatMap((event) => (event.type === "compensation-decision" ? [event.data.decision] : []));
  const terminals = events.flatMap((event) => (event.type === "run-terminal" ? [event.data.terminal] : []));
  if (!same(originalFills, state.originalFills) || !same(compensationFills, state.compensationFills)) throw new Error("run fills do not match journal evidence");
  if (decisions.length > 1 || !same(decisions[0], state.compensationDecision)) throw new Error("run compensation decision does not match journal evidence");
  if (terminals.length > 1 || !same(terminals[0], state.terminal) || (terminals.length === 1 && last?.type !== "run-terminal")) throw new Error("run terminal state does not match journal evidence");
  validateDeterministicState(state);
  validateEventOrder(events, state);
  if (state.terminal && state.terminal.status !== state.status) throw new Error("run terminal status does not match state");
  return { state, events };
}

function parseState(input: unknown): PaperMultiLegRunState {
  const value = object(input, "run.state");
  exact(value, ["runId", "planHash", "plan", "status", "originalFills", "compensationFills", "lastSequence", "createdAt", "updatedAt"], ["compensationDecision", "terminal"], "run.state");
  const plan = parsePaperMultiLegPlan(value.plan);
  const runId = text(value.runId, "run.state.runId", 8, 160, RUN_ID);
  if (plan.runId !== runId) throw new Error("run plan identity does not match state");
  const state: PaperMultiLegRunState = {
    runId,
    planHash: text(value.planHash, "run.state.planHash", 64, 64, HASH),
    plan,
    status: oneOf(value.status, statuses, "run.state.status"),
    originalFills: array(value.originalFills, "run.state.originalFills").map(parseFill),
    compensationFills: array(value.compensationFills, "run.state.compensationFills").map(parseFill),
    lastSequence: integer(value.lastSequence, "run.state.lastSequence", 1, 24),
    createdAt: timestamp(value.createdAt, "run.state.createdAt"),
    updatedAt: timestamp(value.updatedAt, "run.state.updatedAt")
  };
  if (value.compensationDecision !== undefined) state.compensationDecision = parseDecision(value.compensationDecision);
  if (value.terminal !== undefined) state.terminal = parseTerminal(value.terminal);
  return state;
}

function validateDeterministicState(state: PaperMultiLegRunState): void {
  const { plan, originalFills, compensationFills, compensationDecision, terminal } = state;
  if (originalFills.length > plan.legs.length) throw new Error("run contains too many original fills");
  for (const [index, fill] of originalFills.entries()) {
    if (fill.kind !== "original" || fill.legIndex !== index) throw new Error("original fills are not sequential");
    validateFillAgainstLeg(fill, plan.legs[index], "original");
    if (index < originalFills.length - 1 && fill.status !== "filled") throw new Error("original fills continue after an incomplete leg");
  }
  const incomplete = originalFills.find((fill) => fill.status !== "filled");
  const targets = originalFills.filter((fill) => fill.filledQuantity > 0).reverse();
  if (!incomplete && (compensationDecision || compensationFills.length > 0)) throw new Error("compensation exists without an incomplete original leg");
  if (compensationFills.length > 0 && !compensationDecision) throw new Error("compensation fills exist without a decision");
  if (compensationFills.length > targets.length) throw new Error("run contains too many compensation fills");
  for (const [index, fill] of compensationFills.entries()) {
    const target = targets[index];
    if (!target || fill.kind !== "compensation" || fill.legIndex !== target.legIndex || !near(fill.requestedQuantity, target.filledQuantity)) throw new Error("compensation fill target is invalid");
    validateFillAgainstLeg(fill, plan.legs[target.legIndex], "compensation");
  }
  if (compensationDecision) {
    const expectedTargets = targets.map(({ legId }) => legId);
    const expectedAction = expectedTargets.length > 0 ? "reverse-filled-legs" : "none-no-exposure";
    const expectedFullCompensation = targets.every((fill) => plan.legs[fill.legIndex]?.paperCompensationFillRatioBps === 10_000);
    if (compensationDecision.action !== expectedAction || compensationDecision.expectedFullCompensation !== expectedFullCompensation || !same(compensationDecision.targetLegIds, expectedTargets)) throw new Error("compensation decision targets are invalid");
  }
  if (terminal) validateTerminalState(state, targets);
  const expectedStatus = terminal ? terminal.status : compensationFills.length > 0 || compensationDecision?.action === "reverse-filled-legs" ? "compensating" : incomplete || compensationDecision?.action === "none-no-exposure" ? "awaiting-compensation-decision" : "executing";
  if (state.status !== expectedStatus) throw new Error("run status does not match deterministic progress");
}

function validateEventOrder(events: PaperMultiLegEvent[], state: PaperMultiLegRunState): void {
  const expected: PaperMultiLegEvent["type"][] = ["run-created"];
  expected.push(...state.originalFills.map(() => "original-fill" as const));
  if (state.compensationDecision) expected.push("compensation-decision");
  expected.push(...state.compensationFills.map(() => "compensation-fill" as const));
  if (state.terminal) expected.push("run-terminal");
  if (events.length !== expected.length || events.some((event, index) => event.type !== expected[index])) throw new Error("run event order does not match deterministic progress");
}

function validateFillAgainstLeg(fill: PaperMultiLegFill, leg: PaperMultiLegPlanLeg | undefined, kind: PaperMultiLegFill["kind"]): void {
  if (!leg || fill.legId !== leg.legId || fill.venue !== leg.venue || fill.instrumentId !== leg.instrumentId || fill.quantityUnit !== leg.quantityUnit || fill.evidenceId !== leg.evidenceId) throw new Error("fill identity does not match its plan leg");
  const ratio = kind === "original" ? leg.paperFillRatioBps : leg.paperCompensationFillRatioBps;
  const price = kind === "original" ? leg.referencePrice : leg.paperCompensationPrice;
  const feeBps = kind === "original" ? leg.feeBps : leg.paperCompensationFeeBps;
  const side = kind === "original" ? leg.side : leg.side === "buy" ? "sell" : "buy";
  const expectedFilled = rounded((fill.requestedQuantity * ratio) / 10_000);
  const expectedUnfilled = rounded(fill.requestedQuantity - expectedFilled);
  const status = expectedFilled === 0 ? "unfilled" : expectedUnfilled === 0 ? "filled" : "partially-filled";
  if (fill.side !== side || fill.fillRatioBps !== ratio || !near(fill.averagePrice, price) || !near(fill.filledQuantity, expectedFilled) || !near(fill.unfilledQuantity, expectedUnfilled) || fill.status !== status || !near(fill.estimatedFee, rounded((expectedFilled * price * feeBps) / 10_000)))
    throw new Error("fill economics do not match its deterministic plan leg");
  if (kind === "original" && !near(fill.requestedQuantity, rounded(leg.plannedQuantity))) throw new Error("original fill quantity does not match its plan leg");
}

function validateTerminalState(state: PaperMultiLegRunState, targets: PaperMultiLegFill[]): void {
  const terminal = state.terminal;
  if (!terminal) return;
  const allOriginalFilled = state.originalFills.length === state.plan.legs.length && state.originalFills.every((fill) => fill.status === "filled");
  if (!allOriginalFilled && targets.length > 0 && (!state.compensationDecision || state.compensationFills.length !== targets.length)) throw new Error("terminal state precedes complete compensation attempts");
  const unresolved = targets.flatMap((original, index) => {
    const reversed = state.compensationFills[index];
    const quantity = rounded(original.filledQuantity - (reversed?.filledQuantity ?? 0));
    return quantity > 0 ? [{ legId: original.legId, instrumentId: original.instrumentId, quantityUnit: original.quantityUnit, quantity }] : [];
  });
  const expected = allOriginalFilled
    ? { status: "completed", reason: "all-paper-legs-filled", unresolvedExposure: [] }
    : targets.length === 0
      ? { status: "aborted-no-exposure", reason: "no-paper-exposure-created", unresolvedExposure: [] }
      : unresolved.length === 0
        ? { status: "compensated", reason: "all-paper-exposure-reversed", unresolvedExposure: [] }
        : { status: "manual-review-required", reason: "paper-compensation-incomplete", unresolvedExposure: unresolved };
  if (!same(terminal, expected)) throw new Error("terminal result does not match deterministic fills");
}

function parseEvent(input: unknown): PaperMultiLegEvent {
  const value = object(input, "event");
  exact(value, ["eventId", "runId", "sequence", "ts", "type", "data"], [], "event");
  const header = { eventId: text(value.eventId, "event.eventId", 1, 200), runId: text(value.runId, "event.runId", 8, 160, RUN_ID), sequence: integer(value.sequence, "event.sequence", 1, 24), ts: timestamp(value.ts, "event.ts") };
  const type = oneOf(value.type, ["run-created", "original-fill", "compensation-decision", "compensation-fill", "run-terminal"] as const, "event.type");
  const data = object(value.data, "event.data");
  if (type === "run-created") {
    exact(data, ["plan", "planHash", "safety"], [], "event.data");
    return { ...header, type, data: { plan: parsePaperMultiLegPlan(data.plan), planHash: text(data.planHash, "event.data.planHash", 64, 64, HASH), safety: parseSafety(data.safety) } };
  }
  if (type === "original-fill" || type === "compensation-fill") {
    exact(data, ["fill"], [], "event.data");
    const fill = parseFill(data.fill);
    if (fill.kind !== (type === "original-fill" ? "original" : "compensation")) throw new Error("event fill kind is invalid");
    return { ...header, type, data: { fill } };
  }
  if (type === "compensation-decision") {
    exact(data, ["decision"], [], "event.data");
    return { ...header, type, data: { decision: parseDecision(data.decision) } };
  }
  exact(data, ["terminal"], [], "event.data");
  return { ...header, type, data: { terminal: parseTerminal(data.terminal) } };
}

function parseFill(input: unknown): PaperMultiLegFill {
  const value = object(input, "fill");
  exact(value, ["kind", "legIndex", "legId", "venue", "instrumentId", "side", "quantityUnit", "requestedQuantity", "filledQuantity", "unfilledQuantity", "fillRatioBps", "status", "averagePrice", "estimatedFee", "evidenceId"], [], "fill");
  const requestedQuantity = finite(value.requestedQuantity, "fill.requestedQuantity", 0, 1e15);
  const filledQuantity = finite(value.filledQuantity, "fill.filledQuantity", 0, requestedQuantity);
  const unfilledQuantity = finite(value.unfilledQuantity, "fill.unfilledQuantity", 0, requestedQuantity);
  if (!near(requestedQuantity, filledQuantity + unfilledQuantity)) throw new Error("fill quantities do not conserve");
  return {
    kind: oneOf(value.kind, ["original", "compensation"] as const, "fill.kind"),
    legIndex: integer(value.legIndex, "fill.legIndex", 0, 7),
    legId: text(value.legId, "fill.legId", 1, 200, SAFE_ID),
    venue: text(value.venue, "fill.venue", 1, 200, SAFE_ID),
    instrumentId: text(value.instrumentId, "fill.instrumentId", 1, 200, MARKET_ID),
    side: oneOf(value.side, ["buy", "sell"] as const, "fill.side"),
    quantityUnit: oneOf(value.quantityUnit, quantityUnits, "fill.quantityUnit"),
    requestedQuantity,
    filledQuantity,
    unfilledQuantity,
    fillRatioBps: integer(value.fillRatioBps, "fill.fillRatioBps", 0, 10_000),
    status: oneOf(value.status, ["filled", "partially-filled", "unfilled"] as const, "fill.status"),
    averagePrice: finite(value.averagePrice, "fill.averagePrice", Number.MIN_VALUE, 1e15),
    estimatedFee: finite(value.estimatedFee, "fill.estimatedFee", 0, 1e15),
    evidenceId: opaque(value.evidenceId, "fill.evidenceId", 1_024)
  };
}

function parseDecision(input: unknown): PaperMultiLegDecision {
  const value = object(input, "decision");
  exact(value, ["action", "reason", "targetLegIds", "expectedFullCompensation"], [], "decision");
  const ids = array(value.targetLegIds, "decision.targetLegIds").map((id) => text(id, "decision.targetLegIds[]", 1, 200, SAFE_ID));
  if (new Set(ids).size !== ids.length || ids.length > 8) throw new Error("compensation target IDs are invalid");
  return { action: oneOf(value.action, ["reverse-filled-legs", "none-no-exposure"] as const, "decision.action"), reason: literal(value.reason, "original-leg-incomplete", "decision.reason"), targetLegIds: ids, expectedFullCompensation: boolean(value.expectedFullCompensation, "decision.expectedFullCompensation") };
}

function parseTerminal(input: unknown): PaperMultiLegTerminal {
  const value = object(input, "terminal");
  exact(value, ["status", "reason", "unresolvedExposure"], [], "terminal");
  const unresolvedExposure = array(value.unresolvedExposure, "terminal.unresolvedExposure").map((row, index) => {
    const item = object(row, `terminal.unresolvedExposure[${index}]`);
    exact(item, ["legId", "instrumentId", "quantityUnit", "quantity"], [], "unresolved exposure");
    return {
      legId: text(item.legId, "unresolved.legId", 1, 200, SAFE_ID),
      instrumentId: text(item.instrumentId, "unresolved.instrumentId", 1, 200, MARKET_ID),
      quantityUnit: oneOf(item.quantityUnit, quantityUnits, "unresolved.quantityUnit"),
      quantity: finite(item.quantity, "unresolved.quantity", Number.MIN_VALUE, 1e15)
    };
  });
  return { status: oneOf(value.status, terminalStatuses, "terminal.status"), reason: oneOf(value.reason, ["all-paper-legs-filled", "all-paper-exposure-reversed", "no-paper-exposure-created", "paper-compensation-incomplete"] as const, "terminal.reason"), unresolvedExposure };
}

function parseSummary(input: unknown): PaperMultiLegRunSummary {
  const value = object(input, "summary");
  exact(value, ["runId", "sourceKind", "opportunityId", "status", "legCount", "createdAt", "updatedAt"], [], "summary");
  return {
    runId: text(value.runId, "summary.runId", 8, 160, RUN_ID),
    sourceKind: oneOf(value.sourceKind, ["n-leg", "route-family"] as const, "summary.sourceKind"),
    opportunityId: opaque(value.opportunityId, "summary.opportunityId", 16_384),
    status: oneOf(value.status, statuses, "summary.status"),
    legCount: integer(value.legCount, "summary.legCount", 2, 8),
    createdAt: timestamp(value.createdAt, "summary.createdAt"),
    updatedAt: timestamp(value.updatedAt, "summary.updatedAt")
  };
}

function parseSafety(input: unknown): PaperMultiLegSafety {
  const value = object(input, "safety");
  exact(value, ["executionMode", "liveOrders", "privateRequests", "credentialsAccepted"], [], "safety");
  return {
    executionMode: literal(value.executionMode, "paper-only", "safety.executionMode"),
    liveOrders: literal(value.liveOrders, false, "safety.liveOrders"),
    privateRequests: literal(value.privateRequests, false, "safety.privateRequests"),
    credentialsAccepted: literal(value.credentialsAccepted, false, "safety.credentialsAccepted")
  };
}

function envelope(input: unknown, extra: string[]): Record<string, unknown> {
  const value = object(input, "response");
  exact(value, ["schemaVersion", "safety", ...extra], [], "response");
  literal(value.schemaVersion, "paper-multi-leg-api-v1", "response.schemaVersion");
  return value;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}
function array(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return input;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) throw new Error(`${label} contains missing or unknown fields`);
}
function text(input: unknown, label: string, minimum = 1, maximum = 600, pattern?: RegExp): string {
  if (typeof input !== "string") throw new Error(`${label} must be text`);
  const value = input.trim();
  if (value.length < minimum || value.length > maximum || (pattern && !pattern.test(value))) throw new Error(`${label} is invalid`);
  return value;
}
function opaque(input: unknown, label: string, maximum: number): string {
  const value = text(input, label, 1, maximum);
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) < 32 || character.codePointAt(0) === 127)) throw new Error(`${label} contains control characters`);
  return value;
}
function finite(input: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum || input > maximum) throw new Error(`${label} is invalid`);
  return input;
}
function integer(input: unknown, label: string, minimum: number, maximum: number): number {
  const value = finite(input, label, minimum, maximum);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
function timestamp(input: unknown, label: string): number {
  return integer(input, label, 1, Number.MAX_SAFE_INTEGER);
}
function boolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${label} must be boolean`);
  return input;
}
function literal<const T extends string | number | boolean>(input: unknown, expected: T, label: string): T {
  if (input !== expected) throw new Error(`${label} is invalid`);
  return expected;
}
function oneOf<const T extends readonly (string | number)[]>(input: unknown, values: T, label: string): T[number] {
  if (!values.includes(input as never)) throw new Error(`${label} is invalid`);
  return input as T[number];
}
function near(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-10, Math.abs(right) * 1e-10);
}

function rounded(value: number): number {
  const result = Number(value.toFixed(12));
  return Object.is(result, -0) ? 0 : result;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
