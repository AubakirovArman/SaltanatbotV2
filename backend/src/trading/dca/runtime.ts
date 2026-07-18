import type { DcaParamsV1 } from "@saltanatbotv2/contracts";
import type { Candle } from "../../types.js";
import type { ExecOrder, ExecResult, FillRecord, MarketType, OrderJournalRecord } from "../types.js";
import { entrySide, exitSide, stepDcaMachine } from "./machine.js";
import {
  DCA_STATE_SCHEMA_V1,
  type DcaFillObservationV1,
  type DcaIntentV1,
  type DcaStateSnapshotV1,
  type DcaStateV1
} from "./types.js";

/**
 * Executes the pure dca-state-v1 machine against the real order path: every
 * intent goes through the injected executor (OrderLifecycle + PaperAdapter,
 * averaging-v1) with its transition key as the durable clientId, and the
 * machine snapshot is persisted through the injected settings store under the
 * same transition idempotency key. The engine and the golden-replay harness
 * share this module verbatim.
 */
export interface DcaRuntimeDeps {
  botId: string;
  symbol: string;
  market: MarketType;
  ledgerEpoch: number;
  params: DcaParamsV1;
  fillModel: { feePct: number; slipPct: number };
  execute: (order: ExecOrder) => Promise<ExecResult>;
  /** Durable order-journal lookup used for crash-safe transition dedup. */
  getOrder?: (id: string) => OrderJournalRecord | undefined;
  saveSnapshot: (snapshot: DcaStateSnapshotV1) => void;
}

export interface DcaBarResult {
  state: DcaStateV1;
  lastTransitionKey?: string;
}

/** Settled fills can chain transitions (base fill -> TP + SO placement), but a
 * single closed bar can never legitimately need more rounds than this. */
const MAX_STEP_ROUNDS = 8;

export async function runDcaClosedBar(
  state: DcaStateV1,
  bar: Candle,
  observed: readonly DcaFillObservationV1[],
  deps: DcaRuntimeDeps,
  lastTransitionKey?: string
): Promise<DcaBarResult> {
  let current = state;
  let fills: readonly DcaFillObservationV1[] = observed;
  let lastKey = lastTransitionKey;
  for (let round = 0; ; round += 1) {
    if (round >= MAX_STEP_ROUNDS) throw new Error(`DCA bot ${deps.botId} exceeded the per-bar transition budget`);
    const result = stepDcaMachine(
      current,
      { bar, fills, barChecks: round === 0 },
      deps.params,
      { botId: deps.botId, feePct: deps.fillModel.feePct, slipPct: deps.fillModel.slipPct }
    );
    current = result.state;
    if (result.intents.length === 0) break;
    const settled: DcaFillObservationV1[] = [];
    for (const intent of result.intents) {
      settled.push(...await executeDcaIntent(intent, deps));
      lastKey = intent.key;
      deps.saveSnapshot(dcaSnapshotOf(deps, current, bar.time, lastKey));
    }
    fills = settled;
    if (fills.length === 0) break;
  }
  deps.saveSnapshot(dcaSnapshotOf(deps, current, bar.time, lastKey));
  return { state: current, lastTransitionKey: lastKey };
}

/**
 * Reconcile persisted pending transitions against the durable order journal
 * once per process start: journaled fills are replayed into the machine, and
 * transitions whose durable outcome is missing or ambiguous are re-executed
 * (the paper adapter deduplicates by clientId, so a survived order is a no-op).
 */
export async function recoverDcaObservations(state: DcaStateV1, deps: DcaRuntimeDeps): Promise<DcaFillObservationV1[]> {
  const observations: DcaFillObservationV1[] = [];
  const pendings: Array<{ key: string; kind: "open" | "close"; intent: DcaIntentV1 }> = [];
  if (state.pendingBase) {
    pendings.push({
      key: state.pendingBase.key,
      kind: "open",
      intent: { kind: "placeBase", key: state.pendingBase.key, side: entrySide(deps.params), qty: state.pendingBase.qty }
    });
  }
  if (state.pendingSafety) {
    pendings.push({
      key: state.pendingSafety.key,
      kind: "open",
      intent: { kind: "placeSafetyLimit", key: state.pendingSafety.key, side: entrySide(deps.params), index: state.pendingSafety.index, qty: state.pendingSafety.qty, price: state.pendingSafety.price }
    });
  }
  if (state.pendingTakeProfit) {
    pendings.push({
      key: state.pendingTakeProfit.key,
      kind: "close",
      intent: { kind: "takeProfitLimit", key: state.pendingTakeProfit.key, side: exitSide(deps.params), qty: state.pendingTakeProfit.qty, price: state.pendingTakeProfit.price }
    });
  }
  if (state.pendingClose) {
    pendings.push({
      key: state.pendingClose.key,
      kind: "close",
      intent: { kind: "closeMarket", key: state.pendingClose.key, side: exitSide(deps.params), reason: state.pendingClose.reason }
    });
  }
  for (const pending of pendings) {
    const record = deps.getOrder?.(pending.key);
    const journaled = journaledObservation(record, pending.key, pending.kind);
    if (journaled) {
      observations.push(journaled);
    } else if (!record || record.status === "intent" || record.status === "unknown") {
      observations.push(...await executeDcaIntent(pending.intent, deps));
    }
  }
  return observations;
}

/** Map queued paper trigger fills onto machine observations; a DCA fill always
 * carries its transition key as the clientId, so a missing one fails closed. */
export function toDcaObservations(fills: readonly FillRecord[]): DcaFillObservationV1[] {
  return fills.map((fill) => {
    if (!fill.clientId?.trim()) throw new Error(`DCA fill ${fill.id} lacks a transition identity`);
    return { key: fill.clientId, qty: fill.qty, price: fill.price, kind: fill.kind };
  });
}

export function dcaSnapshotOf(
  deps: Pick<DcaRuntimeDeps, "botId" | "ledgerEpoch">,
  state: DcaStateV1,
  savedAt: number,
  idempotencyKey?: string
): DcaStateSnapshotV1 {
  return {
    schemaVersion: DCA_STATE_SCHEMA_V1,
    botId: deps.botId,
    ledgerEpoch: deps.ledgerEpoch,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    state: structuredClone(state),
    savedAt
  };
}

async function executeDcaIntent(intent: DcaIntentV1, deps: DcaRuntimeDeps): Promise<DcaFillObservationV1[]> {
  const existing = deps.getOrder?.(intent.key);
  if (existing && terminalStatus(existing.status)) {
    const journaled = journaledObservation(existing, intent.key, existing.reduceOnly ? "close" : "open");
    return journaled ? [journaled] : [];
  }
  const result = await deps.execute(dcaIntentOrder(intent, deps));
  if (!result.ok) throw new Error(`DCA ${intent.kind} (${intent.key}) was rejected: ${result.message}`);
  return result.fills
    .filter((fill) => fill.qty > 0)
    .map((fill) => ({ key: intent.key, qty: fill.qty, price: fill.price, kind: fill.kind }));
}

export function dcaIntentOrder(intent: DcaIntentV1, deps: Pick<DcaRuntimeDeps, "symbol" | "market">): ExecOrder {
  const base = { market: deps.market, symbol: deps.symbol, clientId: intent.key };
  switch (intent.kind) {
    case "placeBase":
      return { ...base, action: "neworder", type: "market", side: intent.side, qty: intent.qty, reason: "dca:base" };
    case "placeSafetyLimit":
      return { ...base, action: "neworder", type: "limit", side: intent.side, qty: intent.qty, price: intent.price, reason: `dca:safety:${intent.index}` };
    case "takeProfitLimit":
      return { ...base, action: "neworder", type: "limit", side: intent.side, qty: intent.qty, price: intent.price, reduceOnly: true, reason: "dca:take-profit" };
    case "cancelAll":
      return { ...base, action: "cancelall", type: "market", reason: "dca:cancel-all" };
    case "closeMarket":
      return { ...base, action: "close", type: "market", side: intent.side, closePct: 100, reduceOnly: true, reason: `dca:close:${intent.reason}` };
    default:
      throw new Error("Unknown DCA intent");
  }
}

function journaledObservation(
  record: OrderJournalRecord | undefined,
  key: string,
  kind: "open" | "close"
): DcaFillObservationV1 | undefined {
  if (!record) return undefined;
  const qty = record.accountedFilledQty ?? record.filledQty ?? 0;
  if (!(qty > 0) || record.avgFillPrice === undefined || !(record.avgFillPrice > 0)) return undefined;
  return { key, qty, price: record.avgFillPrice, kind };
}

function terminalStatus(status: OrderJournalRecord["status"]): boolean {
  return status === "filled" || status === "cancelled" || status === "expired" || status === "rejected" || status === "replaced";
}
