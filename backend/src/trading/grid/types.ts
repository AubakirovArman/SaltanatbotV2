import type { Candle } from "../../types.js";
import type { Side } from "../types.js";

/**
 * Versioned pure grid cycle state ("grid-state-v1"). The machine is driven only
 * by closed bars plus observed fills of its own transitions, so the same inputs
 * always reproduce the same state and intents. Money stays in the engine-side
 * float domain; the durable truth remains the paper ledger.
 */
export const GRID_STATE_SCHEMA_V1 = "grid-state-v1" as const;

export type GridPhaseV1 = "idle" | "active" | "paused" | "stopped";

export type GridStopReasonV1 = "stop-loss" | "outside-range" | "max-cycles";

export type GridLevelSideV1 = "buy" | "sell";

/**
 * Per-level lifecycle: "resting" holds a ladder limit order, "filled" holds the
 * observed open fill plus (once placed) its paired close order at the adjacent
 * level price, "cooldown" waits for the re-arm delay after a completed pair,
 * and "disabled" never arms in the current mode (or lost its order to a
 * terminal cancel-all).
 */
export type GridLevelStatusV1 = "resting" | "filled" | "cooldown" | "disabled";

/** A resting order the machine placed and still expects to fill or cancel. */
export interface GridPendingOrderV1 {
  /** Transition idempotency key, also the durable order clientId. */
  key: string;
  qty: number;
  price: number;
}

export interface GridLevelV1 {
  /** 1-based ladder index; level prices ascend with the index. */
  index: number;
  /** Canonical six-decimal ladder price from the shared gridLevelPrices. */
  price: number;
  /** Ladder side fixed at anchor time: buy strictly below, sell strictly above. */
  side: GridLevelSideV1;
  status: GridLevelStatusV1;
  /** Transition ordinal of the last order this level placed. */
  orderOrdinal?: number;
  /** Resting ladder order; present exactly when status === "resting". */
  order?: GridPendingOrderV1;
  /** Observed open fill the level still holds; present when status === "filled". */
  openQty?: number;
  openPrice?: number;
  /** Paired close order at the adjacent level price (deferred while paused). */
  pair?: GridPendingOrderV1;
  /** Re-arm time; present exactly when status === "cooldown". */
  cooldownUntil?: number;
}

export interface GridStateV1 {
  schemaVersion: typeof GRID_STATE_SCHEMA_V1;
  phase: GridPhaseV1;
  /** 1-based placement epoch (keys `grid:<botId>:<epochCycle>:<ordinal>`); 0 until anchored. */
  epochCycle: number;
  /** Next transition ordinal inside the current epoch; monotonic per transition. */
  cursorOrdinal: number;
  /** Ladder levels in ascending index order; empty until the grid anchors. */
  levels: GridLevelV1[];
  /** Signed base inventory mirrored from observed fills (negative = short leg). */
  inventoryBaseQty: number;
  /** VWAP cost of the held inventory leg (0 when flat). */
  inventoryAvgCost: number;
  /** Realized quote PnL accumulated from completed level pairs, fee-adjusted. */
  realizedGridPnl: number;
  /** Completed buy-to-sell (or sell-to-buy) round trips across all levels. */
  cyclesCompleted: number;
  /** Market flatten in flight after a stop-loss cross. */
  pendingStop?: { key: string; reason: GridStopReasonV1 };
  /** Terminal reason; set exactly when phase === "stopped". */
  stopReason?: string;
}

/** One observed execution of a machine transition, keyed by its clientId. */
export interface GridFillObservationV1 {
  key: string;
  qty: number;
  price: number;
  kind: "open" | "close";
}

export type GridIntentV1 =
  | { kind: "placeLevelLimit"; key: string; side: Side; index: number; qty: number; price: number }
  | { kind: "placePairLimit"; key: string; side: Side; index: number; qty: number; price: number }
  | { kind: "cancelAll"; key: string }
  | { kind: "closeMarket"; key: string; side: Side; reason: GridStopReasonV1 };

export interface GridStepInputV1 {
  bar: Candle;
  fills: readonly GridFillObservationV1[];
  /**
   * Run bar-driven rules (anchor, stop-loss, outside-range, cooldown re-arm).
   * The engine sets this on the first machine step of a closed bar only, so
   * follow-up steps in the same bar merely settle fill outcomes.
   */
  barChecks: boolean;
}

export interface GridStepContextV1 {
  botId: string;
  /** Versioned paper fill-model parity inputs (see PAPER_FILL_MODEL_V1). */
  feePct: number;
  slipPct: number;
}

export interface GridStepResultV1 {
  state: GridStateV1;
  intents: GridIntentV1[];
}

/** Durable machine snapshot persisted through the existing settings path. */
export interface GridStateSnapshotV1 {
  schemaVersion: typeof GRID_STATE_SCHEMA_V1;
  botId: string;
  ledgerEpoch: number;
  /** Idempotency key of the last executed transition, when any ran. */
  idempotencyKey?: string;
  state: GridStateV1;
  savedAt: number;
}

export function gridStateSettingsKey(botId: string): string {
  return `gridState:${botId}`;
}

export function gridTransitionKey(botId: string, epochCycle: number, ordinal: number): string {
  return `grid:${botId}:${epochCycle}:${ordinal}`;
}

export function initialGridState(): GridStateV1 {
  return {
    schemaVersion: GRID_STATE_SCHEMA_V1,
    phase: "idle",
    epochCycle: 0,
    cursorOrdinal: 1,
    levels: [],
    inventoryBaseQty: 0,
    inventoryAvgCost: 0,
    realizedGridPnl: 0,
    cyclesCompleted: 0
  };
}

const PHASES: readonly GridPhaseV1[] = ["idle", "active", "paused", "stopped"];
const STOP_REASONS: readonly GridStopReasonV1[] = ["stop-loss", "outside-range", "max-cycles"];
const LEVEL_SIDES: readonly GridLevelSideV1[] = ["buy", "sell"];
const LEVEL_STATUSES: readonly GridLevelStatusV1[] = ["resting", "filled", "cooldown", "disabled"];

/** Fail-closed snapshot parser: recovery must never resume from a mangled
 * state. Objects are rebuilt with the machine's own key insertion order so a
 * parsed snapshot serializes byte-identically to a freshly driven one. */
export function parseGridStateSnapshotV1(value: unknown, label = "grid state snapshot"): GridStateSnapshotV1 {
  const input = object(value, label);
  if (input.schemaVersion !== GRID_STATE_SCHEMA_V1) throw new Error(`${label} has an unsupported schema version`);
  return {
    schemaVersion: GRID_STATE_SCHEMA_V1,
    botId: text(input.botId, `${label}.botId`),
    ledgerEpoch: integer(input.ledgerEpoch, `${label}.ledgerEpoch`, 1),
    idempotencyKey: input.idempotencyKey !== undefined ? text(input.idempotencyKey, `${label}.idempotencyKey`) : undefined,
    state: parseGridStateV1(input.state, `${label}.state`),
    savedAt: integer(input.savedAt, `${label}.savedAt`, 1)
  };
}

export function parseGridStateV1(value: unknown, label = "grid state"): GridStateV1 {
  const input = object(value, label);
  if (input.schemaVersion !== GRID_STATE_SCHEMA_V1) throw new Error(`${label} has an unsupported schema version`);
  if (!Array.isArray(input.levels)) throw new Error(`${label}.levels must be an array`);
  const state: GridStateV1 = {
    schemaVersion: GRID_STATE_SCHEMA_V1,
    phase: oneOf(input.phase, PHASES, `${label}.phase`),
    epochCycle: integer(input.epochCycle, `${label}.epochCycle`, 0),
    cursorOrdinal: integer(input.cursorOrdinal, `${label}.cursorOrdinal`, 1),
    levels: input.levels.map((level, at) => parseGridLevelV1(level, `${label}.levels[${at}]`, at + 1)),
    inventoryBaseQty: finite(input.inventoryBaseQty, `${label}.inventoryBaseQty`),
    inventoryAvgCost: finite(input.inventoryAvgCost, `${label}.inventoryAvgCost`),
    realizedGridPnl: finite(input.realizedGridPnl, `${label}.realizedGridPnl`),
    cyclesCompleted: integer(input.cyclesCompleted, `${label}.cyclesCompleted`, 0),
    pendingStop: input.pendingStop !== undefined
      ? {
        key: text(object(input.pendingStop, `${label}.pendingStop`).key, `${label}.pendingStop.key`),
        reason: oneOf(object(input.pendingStop, `${label}.pendingStop`).reason, STOP_REASONS, `${label}.pendingStop.reason`)
      }
      : undefined,
    stopReason: input.stopReason !== undefined ? text(input.stopReason, `${label}.stopReason`) : undefined
  };
  if ((state.phase === "stopped") !== (state.stopReason !== undefined)) throw new Error(`${label} stop reason does not match its phase`);
  return state;
}

function parseGridLevelV1(value: unknown, label: string, expectedIndex: number): GridLevelV1 {
  const input = object(value, label);
  const level: GridLevelV1 = {
    index: integer(input.index, `${label}.index`, 1),
    price: positive(input.price, `${label}.price`),
    side: oneOf(input.side, LEVEL_SIDES, `${label}.side`),
    status: oneOf(input.status, LEVEL_STATUSES, `${label}.status`),
    order: input.order !== undefined ? parsePending(input.order, `${label}.order`) : undefined,
    orderOrdinal: input.orderOrdinal !== undefined ? integer(input.orderOrdinal, `${label}.orderOrdinal`, 1) : undefined,
    openQty: input.openQty !== undefined ? positive(input.openQty, `${label}.openQty`) : undefined,
    openPrice: input.openPrice !== undefined ? positive(input.openPrice, `${label}.openPrice`) : undefined,
    pair: input.pair !== undefined ? parsePending(input.pair, `${label}.pair`) : undefined,
    cooldownUntil: input.cooldownUntil !== undefined ? integer(input.cooldownUntil, `${label}.cooldownUntil`, 1) : undefined
  };
  if (level.index !== expectedIndex) throw new Error(`${label} is out of ladder order`);
  if ((level.status === "resting") !== (level.order !== undefined)) throw new Error(`${label} resting order does not match its status`);
  if (level.status === "filled" && (level.openQty === undefined || level.openPrice === undefined)) {
    throw new Error(`${label} filled level is missing its open fill`);
  }
  if (level.status !== "filled" && (level.openQty !== undefined || level.openPrice !== undefined || level.pair !== undefined)) {
    throw new Error(`${label} carries open-fill state outside the filled status`);
  }
  if ((level.status === "cooldown") !== (level.cooldownUntil !== undefined)) throw new Error(`${label} cooldown time does not match its status`);
  return level;
}

function parsePending(value: unknown, label: string): GridPendingOrderV1 {
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

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is out of bounds`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
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
