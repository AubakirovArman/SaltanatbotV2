import type { GridParamsV1 } from "@saltanatbotv2/contracts";
import type { Candle } from "../../types.js";
import type { ExecOrder, ExecResult, FillRecord, MarketType, OrderJournalRecord } from "../types.js";
import { oppositeSide, stepGridMachine } from "./machine.js";
import {
  GRID_STATE_SCHEMA_V1,
  type GridFillObservationV1,
  type GridIntentV1,
  type GridStateSnapshotV1,
  type GridStateV1
} from "./types.js";

/**
 * Executes the pure grid-state-v1 machine against the real order path: every
 * intent goes through the injected executor (OrderLifecycle + PaperAdapter,
 * averaging-v1) with its transition key as the durable clientId, and the
 * machine snapshot is persisted through the injected settings store under the
 * same transition idempotency key. The engine and the golden-replay harness
 * share this module verbatim.
 */
export interface GridRuntimeDeps {
  botId: string;
  symbol: string;
  market: MarketType;
  ledgerEpoch: number;
  params: GridParamsV1;
  fillModel: { feePct: number; slipPct: number };
  execute: (order: ExecOrder) => Promise<ExecResult>;
  /** Durable order-journal lookup used for crash-safe transition dedup. */
  getOrder?: (id: string) => OrderJournalRecord | undefined;
  saveSnapshot: (snapshot: GridStateSnapshotV1) => void;
}

export interface GridBarResult {
  state: GridStateV1;
  lastTransitionKey?: string;
}

/** Settled fills can chain transitions (stop-loss flatten -> terminal), but a
 * single closed bar can never legitimately need more rounds than this. */
const MAX_STEP_ROUNDS = 8;

export async function runGridClosedBar(
  state: GridStateV1,
  bar: Candle,
  observed: readonly GridFillObservationV1[],
  deps: GridRuntimeDeps,
  lastTransitionKey?: string
): Promise<GridBarResult> {
  let current = state;
  let fills: readonly GridFillObservationV1[] = observed;
  let lastKey = lastTransitionKey;
  for (let round = 0; ; round += 1) {
    if (round >= MAX_STEP_ROUNDS) throw new Error(`Grid bot ${deps.botId} exceeded the per-bar transition budget`);
    const result = stepGridMachine(
      current,
      { bar, fills, barChecks: round === 0 },
      deps.params,
      { botId: deps.botId, feePct: deps.fillModel.feePct, slipPct: deps.fillModel.slipPct }
    );
    current = result.state;
    if (result.intents.length === 0) break;
    const settled: GridFillObservationV1[] = [];
    for (const intent of result.intents) {
      settled.push(...await executeGridIntent(intent, deps));
      lastKey = intent.key;
      deps.saveSnapshot(gridSnapshotOf(deps, current, bar.time, lastKey));
    }
    fills = settled;
    if (fills.length === 0) break;
  }
  deps.saveSnapshot(gridSnapshotOf(deps, current, bar.time, lastKey));
  return { state: current, lastTransitionKey: lastKey };
}

/**
 * Reconcile persisted pending transitions against the durable order journal
 * once per process start: journaled fills are replayed into the machine, and
 * transitions whose durable outcome is missing or ambiguous are re-executed
 * (the paper adapter deduplicates by clientId, so a survived order is a no-op
 * and a restart never duplicates levels or reserves).
 */
export async function recoverGridObservations(state: GridStateV1, deps: GridRuntimeDeps): Promise<GridFillObservationV1[]> {
  const observations: GridFillObservationV1[] = [];
  const pendings: Array<{ key: string; kind: "open" | "close"; intent: GridIntentV1 }> = [];
  for (const level of state.levels) {
    if (level.order) {
      pendings.push({
        key: level.order.key,
        kind: "open",
        intent: { kind: "placeLevelLimit", key: level.order.key, side: level.side, index: level.index, qty: level.order.qty, price: level.order.price }
      });
    }
    if (level.pair) {
      pendings.push({
        key: level.pair.key,
        kind: "close",
        intent: { kind: "placePairLimit", key: level.pair.key, side: oppositeSide(level.side), index: level.index, qty: level.pair.qty, price: level.pair.price }
      });
    }
  }
  if (state.pendingStop) {
    pendings.push({
      key: state.pendingStop.key,
      kind: "close",
      intent: { kind: "closeMarket", key: state.pendingStop.key, side: state.inventoryBaseQty >= 0 ? "sell" : "buy", reason: state.pendingStop.reason }
    });
  }
  for (const pending of pendings) {
    const record = deps.getOrder?.(pending.key);
    const journaled = journaledObservation(record, pending.key, pending.kind);
    if (journaled) {
      observations.push(journaled);
    } else if (!record || record.status === "intent" || record.status === "unknown") {
      observations.push(...await executeGridIntent(pending.intent, deps));
    }
  }
  return observations;
}

/** Map queued paper trigger fills onto machine observations; a grid fill always
 * carries its transition key as the clientId, so a missing one fails closed. */
export function toGridObservations(fills: readonly FillRecord[]): GridFillObservationV1[] {
  return fills.map((fill) => {
    if (!fill.clientId?.trim()) throw new Error(`Grid fill ${fill.id} lacks a transition identity`);
    return { key: fill.clientId, qty: fill.qty, price: fill.price, kind: fill.kind };
  });
}

export function gridSnapshotOf(
  deps: Pick<GridRuntimeDeps, "botId" | "ledgerEpoch">,
  state: GridStateV1,
  savedAt: number,
  idempotencyKey?: string
): GridStateSnapshotV1 {
  return {
    schemaVersion: GRID_STATE_SCHEMA_V1,
    botId: deps.botId,
    ledgerEpoch: deps.ledgerEpoch,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    state: structuredClone(state),
    savedAt
  };
}

async function executeGridIntent(intent: GridIntentV1, deps: GridRuntimeDeps): Promise<GridFillObservationV1[]> {
  const existing = deps.getOrder?.(intent.key);
  if (existing && terminalStatus(existing.status)) {
    const journaled = journaledObservation(existing, intent.key, existing.reduceOnly ? "close" : "open");
    return journaled ? [journaled] : [];
  }
  const result = await deps.execute(gridIntentOrder(intent, deps));
  if (!result.ok) throw new Error(`Grid ${intent.kind} (${intent.key}) was rejected: ${result.message}`);
  return result.fills
    .filter((fill) => fill.qty > 0)
    .map((fill) => ({ key: intent.key, qty: fill.qty, price: fill.price, kind: fill.kind }));
}

export function gridIntentOrder(intent: GridIntentV1, deps: Pick<GridRuntimeDeps, "symbol" | "market">): ExecOrder {
  const base = { market: deps.market, symbol: deps.symbol, clientId: intent.key };
  switch (intent.kind) {
    case "placeLevelLimit":
      return { ...base, action: "neworder", type: "limit", side: intent.side, qty: intent.qty, price: intent.price, reason: `grid:level:${intent.index}` };
    case "placePairLimit":
      return { ...base, action: "neworder", type: "limit", side: intent.side, qty: intent.qty, price: intent.price, reason: `grid:pair:${intent.index}` };
    case "cancelAll":
      return { ...base, action: "cancelall", type: "market", reason: "grid:cancel-all" };
    case "closeMarket":
      return { ...base, action: "close", type: "market", side: intent.side, closePct: 100, reduceOnly: true, reason: `grid:close:${intent.reason}` };
    default:
      throw new Error("Unknown grid intent");
  }
}

function journaledObservation(
  record: OrderJournalRecord | undefined,
  key: string,
  kind: "open" | "close"
): GridFillObservationV1 | undefined {
  if (!record) return undefined;
  const qty = record.accountedFilledQty ?? record.filledQty ?? 0;
  if (!(qty > 0) || record.avgFillPrice === undefined || !(record.avgFillPrice > 0)) return undefined;
  return { key, qty, price: record.avgFillPrice, kind };
}

function terminalStatus(status: OrderJournalRecord["status"]): boolean {
  return status === "filled" || status === "cancelled" || status === "expired" || status === "rejected" || status === "replaced";
}
