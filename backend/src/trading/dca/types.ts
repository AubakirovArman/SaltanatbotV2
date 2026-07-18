import type { Candle } from "../../types.js";
import type { Side } from "../types.js";

/**
 * Versioned pure DCA cycle state ("dca-state-v1"). The machine is driven only
 * by closed bars plus observed fills of its own transitions, so the same inputs
 * always reproduce the same state and intents. Money stays in the engine-side
 * float domain; the durable truth remains the paper ledger.
 */
export const DCA_STATE_SCHEMA_V1 = "dca-state-v1" as const;

export type DcaPhaseV1 = "idle" | "entering" | "position" | "exiting" | "cooldown" | "stopped";

export type DcaExitReasonV1 = "tp" | "tp-remainder" | "sl" | "trail" | "duration";

/** A resting order the machine placed and still expects to fill or cancel. */
export interface DcaPendingOrderV1 {
  /** Transition idempotency key, also the durable order clientId. */
  key: string;
  qty: number;
  price: number;
}

export interface DcaPendingSafetyV1 extends DcaPendingOrderV1 {
  /** 1-based safety-order index inside the current cycle. */
  index: number;
}

export interface DcaPendingCloseV1 {
  key: string;
  reason: DcaExitReasonV1;
}

export interface DcaStateV1 {
  schemaVersion: typeof DCA_STATE_SCHEMA_V1;
  phase: DcaPhaseV1;
  /** 1-based cycle counter; 0 until the first cycle starts. */
  cycle: number;
  /** Next transition ordinal inside the current cycle (keys `dca:<botId>:<cycle>:<ordinal>`). */
  ordinal: number;
  /** Safety orders filled in the current cycle. */
  soFilled: number;
  /** Base quantity currently held by the cycle (0 when flat). */
  qty: number;
  /** Volume-weighted average entry mirrored from observed fills (0 when flat). */
  avgEntry: number;
  cycleStartedAt?: number;
  pendingBase?: { key: string; qty: number };
  pendingSafety?: DcaPendingSafetyV1;
  pendingTakeProfit?: DcaPendingOrderV1;
  pendingClose?: DcaPendingCloseV1;
  /** Trailing take-profit armed once the TP threshold printed. */
  trailArmed?: boolean;
  /** Ratcheted trailing exit level; only ever tightens. */
  trailStop?: number;
  cooldownUntil?: number;
  /** Terminal reason; set exactly when phase === "stopped". */
  stopReason?: string;
}

/** One observed execution of a machine transition, keyed by its clientId. */
export interface DcaFillObservationV1 {
  key: string;
  qty: number;
  price: number;
  kind: "open" | "close";
}

export type DcaIntentV1 =
  | { kind: "placeBase"; key: string; side: Side; qty: number }
  | { kind: "placeSafetyLimit"; key: string; side: Side; index: number; qty: number; price: number }
  | { kind: "takeProfitLimit"; key: string; side: Side; qty: number; price: number }
  | { kind: "cancelAll"; key: string }
  | { kind: "closeMarket"; key: string; side: Side; reason: DcaExitReasonV1 };

export interface DcaStepInputV1 {
  bar: Candle;
  fills: readonly DcaFillObservationV1[];
  /**
   * Run bar-driven rules (cycle start, SL, trailing, duration). The engine sets
   * this on the first machine step of a closed bar only, so follow-up steps in
   * the same bar merely settle fill outcomes.
   */
  barChecks: boolean;
}

export interface DcaStepContextV1 {
  botId: string;
  /** Versioned paper fill-model parity inputs (see PAPER_FILL_MODEL_V1). */
  feePct: number;
  slipPct: number;
}

export interface DcaStepResultV1 {
  state: DcaStateV1;
  intents: DcaIntentV1[];
}

/** Durable machine snapshot persisted through the existing settings path. */
export interface DcaStateSnapshotV1 {
  schemaVersion: typeof DCA_STATE_SCHEMA_V1;
  botId: string;
  ledgerEpoch: number;
  /** Idempotency key of the last executed transition, when any ran. */
  idempotencyKey?: string;
  state: DcaStateV1;
  savedAt: number;
}

export function dcaStateSettingsKey(botId: string): string {
  return `dcaState:${botId}`;
}

export function dcaTransitionKey(botId: string, cycle: number, ordinal: number): string {
  return `dca:${botId}:${cycle}:${ordinal}`;
}

export function initialDcaState(): DcaStateV1 {
  return { schemaVersion: DCA_STATE_SCHEMA_V1, phase: "idle", cycle: 0, ordinal: 1, soFilled: 0, qty: 0, avgEntry: 0 };
}

const PHASES: readonly DcaPhaseV1[] = ["idle", "entering", "position", "exiting", "cooldown", "stopped"];
const EXIT_REASONS: readonly DcaExitReasonV1[] = ["tp", "tp-remainder", "sl", "trail", "duration"];

/** Fail-closed snapshot parser: recovery must never resume from a mangled state. */
export function parseDcaStateSnapshotV1(value: unknown, label = "dca state snapshot"): DcaStateSnapshotV1 {
  const input = object(value, label);
  if (input.schemaVersion !== DCA_STATE_SCHEMA_V1) throw new Error(`${label} has an unsupported schema version`);
  const snapshot: DcaStateSnapshotV1 = {
    schemaVersion: DCA_STATE_SCHEMA_V1,
    botId: text(input.botId, `${label}.botId`),
    ledgerEpoch: integer(input.ledgerEpoch, `${label}.ledgerEpoch`, 1),
    state: parseDcaStateV1(input.state, `${label}.state`),
    savedAt: integer(input.savedAt, `${label}.savedAt`, 1)
  };
  if (input.idempotencyKey !== undefined) snapshot.idempotencyKey = text(input.idempotencyKey, `${label}.idempotencyKey`);
  return snapshot;
}

export function parseDcaStateV1(value: unknown, label = "dca state"): DcaStateV1 {
  const input = object(value, label);
  if (input.schemaVersion !== DCA_STATE_SCHEMA_V1) throw new Error(`${label} has an unsupported schema version`);
  const state: DcaStateV1 = {
    schemaVersion: DCA_STATE_SCHEMA_V1,
    phase: oneOf(input.phase, PHASES, `${label}.phase`),
    cycle: integer(input.cycle, `${label}.cycle`, 0),
    ordinal: integer(input.ordinal, `${label}.ordinal`, 1),
    soFilled: integer(input.soFilled, `${label}.soFilled`, 0),
    qty: finite(input.qty, `${label}.qty`, 0),
    avgEntry: finite(input.avgEntry, `${label}.avgEntry`, 0)
  };
  if (input.cycleStartedAt !== undefined) state.cycleStartedAt = integer(input.cycleStartedAt, `${label}.cycleStartedAt`, 1);
  if (input.pendingBase !== undefined) {
    const pending = object(input.pendingBase, `${label}.pendingBase`);
    state.pendingBase = { key: text(pending.key, `${label}.pendingBase.key`), qty: positive(pending.qty, `${label}.pendingBase.qty`) };
  }
  if (input.pendingSafety !== undefined) {
    state.pendingSafety = { ...parsePending(input.pendingSafety, `${label}.pendingSafety`), index: integer(object(input.pendingSafety, label).index, `${label}.pendingSafety.index`, 1) };
  }
  if (input.pendingTakeProfit !== undefined) state.pendingTakeProfit = parsePending(input.pendingTakeProfit, `${label}.pendingTakeProfit`);
  if (input.pendingClose !== undefined) {
    const pending = object(input.pendingClose, `${label}.pendingClose`);
    state.pendingClose = { key: text(pending.key, `${label}.pendingClose.key`), reason: oneOf(pending.reason, EXIT_REASONS, `${label}.pendingClose.reason`) };
  }
  if (input.trailArmed !== undefined) state.trailArmed = boolean(input.trailArmed, `${label}.trailArmed`);
  if (input.trailStop !== undefined) state.trailStop = positive(input.trailStop, `${label}.trailStop`);
  if (input.cooldownUntil !== undefined) state.cooldownUntil = integer(input.cooldownUntil, `${label}.cooldownUntil`, 1);
  if (input.stopReason !== undefined) state.stopReason = text(input.stopReason, `${label}.stopReason`);
  if ((state.phase === "stopped") !== (state.stopReason !== undefined)) throw new Error(`${label} stop reason does not match its phase`);
  return state;
}

function parsePending(value: unknown, label: string): DcaPendingOrderV1 {
  const input = object(value, label);
  return { key: text(input.key, `${label}.key`), qty: positive(input.qty, `${label}.qty`), price: positive(input.price, `${label}.price`) };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is out of bounds`);
  return value;
}

function finite(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${label} is out of bounds`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} is out of bounds`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}
