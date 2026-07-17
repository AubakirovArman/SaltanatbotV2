import { createHash } from "node:crypto";
import { parseScreenerAlertDefinitionV1, type ScreenerAlertDefinitionV1, type ScreenerDefinitionV1, type ScreenerUniverseSummaryV1 } from "@saltanatbotv2/contracts";
import type { ScreenerEngineRunV1 } from "../screener/engine.js";

export const SCREENER_ALERT_STATE_SCHEMA_V1 = "screener-alert-state-v1" as const;
export const SCREENER_ALERT_OBSERVATION_SCHEMA_V1 = "screener-alert-observation-v1" as const;
/** Runs whose unavailable share exceeds this floor defer instead of mutating durable membership. */
export const SCREENER_ALERT_AVAILABILITY_FLOOR = 0.3;
/** Matches the screener universe contract cap; effective sets never exceed it. */
export const SCREENER_ALERT_MATCHED_SYMBOL_CAP = 200;
/** Entered/left symbols spelled out in event and notification text before eliding. */
export const SCREENER_ALERT_SUMMARY_SYMBOL_CAP = 12;

const RULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{1,29}$/;

/**
 * Durable JSONB state for one screener-kind alert rule revision. The matched
 * set is the effective membership after unknown carry-over, so a symbol that
 * became unavailable keeps its previous membership instead of "departing".
 */
export interface ScreenerAlertRuntimeStateV1 {
  schemaVersion: typeof SCREENER_ALERT_STATE_SCHEMA_V1;
  /** Ascending, deduplicated effective matched set durably owned by this rule revision. */
  matchedSymbols: string[];
  /** Symbols unavailable on the run that produced this state; membership carried over. */
  unknownSymbols: string[];
  /** sha256(canonicalJson(matchedSymbols)); recomputed on every load and completion. */
  matchSetFingerprint: string;
  /** Highest closed bar open time consumed by this state; zero before initialization. */
  lastClosedBarTimeMax: number;
  initialized: boolean;
}

export interface ScreenerAlertObservationV1 {
  schemaVersion: typeof SCREENER_ALERT_OBSERVATION_SCHEMA_V1;
  subjectKey: string;
  observationKey: string;
  evidenceFingerprint: string;
  closedBarTimeMax: number;
  evaluatedAt: number;
  universe: ScreenerUniverseSummaryV1;
  researchOnly: true;
  executionPermission: false;
}

/** Repository-neutral input for an atomic match-set-changed transition. */
export interface ScreenerAlertTriggeredTransitionInputV1 {
  kind: "screener-alert-triggered";
  ruleId: string;
  ruleRevision: number;
  from: "steady";
  to: "changed";
  subjectKey: string;
  transitionKey: string;
  observationKey: string;
  evidenceFingerprint: string;
  occurredAt: number;
  previousFingerprint: string;
  nextFingerprint: string;
  enteredSymbols: string[];
  leftSymbols: string[];
  matchedCount: number;
  researchOnly: true;
  executionPermission: false;
}

export interface ScreenerAlertEvaluationInputV1 {
  ruleId: string;
  ruleRevision: number;
  definition: ScreenerAlertDefinitionV1;
  /** sha256 of the canonical alert definition serialization (rule revision hash). */
  definitionHash: string;
  state: ScreenerAlertRuntimeStateV1;
  /** Millisecond-epoch cooldown fence from the durable state row, if any. */
  cooldownUntil?: number;
  run: ScreenerEngineRunV1;
  /** Server observation time. Exchange timestamps never replace this clock. */
  now: number;
}

export type ScreenerAlertEvaluationResultV1 =
  | {
      status: "initialized";
      stateKey: string;
      observation: ScreenerAlertObservationV1;
      nextState: ScreenerAlertRuntimeStateV1;
    }
  | {
      status: "triggered";
      stateKey: string;
      observation: ScreenerAlertObservationV1;
      nextState: ScreenerAlertRuntimeStateV1;
      transition: ScreenerAlertTriggeredTransitionInputV1;
    }
  | {
      status: "idle";
      reason: "rule-disabled" | "no-change" | "no-new-closed-bar";
      stateKey: string;
      nextState: ScreenerAlertRuntimeStateV1;
    }
  | {
      status: "deferred";
      reason: "screener-availability-floor" | "cooldown-active";
      stateKey: string;
      retryAfterSeconds?: number;
      nextState: ScreenerAlertRuntimeStateV1;
    }
  | {
      status: "unavailable";
      reason: "invalid-definition" | "invalid-evaluation-input" | "run-scope-mismatch" | "empty-universe" | "matched-set-overflow";
      stateKey?: string;
      nextState: ScreenerAlertRuntimeStateV1;
    };

/** Stable durable scope for one embedded screen revision. */
export function screenerAlertStateKey(screen: Pick<ScreenerDefinitionV1, "exchange" | "marketType" | "priceType" | "timeframe">, definitionHash: string): string {
  return sha256(canonicalJson({ exchange: screen.exchange, marketType: screen.marketType, priceType: screen.priceType, timeframe: screen.timeframe, definitionHash }));
}

export function screenerAlertTransitionKey(ruleId: string, ruleRevision: number, previousFingerprint: string, nextFingerprint: string, closedBarTimeMax: number): string {
  return sha256(JSON.stringify(["screener-alert-transition-v1", ruleId, ruleRevision, previousFingerprint, nextFingerprint, closedBarTimeMax]));
}

export function screenerAlertObservationFingerprint(subjectKey: string, closedBarTimeMax: number, nextState: Pick<ScreenerAlertRuntimeStateV1, "matchedSymbols" | "unknownSymbols">, universe: ScreenerUniverseSummaryV1): string {
  return sha256(JSON.stringify([SCREENER_ALERT_OBSERVATION_SCHEMA_V1, subjectKey, closedBarTimeMax, nextState.matchedSymbols, nextState.unknownSymbols, universe.requested, universe.evaluated, universe.matched, universe.unavailable]));
}

/** Entered/left change text shared by the durable event summary and the envelope body. */
export function screenerAlertChangeSummary(enteredSymbols: readonly string[], leftSymbols: readonly string[], matchedCount: number): string {
  const entered = enteredSymbols.slice(0, SCREENER_ALERT_SUMMARY_SYMBOL_CAP);
  const left = leftSymbols.slice(0, Math.max(0, SCREENER_ALERT_SUMMARY_SYMBOL_CAP - entered.length));
  const hidden = enteredSymbols.length + leftSymbols.length - entered.length - left.length;
  const parts: string[] = [];
  if (entered.length > 0) parts.push(`entered ${entered.join(", ")}`);
  if (left.length > 0) parts.push(`left ${left.join(", ")}`);
  if (hidden > 0) parts.push(`${hidden} more ${hidden === 1 ? "change" : "changes"}`);
  return `Screen match changed: ${parts.join("; ")}; ${matchedCount} matched.`;
}

export function defaultScreenerAlertRuntimeState(): ScreenerAlertRuntimeStateV1 {
  return {
    schemaVersion: SCREENER_ALERT_STATE_SCHEMA_V1,
    matchedSymbols: [],
    unknownSymbols: [],
    matchSetFingerprint: sha256(canonicalJson([])),
    lastClosedBarTimeMax: 0,
    initialized: false
  };
}

export function parseScreenerAlertRuntimeStateStrict(value: unknown): ScreenerAlertRuntimeStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored screener alert runtime state is malformed.");
  const state = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "matchedSymbols", "unknownSymbols", "matchSetFingerprint", "lastClosedBarTimeMax", "initialized"]);
  if (Object.keys(state).some((key) => !allowed.has(key)) || state.schemaVersion !== SCREENER_ALERT_STATE_SCHEMA_V1 || typeof state.initialized !== "boolean") {
    throw new Error("Stored screener alert runtime state is malformed.");
  }
  if (typeof state.lastClosedBarTimeMax !== "number" || !Number.isSafeInteger(state.lastClosedBarTimeMax) || state.lastClosedBarTimeMax < 0) {
    throw new Error("Stored screener alert runtime state is malformed.");
  }
  const matchedSymbols = symbolSet(state.matchedSymbols);
  const unknownSymbols = symbolSet(state.unknownSymbols);
  if (typeof state.matchSetFingerprint !== "string" || state.matchSetFingerprint !== sha256(canonicalJson(matchedSymbols))) {
    throw new Error("Stored screener alert runtime state is malformed.");
  }
  if (!state.initialized && (matchedSymbols.length > 0 || unknownSymbols.length > 0 || state.lastClosedBarTimeMax !== 0)) {
    throw new Error("Stored screener alert runtime state is malformed.");
  }
  return {
    schemaVersion: SCREENER_ALERT_STATE_SCHEMA_V1,
    matchedSymbols,
    unknownSymbols,
    matchSetFingerprint: state.matchSetFingerprint,
    lastClosedBarTimeMax: state.lastClosedBarTimeMax,
    initialized: state.initialized
  };
}

/**
 * Evaluate one screener-kind alert rule revision over one full engine run.
 * Unavailable symbols keep their previous membership (unknown, not departed),
 * excess unavailability defers without touching durable membership, the first
 * evaluation initializes without triggering, and a fingerprint change triggers
 * only after cooldown. This function has no persistence or delivery effects.
 */
export function evaluateScreenerAlert(input: ScreenerAlertEvaluationInputV1): ScreenerAlertEvaluationResultV1 {
  const unchangedState = copyState(input.state);
  let definition: ScreenerAlertDefinitionV1;
  try {
    definition = parseScreenerAlertDefinitionV1(input.definition);
  } catch {
    return { status: "unavailable", reason: "invalid-definition", nextState: unchangedState };
  }
  if (typeof input.definitionHash !== "string" || !HEX_64.test(input.definitionHash)) {
    return { status: "unavailable", reason: "invalid-evaluation-input", nextState: unchangedState };
  }
  const stateKey = screenerAlertStateKey(definition.screen, input.definitionHash);
  if (!validEvaluationIdentity(input)) {
    return { status: "unavailable", reason: "invalid-evaluation-input", stateKey, nextState: unchangedState };
  }
  if (!definition.enabled) {
    return { status: "idle", reason: "rule-disabled", stateKey, nextState: unchangedState };
  }
  const summary = input.run.result;
  if (summary.definitionHash !== screenerDefinitionHash(definition.screen) || summary.timeframe !== definition.screen.timeframe || !consistentRunSets(input.run)) {
    return { status: "unavailable", reason: "run-scope-mismatch", stateKey, nextState: unchangedState };
  }
  if (summary.universe.requested === 0) {
    return { status: "unavailable", reason: "empty-universe", stateKey, nextState: unchangedState };
  }
  // Integer form of unavailable > SCREENER_ALERT_AVAILABILITY_FLOOR * requested.
  if (summary.universe.unavailable * 10 > summary.universe.requested * 3) {
    return { status: "deferred", reason: "screener-availability-floor", stateKey, nextState: unchangedState };
  }
  if (input.state.initialized && summary.closedBarTimeMax <= input.state.lastClosedBarTimeMax) {
    return { status: "idle", reason: "no-new-closed-bar", stateKey, nextState: unchangedState };
  }

  const unavailable = new Set(input.run.unavailableSymbols);
  const effective = new Set(input.run.matchedSymbols.filter((symbol) => !unavailable.has(symbol)));
  // Unknown carry-over: previous members that are unavailable stay members;
  // previous non-members that are unavailable are simply never added.
  for (const symbol of input.state.matchedSymbols) {
    if (unavailable.has(symbol)) effective.add(symbol);
  }
  if (effective.size > SCREENER_ALERT_MATCHED_SYMBOL_CAP || unavailable.size > SCREENER_ALERT_MATCHED_SYMBOL_CAP) {
    return { status: "unavailable", reason: "matched-set-overflow", stateKey, nextState: unchangedState };
  }
  const matchedSymbols = [...effective].sort(compareSymbols);
  const unknownSymbols = [...unavailable].sort(compareSymbols);
  const nextFingerprint = sha256(canonicalJson(matchedSymbols));
  const nextState: ScreenerAlertRuntimeStateV1 = {
    schemaVersion: SCREENER_ALERT_STATE_SCHEMA_V1,
    matchedSymbols,
    unknownSymbols,
    matchSetFingerprint: nextFingerprint,
    lastClosedBarTimeMax: summary.closedBarTimeMax,
    initialized: true
  };
  const observation: ScreenerAlertObservationV1 = {
    schemaVersion: SCREENER_ALERT_OBSERVATION_SCHEMA_V1,
    subjectKey: stateKey,
    observationKey: `${stateKey}:bar:${summary.closedBarTimeMax}`,
    evidenceFingerprint: screenerAlertObservationFingerprint(stateKey, summary.closedBarTimeMax, nextState, summary.universe),
    closedBarTimeMax: summary.closedBarTimeMax,
    evaluatedAt: input.now,
    universe: { ...summary.universe },
    researchOnly: true,
    executionPermission: false
  };
  if (!input.state.initialized) {
    return { status: "initialized", stateKey, observation, nextState };
  }
  if (nextFingerprint === input.state.matchSetFingerprint) {
    return { status: "idle", reason: "no-change", stateKey, nextState: unchangedState };
  }
  if (input.cooldownUntil !== undefined && input.cooldownUntil > input.now) {
    const retryAfterSeconds = Math.min(86_400, Math.max(1, Math.ceil((input.cooldownUntil - input.now) / 1_000)));
    return { status: "deferred", reason: "cooldown-active", stateKey, retryAfterSeconds, nextState: unchangedState };
  }

  const previousMembers = new Set(input.state.matchedSymbols);
  const transition: ScreenerAlertTriggeredTransitionInputV1 = {
    kind: "screener-alert-triggered",
    ruleId: input.ruleId,
    ruleRevision: input.ruleRevision,
    from: "steady",
    to: "changed",
    subjectKey: stateKey,
    transitionKey: screenerAlertTransitionKey(input.ruleId, input.ruleRevision, input.state.matchSetFingerprint, nextFingerprint, summary.closedBarTimeMax),
    observationKey: observation.observationKey,
    evidenceFingerprint: observation.evidenceFingerprint,
    occurredAt: summary.closedBarTimeMax,
    previousFingerprint: input.state.matchSetFingerprint,
    nextFingerprint,
    enteredSymbols: matchedSymbols.filter((symbol) => !previousMembers.has(symbol)),
    leftSymbols: input.state.matchedSymbols.filter((symbol) => !effective.has(symbol)),
    matchedCount: matchedSymbols.length,
    researchOnly: true,
    executionPermission: false
  };
  return { status: "triggered", stateKey, observation, nextState, transition };
}

function validEvaluationIdentity(input: ScreenerAlertEvaluationInputV1): boolean {
  if (typeof input.ruleId !== "string" || !RULE_ID.test(input.ruleId) || !Number.isSafeInteger(input.ruleRevision) || input.ruleRevision < 1) return false;
  if (!Number.isSafeInteger(input.now) || input.now < 0) return false;
  if (input.cooldownUntil !== undefined && (!Number.isSafeInteger(input.cooldownUntil) || input.cooldownUntil < 0)) return false;
  try {
    parseScreenerAlertRuntimeStateStrict(input.state);
  } catch {
    return false;
  }
  return true;
}

/** The full symbol lists must agree exactly with the contract universe counters. */
function consistentRunSets(run: ScreenerEngineRunV1): boolean {
  if (!Array.isArray(run.matchedSymbols) || !Array.isArray(run.unavailableSymbols)) return false;
  if (run.matchedSymbols.length !== run.result.universe.matched || run.unavailableSymbols.length !== run.result.universe.unavailable) return false;
  try {
    symbolSet(run.matchedSymbols);
    symbolSet(run.unavailableSymbols);
  } catch {
    return false;
  }
  return true;
}

/** Hash of the embedded screen alone, matching parseAndHashScreenerDefinition. */
export function screenerDefinitionHash(screen: ScreenerDefinitionV1): string {
  return sha256(canonicalJson(screen));
}

function symbolSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > SCREENER_ALERT_MATCHED_SYMBOL_CAP) throw new Error("Screener alert symbol set is malformed.");
  let previous: string | undefined;
  for (const symbol of value) {
    if (typeof symbol !== "string" || !SYMBOL.test(symbol)) throw new Error("Screener alert symbol set is malformed.");
    if (previous !== undefined && symbol <= previous) throw new Error("Screener alert symbol set is malformed.");
    previous = symbol;
  }
  return [...(value as string[])];
}

function copyState(state: ScreenerAlertRuntimeStateV1): ScreenerAlertRuntimeStateV1 {
  return {
    schemaVersion: SCREENER_ALERT_STATE_SCHEMA_V1,
    matchedSymbols: [...state.matchedSymbols],
    unknownSymbols: [...state.unknownSymbols],
    matchSetFingerprint: state.matchSetFingerprint,
    lastClosedBarTimeMax: state.lastClosedBarTimeMax,
    initialized: state.initialized
  };
}

function compareSymbols(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Local copy of the repository canonical JSON so this module stays dependency-free. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Screener alert documents cannot contain unsupported JSON values.");
  return serialized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
