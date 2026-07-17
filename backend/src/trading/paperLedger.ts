import type { ExecResult, FillRecord, PendingOrder, PositionState } from "./types.js";

interface PaperEventBase {
  id: string;
  botId: string;
  ledgerEpoch: number;
  sequence: number;
  ts: number;
  idempotencyKey?: string;
}

export type PaperLedgerEvent =
  | PaperEventBase & { type: "account_initialized"; data: { balance: number; leverage: number; isolated: boolean; dualSide: boolean } }
  | PaperEventBase & { type: "order_upserted"; data: { order: PendingOrder } }
  | PaperEventBase & { type: "order_cancelled"; data: { orderId: string; reason: string } }
  | PaperEventBase & { type: "fill"; data: { fill: FillRecord } }
  | PaperEventBase & { type: "fee"; data: { fillId: string; amount: number; asset: string } }
  | PaperEventBase & { type: "cash"; data: { amount: number; reason: "realized-pnl" | "legacy-balance-adjustment"; fillId?: string } }
  | PaperEventBase & { type: "position"; data: { position: PositionState | null } }
  | PaperEventBase & { type: "funding"; data: PaperFundingEvent }
  | PaperEventBase & { type: "settings"; data: { leverage: number; isolated: boolean; dualSide: boolean } }
  | PaperEventBase & { type: "command_completed"; data: PaperCommandResult };

type WithoutEventHeader<T> = T extends PaperEventBase ? Omit<T, keyof PaperEventBase> : never;
export type PaperLedgerEventDraft = WithoutEventHeader<PaperLedgerEvent>;

export interface PaperFundingEvent {
  settlementId: string;
  symbol: string;
  rate: number;
  markPrice: number;
  positionQty: number;
  amount: number;
  source: string;
  settledAt: number;
  verified: true;
}

export interface PaperCommandResult {
  commandId: string;
  requestHash: string;
  result: ExecResult;
}

export interface PaperLedgerState {
  initialized: boolean;
  balance: number;
  position: PositionState | null;
  orders: PendingOrder[];
  leverage: number;
  isolated: boolean;
  dualSide: boolean;
  feesPaid: number;
  fundingNet: number;
  fillCount: number;
  lastSequence: number;
}

export function stampPaperLedgerEvent(
  botId: string,
  ledgerEpoch: number,
  sequence: number,
  draft: PaperLedgerEventDraft,
  ts: number,
  id: string,
  idempotencyKey?: string
): PaperLedgerEvent {
  if (
    !botId.trim()
    || !Number.isSafeInteger(ledgerEpoch)
    || ledgerEpoch <= 0
    || !Number.isSafeInteger(sequence)
    || sequence <= 0
    || !Number.isSafeInteger(ts)
    || ts <= 0
    || !id.trim()
  ) {
    throw new Error("Invalid paper ledger event identity");
  }
  return {
    ...draft,
    id,
    botId,
    ledgerEpoch,
    sequence,
    ts,
    ...(idempotencyKey ? { idempotencyKey } : {})
  } as PaperLedgerEvent;
}

/** Deterministic recovery. Exact duplicate events are ignored; conflicting duplicates fail closed. */
export function replayPaperLedger(
  input: readonly PaperLedgerEvent[],
  expectedBotId?: string,
  expectedLedgerEpoch?: number
): PaperLedgerState {
  const byId = new Map<string, PaperLedgerEvent>();
  for (const event of input) {
    const prior = byId.get(event.id);
    if (prior) {
      if (stableStringify(prior) !== stableStringify(event)) throw new Error(`Conflicting paper event id ${event.id}`);
      continue;
    }
    byId.set(event.id, event);
  }
  const events = [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const state = emptyPaperLedgerState();
  const sequences = new Map<number, PaperLedgerEvent>();
  const idempotency = new Map<string, PaperLedgerEvent>();
  const accounting: ReplayAccounting = { fills: new Map(), fees: new Set(), cash: new Set() };
  const ledgerEpoch = expectedLedgerEpoch ?? events[0]?.ledgerEpoch;
  for (const event of events) {
    validateHeader(event, expectedBotId, ledgerEpoch);
    const atSequence = sequences.get(event.sequence);
    if (atSequence) throw new Error(`Conflicting paper event sequence ${event.sequence}`);
    sequences.set(event.sequence, event);
    if (event.idempotencyKey) {
      const prior = idempotency.get(event.idempotencyKey);
      if (prior && stableStringify(prior) !== stableStringify(event)) {
        throw new Error(`Conflicting paper idempotency key ${event.idempotencyKey}`);
      }
      idempotency.set(event.idempotencyKey, event);
    }
    if (event.sequence !== state.lastSequence + 1) {
      throw new Error(`Paper ledger gap: expected ${state.lastSequence + 1}, received ${event.sequence}`);
    }
    applyPaperEvent(state, event, accounting);
    state.lastSequence = event.sequence;
  }
  if (events.length > 0 && !state.initialized) throw new Error("Paper ledger has no account initialization event");
  for (const fill of accounting.fills.values()) {
    if (fill.fee > 0 && !accounting.fees.has(fill.id)) throw new Error(`Paper fill ${fill.id} has no fee event`);
    if (fill.kind === "close" && !accounting.cash.has(fill.id)) throw new Error(`Paper close fill ${fill.id} has no cash event`);
  }
  return state;
}

export function appendPaperEvents(
  current: readonly PaperLedgerEvent[],
  additions: readonly PaperLedgerEvent[],
  expectedBotId?: string,
  expectedLedgerEpoch?: number
): { events: PaperLedgerEvent[]; state: PaperLedgerState } {
  const events = [...current, ...additions];
  return {
    events: deduplicateExact(events),
    state: replayPaperLedger(events, expectedBotId, expectedLedgerEpoch)
  };
}

interface ReplayAccounting {
  fills: Map<string, FillRecord>;
  fees: Set<string>;
  cash: Set<string>;
}

function applyPaperEvent(state: PaperLedgerState, event: PaperLedgerEvent, accounting: ReplayAccounting): void {
  switch (event.type) {
    case "account_initialized":
      if (state.initialized || event.sequence !== 1) throw new Error("Paper account may only be initialized once at sequence 1");
      if (event.idempotencyKey !== "account-initialized") throw new Error("Paper account initialization identity is invalid");
      state.initialized = true;
      state.balance = nonNegative(event.data.balance, "initial balance");
      state.leverage = positive(event.data.leverage, "leverage");
      state.isolated = requiredBoolean(event.data.isolated, "isolated");
      state.dualSide = requiredBoolean(event.data.dualSide, "dualSide");
      return;
    case "order_upserted": {
      const order = structuredClone(event.data.order);
      validateOrder(order);
      const index = state.orders.findIndex((value) => value.id === order.id);
      if (index >= 0) state.orders[index] = order;
      else state.orders.push(order);
      return;
    }
    case "order_cancelled":
      state.orders = state.orders.filter((order) => order.id !== event.data.orderId);
      return;
    case "fill":
      validateFill(event.data.fill, event.botId);
      if (accounting.fills.has(event.data.fill.id)) throw new Error(`Duplicate paper fill ${event.data.fill.id}`);
      accounting.fills.set(event.data.fill.id, structuredClone(event.data.fill));
      state.fillCount += 1;
      return;
    case "fee": {
      const fill = accounting.fills.get(event.data.fillId);
      if (!fill) throw new Error(`Paper fee references unknown fill ${event.data.fillId}`);
      if (accounting.fees.has(fill.id)) throw new Error(`Duplicate paper fee for fill ${fill.id}`);
      const amount = nonNegative(event.data.amount, "fee");
      if (!moneyEqual(amount, fill.fee) || event.data.asset !== (fill.feeAsset ?? "USDT")) {
        throw new Error(`Paper fee does not match fill ${fill.id}`);
      }
      accounting.fees.add(fill.id);
      state.balance -= amount;
      state.feesPaid += event.data.amount;
      return;
    }
    case "cash": {
      const amount = requireFinite(event.data.amount, "cash amount");
      if (event.data.reason === "legacy-balance-adjustment") {
        if (event.sequence !== 2 || event.data.fillId) throw new Error("Legacy paper cash adjustment is not an initialization event");
      } else if (event.data.reason === "realized-pnl") {
        const fill = event.data.fillId ? accounting.fills.get(event.data.fillId) : undefined;
        if (!fill || fill.kind !== "close") throw new Error("Paper realized PnL references an unknown close fill");
        if (accounting.cash.has(fill.id)) throw new Error(`Duplicate paper cash event for fill ${fill.id}`);
        if (!moneyEqual(amount, round(fill.realizedPnl + fill.fee))) throw new Error(`Paper cash does not match fill ${fill.id}`);
        accounting.cash.add(fill.id);
      } else throw new Error("Unknown paper cash reason");
      state.balance += amount;
      return;
    }
    case "position":
      if (event.data.position) validatePosition(event.data.position);
      state.position = event.data.position ? structuredClone(event.data.position) : null;
      return;
    case "funding":
      validateFunding(event, state.position);
      state.balance += requireFinite(event.data.amount, "funding amount");
      state.fundingNet += event.data.amount;
      return;
    case "settings":
      state.leverage = positive(event.data.leverage, "leverage");
      state.isolated = requiredBoolean(event.data.isolated, "isolated");
      state.dualSide = requiredBoolean(event.data.dualSide, "dualSide");
      return;
    case "command_completed":
      validateCommandResult(event, accounting);
      return;
    default:
      throw new Error(`Unknown paper ledger event ${(event as { type?: unknown }).type}`);
  }
}

function validateCommandResult(
  event: Extract<PaperLedgerEvent, { type: "command_completed" }>,
  accounting: ReplayAccounting
): void {
  const { commandId, requestHash, result } = event.data;
  if (
    !commandId?.trim()
    || commandId.length > 200
    || !/^[0-9a-f]{64}$/.test(requestHash)
    || event.idempotencyKey !== commandResultKey(commandId)
    || !result
    || typeof result !== "object"
    || typeof result.ok !== "boolean"
    || !Array.isArray(result.fills)
  ) {
    throw new Error("Invalid paper command result");
  }
  for (const fill of result.fills) {
    validateFill(fill, event.botId);
    const recorded = accounting.fills.get(fill.id);
    if (!recorded || stableStringify(recorded) !== stableStringify(fill)) {
      throw new Error(`Paper command ${commandId} references an unrecorded fill ${fill.id}`);
    }
  }
  if (stableStringify(result).length > 64 * 1024) throw new Error("Paper command result is too large");
}

function validateFunding(event: Extract<PaperLedgerEvent, { type: "funding" }>, position: PositionState | null): void {
  const data = event.data;
  const eligible = position?.symbol === data.symbol && position.openedAt <= data.settledAt;
  const expectedQty = eligible ? position.qty : 0;
  const direction = eligible ? (position.side === "long" ? -1 : 1) : 0;
  const expectedAmount = round(direction * expectedQty * data.markPrice * data.rate);
  if (
    data.verified !== true
    || !data.settlementId?.trim()
    || !data.symbol?.trim()
    || !data.source?.trim()
    || !Number.isFinite(data.rate)
    || !Number.isFinite(data.markPrice)
    || data.markPrice <= 0
    || !Number.isFinite(data.positionQty)
    || data.positionQty < 0
    || !moneyEqual(data.positionQty, expectedQty)
    || !moneyEqual(data.amount, expectedAmount)
    || !Number.isFinite(data.settledAt)
    || data.settledAt <= 0
    || event.ts !== data.settledAt
    || event.idempotencyKey !== `funding:${data.settlementId}`
  ) throw new Error("Unverified paper funding event");
}

function emptyPaperLedgerState(): PaperLedgerState {
  return {
    initialized: false,
    balance: 0,
    position: null,
    orders: [],
    leverage: 1,
    isolated: false,
    dualSide: false,
    feesPaid: 0,
    fundingNet: 0,
    fillCount: 0,
    lastSequence: 0
  };
}

function validateHeader(
  event: PaperLedgerEvent,
  expectedBotId?: string,
  expectedLedgerEpoch?: number
): void {
  if (
    !event.id?.trim()
    || !event.botId?.trim()
    || !Number.isSafeInteger(event.ledgerEpoch)
    || event.ledgerEpoch <= 0
    || !Number.isSafeInteger(event.sequence)
    || event.sequence <= 0
    || !Number.isSafeInteger(event.ts)
    || event.ts <= 0
  ) {
    throw new Error("Invalid paper ledger event header");
  }
  if (expectedBotId && event.botId !== expectedBotId) throw new Error(`Paper event belongs to ${event.botId}, expected ${expectedBotId}`);
  if (expectedLedgerEpoch !== undefined && event.ledgerEpoch !== expectedLedgerEpoch) {
    throw new Error(`Paper event belongs to ledger epoch ${event.ledgerEpoch}, expected ${expectedLedgerEpoch}`);
  }
}

function validateOrder(order: PendingOrder): void {
  if (
    !order.id?.trim()
    || !order.symbol?.trim()
    || (order.side !== "buy" && order.side !== "sell")
    || !Number.isFinite(order.qty)
    || order.qty <= 0
    || !["market", "limit", "stop_market", "stop_limit", "tp_market", "tp_limit"].includes(order.type)
    || (order.price !== undefined && (!Number.isFinite(order.price) || order.price <= 0))
    || (order.trgPrice !== undefined && (!Number.isFinite(order.trgPrice) || order.trgPrice <= 0))
    || typeof order.reduceOnly !== "boolean"
    || !["GTC", "IOC", "FOK"].includes(order.tif)
    || !Number.isSafeInteger(order.createdAt)
    || order.createdAt <= 0
  ) throw new Error("Invalid paper order event");
}

function validatePosition(position: PositionState): void {
  if (
    !position.symbol?.trim()
    || (position.side !== "long" && position.side !== "short")
    || !Number.isFinite(position.qty)
    || position.qty <= 0
    || !Number.isFinite(position.entryPrice)
    || position.entryPrice <= 0
    || !Number.isFinite(position.leverage)
    || position.leverage <= 0
    || !Number.isSafeInteger(position.openedAt)
    || position.openedAt <= 0
  ) throw new Error("Invalid paper position event");
}

function validateFill(fill: FillRecord, botId: string): void {
  if (
    !fill.id?.trim()
    || fill.botId !== botId
    || !fill.symbol?.trim()
    || (fill.side !== "buy" && fill.side !== "sell")
    || !Number.isFinite(fill.qty)
    || fill.qty <= 0
    || !Number.isFinite(fill.price)
    || fill.price <= 0
    || !Number.isFinite(fill.fee)
    || fill.fee < 0
    || !Number.isFinite(fill.realizedPnl)
    || (fill.kind !== "open" && fill.kind !== "close")
    || !fill.reason?.trim()
    || !Number.isSafeInteger(fill.ts)
    || fill.ts <= 0
  ) throw new Error("Invalid paper fill event");
}

function deduplicateExact(events: PaperLedgerEvent[]): PaperLedgerEvent[] {
  const seen = new Map<string, PaperLedgerEvent>();
  for (const event of events) {
    const prior = seen.get(event.id);
    if (prior && stableStringify(prior) !== stableStringify(event)) throw new Error(`Conflicting paper event id ${event.id}`);
    if (!prior) seen.set(event.id, event);
  }
  return [...seen.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function requiredBoolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function moneyEqual(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-6;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function commandResultKey(commandId: string): string {
  return `command:${commandId}:result`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
