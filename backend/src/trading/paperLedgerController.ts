import {
  appendPaperEvents,
  replayPaperLedger,
  stampPaperLedgerEvent,
  type PaperLedgerEvent,
  type PaperLedgerEventDraft,
  type PaperLedgerState
} from "./paperLedger.js";
import type { FillRecord, PendingOrder, PositionState } from "./types.js";

export interface PaperState {
  balance: number;
  position: PositionState | null;
  orders: PendingOrder[];
  leverage: number;
  isolated: boolean;
  dualSide: boolean;
}

export interface VerifiedPaperFundingSettlement {
  settlementId: string;
  symbol: string;
  rate: number;
  markPrice: number;
  settledAt: number;
  source: string;
  verified: true;
}

interface ControllerOptions {
  botId: string;
  startBalance: number;
  now: () => number;
  createId: () => string;
  initialEvents?: PaperLedgerEvent[];
  persistEvents?: (events: readonly PaperLedgerEvent[]) => void;
}

export class PaperLedgerController {
  private eventsValue: PaperLedgerEvent[] = [];
  private persistEvents?: (events: readonly PaperLedgerEvent[]) => void;

  constructor(private readonly options: ControllerOptions) {
    this.persistEvents = options.persistEvents;
    if (options.initialEvents?.length) {
      this.restore(options.initialEvents);
      return;
    }
    this.commitEvents([stampPaperLedgerEvent(
      options.botId,
      1,
      { type: "account_initialized", data: { balance: options.startBalance, leverage: 1, isolated: false, dualSide: false } },
      options.now(),
      options.createId(),
      "account-initialized"
    )]);
  }

  events(): PaperLedgerEvent[] {
    return structuredClone(this.eventsValue);
  }

  state(): PaperLedgerState {
    return replayPaperLedger(this.eventsValue, this.options.botId);
  }

  restore(events: readonly PaperLedgerEvent[]): PaperLedgerState {
    const recovered = appendPaperEvents([], events, this.options.botId);
    this.eventsValue = recovered.events;
    return recovered.state;
  }

  setPersistence(persist: (events: readonly PaperLedgerEvent[]) => void): void {
    persist(this.eventsValue);
    this.persistEvents = persist;
  }

  importLegacy(state: PaperState): PaperLedgerState {
    if (this.eventsValue.length !== 1) throw new Error("Cannot overwrite a non-empty paper ledger with a legacy snapshot");
    const current = this.state();
    if (!Number.isFinite(state.balance)) throw new Error("Legacy paper balance is invalid");
    const drafts: PaperLedgerEventDraft[] = [];
    const delta = state.balance - current.balance;
    if (Math.abs(delta) > 1e-9) drafts.push({ type: "cash", data: { amount: delta, reason: "legacy-balance-adjustment" } });
    for (const order of state.orders ?? []) drafts.push({ type: "order_upserted", data: { order: structuredClone(order) } });
    if (state.position) drafts.push({ type: "position", data: { position: structuredClone(state.position) } });
    drafts.push({
      type: "settings",
      data: { leverage: state.leverage ?? 1, isolated: state.isolated ?? false, dualSide: state.dualSide ?? false }
    });
    return this.commitDrafts(drafts);
  }

  commitTransition(before: PaperState, after: PaperState, fills: FillRecord[], reason: string): PaperLedgerState {
    const drafts: PaperLedgerEventDraft[] = [];
    for (const fill of fills) {
      drafts.push({ type: "fill", data: { fill: structuredClone(fill) } });
      if (fill.fee > 0) drafts.push({ type: "fee", data: { fillId: fill.id, amount: fill.fee, asset: fill.feeAsset ?? "USDT" } });
      if (fill.kind === "close") {
        drafts.push({ type: "cash", data: { fillId: fill.id, amount: round(fill.realizedPnl + fill.fee), reason: "realized-pnl" } });
      }
    }
    const afterOrders = new Map(after.orders.map((order) => [order.id, order]));
    for (const order of before.orders) {
      if (!afterOrders.has(order.id)) drafts.push({ type: "order_cancelled", data: { orderId: order.id, reason } });
    }
    const beforeOrders = new Map(before.orders.map((order) => [order.id, order]));
    for (const order of after.orders) {
      if (stableStringify(beforeOrders.get(order.id)) !== stableStringify(order)) {
        drafts.push({ type: "order_upserted", data: { order: structuredClone(order) } });
      }
    }
    if (stableStringify(before.position) !== stableStringify(after.position)) {
      drafts.push({ type: "position", data: { position: after.position ? structuredClone(after.position) : null } });
    }
    if (before.leverage !== after.leverage || before.isolated !== after.isolated || before.dualSide !== after.dualSide) {
      drafts.push({ type: "settings", data: { leverage: after.leverage, isolated: after.isolated, dualSide: after.dualSide } });
    }
    if (drafts.length === 0) {
      const recovered = this.state();
      if (!samePaperState(toPaperState(recovered), after)) throw new Error("Paper ledger transition does not reproduce the mutated state");
      return recovered;
    }
    const additions = this.stampDrafts(drafts);
    const preview = appendPaperEvents(this.eventsValue, additions, this.options.botId);
    if (!samePaperState(toPaperState(preview.state), after)) {
      throw new Error("Paper ledger transition does not reproduce the mutated state");
    }
    return this.commitEvents(additions, preview);
  }

  applyFunding(settlement: VerifiedPaperFundingSettlement, position: PositionState | null): { amount: number; state: PaperLedgerState } {
    validateSettlement(settlement);
    const key = `funding:${settlement.settlementId}`;
    const prior = this.eventsValue.find((event) => event.type === "funding" && event.idempotencyKey === key);
    if (prior?.type === "funding") return { amount: prior.data.amount, state: this.state() };
    const eligible = position?.symbol === settlement.symbol && position.openedAt <= settlement.settledAt;
    const positionQty = eligible ? position.qty : 0;
    const direction = eligible ? (position.side === "long" ? -1 : 1) : 0;
    const amount = round(direction * positionQty * settlement.markPrice * settlement.rate);
    const state = this.commitDrafts([{
      type: "funding",
      data: { ...settlement, positionQty, amount }
    }], settlement.settledAt, key);
    return { amount, state };
  }

  private commitDrafts(drafts: PaperLedgerEventDraft[], ts = this.options.now(), idempotencyKey?: string): PaperLedgerState {
    if (drafts.length === 0) return this.state();
    return this.commitEvents(this.stampDrafts(drafts, ts, idempotencyKey));
  }

  private stampDrafts(drafts: PaperLedgerEventDraft[], ts = this.options.now(), idempotencyKey?: string): PaperLedgerEvent[] {
    let sequence = this.eventsValue.at(-1)?.sequence ?? 0;
    return drafts.map((draft) => stampPaperLedgerEvent(
      this.options.botId,
      ++sequence,
      draft,
      ts,
      this.options.createId(),
      idempotencyKey && drafts.length === 1 ? idempotencyKey : undefined
    ));
  }

  private commitEvents(
    additions: PaperLedgerEvent[],
    prepared = appendPaperEvents(this.eventsValue, additions, this.options.botId)
  ): PaperLedgerState {
    this.persistEvents?.(additions);
    this.eventsValue = prepared.events;
    return prepared.state;
  }
}

export function toPaperState(state: PaperLedgerState): PaperState {
  return {
    balance: state.balance,
    position: state.position ? structuredClone(state.position) : null,
    orders: structuredClone(state.orders),
    leverage: state.leverage,
    isolated: state.isolated,
    dualSide: state.dualSide
  };
}

function validateSettlement(value: VerifiedPaperFundingSettlement): void {
  if (
    value.verified !== true
    || !value.settlementId.trim()
    || !value.source.trim()
    || !Number.isFinite(value.rate)
    || !Number.isFinite(value.markPrice)
    || value.markPrice <= 0
    || !Number.isFinite(value.settledAt)
    || value.settledAt <= 0
  ) throw new Error("Paper funding requires a verified settlement event");
}

function samePaperState(left: PaperState, right: PaperState): boolean {
  return Math.abs(left.balance - right.balance) <= 1e-6
    && stableStringify({ ...left, balance: 0 }) === stableStringify({ ...right, balance: 0 });
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
