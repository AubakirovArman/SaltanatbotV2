import type { ArbitrageDepthResponse } from "./client";
import { closePaperPositionWithDepth, loadPaperPositions, migrateLegacyPaperPosition, type ArbitragePaperPosition } from "./paper";
import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

const KEY = "sbv2:arbitrage-paper:v2";
const CORRUPT_KEY = "sbv2:arbitrage-paper:v2:corrupt";
const MAX_EVENTS = 5_000;
const MAX_POSITIONS = 100;
const MAX_BYTES = 2 * 1024 * 1024;

interface EventBase {
  id: string;
  sequence: number;
  recordedAt: number;
}

export interface PaperPositionOpenedEvent extends EventBase {
  type: "position_opened";
  position: ArbitragePaperPosition;
}

export interface PaperFundingEvent extends EventBase {
  type: "funding_recorded";
  positionId: string;
  settlementTime: number;
  rate: number;
  referencePrice: number;
  quantity: number;
  cashFlowUsd: number;
  source: "manual-confirmed";
}

export interface PaperPositionClosedEvent extends EventBase {
  type: "position_closed";
  positionId: string;
  valuation: "depth-vwap" | "legacy-snapshot";
  closedAt: number;
  realizedPnlUsd: number;
  spotExit?: number;
  futuresExit?: number;
  exitCapturedAt?: number;
}

export interface PaperPositionArchivedEvent extends EventBase {
  type: "position_archived";
  positionId: string;
}

export type ArbitragePaperEvent = PaperPositionOpenedEvent | PaperFundingEvent | PaperPositionClosedEvent | PaperPositionArchivedEvent;

export function createOpenEvent(position: ArbitragePaperPosition, events: readonly ArbitragePaperEvent[], id = eventId()): PaperPositionOpenedEvent {
  if (replayPaperEvents(events).length >= MAX_POSITIONS) throw new Error("Paper ledger position limit reached");
  return { id, sequence: nextSequence(events), recordedAt: position.openedAt, type: "position_opened", position: { ...position, fundingPnlUsd: 0 } };
}

export function createCloseEvent(position: ArbitragePaperPosition, depth: ArbitrageDepthResponse, events: readonly ArbitragePaperEvent[], now = Date.now(), id = eventId()): PaperPositionClosedEvent {
  const closed = closePaperPositionWithDepth(position, depth, now);
  return {
    id,
    sequence: nextSequence(events),
    recordedAt: now,
    type: "position_closed",
    positionId: position.id,
    valuation: "depth-vwap",
    closedAt: now,
    realizedPnlUsd: closed.realizedPnlUsd ?? 0,
    spotExit: closed.spotExit,
    futuresExit: closed.futuresExit,
    exitCapturedAt: closed.exitCapturedAt
  };
}

export function createFundingEvent(position: ArbitragePaperPosition, input: { settlementTime: number; rate: number; referencePrice: number; source: PaperFundingEvent["source"] }, events: readonly ArbitragePaperEvent[], now = Date.now(), id = eventId()): PaperFundingEvent {
  if (position.closedAt) throw new Error("Cannot record funding after a paper position is closed");
  if (!Number.isFinite(input.rate) || !positive(input.referencePrice) || !positive(input.settlementTime) || input.settlementTime < position.openedAt || input.settlementTime > now) {
    throw new Error("Funding event has invalid or future settlement data");
  }
  if (events.some((event) => event.type === "funding_recorded" && event.positionId === position.id && event.settlementTime === input.settlementTime)) {
    throw new Error("Funding settlement was already recorded");
  }
  const cashFlowUsd = position.futuresQuantity * input.referencePrice * input.rate;
  return {
    id,
    sequence: nextSequence(events),
    recordedAt: now,
    type: "funding_recorded",
    positionId: position.id,
    settlementTime: input.settlementTime,
    rate: input.rate,
    referencePrice: input.referencePrice,
    quantity: position.futuresQuantity,
    cashFlowUsd,
    source: input.source
  };
}

export function createArchiveEvents(positions: readonly ArbitragePaperPosition[], events: readonly ArbitragePaperEvent[], now = Date.now()): ArbitragePaperEvent[] {
  let sequence = nextSequence(events);
  return positions.filter((position) => position.closedAt !== undefined).map((position) => ({ id: eventId(), sequence: sequence++, recordedAt: now, type: "position_archived" as const, positionId: position.id }));
}

export function appendPaperEvents(events: readonly ArbitragePaperEvent[], ...next: readonly ArbitragePaperEvent[]): ArbitragePaperEvent[] {
  const combined = [...events, ...next];
  if (combined.length > MAX_EVENTS) throw new Error("Paper ledger event limit reached");
  replayPaperEvents(combined);
  return combined;
}

/** Deterministic reducer. Invalid order, duplicates or tampered cash flows fail the entire replay. */
export function replayPaperEvents(events: readonly ArbitragePaperEvent[]): ArbitragePaperPosition[] {
  if (events.length > MAX_EVENTS) throw new Error("Paper ledger contains too many events");
  const ids = new Set<string>();
  const positions = new Map<string, ArbitragePaperPosition>();
  const archived = new Set<string>();
  const settlements = new Set<string>();
  events.forEach((event, index) => {
    validateBase(event, index + 1);
    if (ids.has(event.id)) throw new Error("Paper ledger event ID is duplicated");
    ids.add(event.id);
    if (event.type === "position_opened") {
      const position = validatePosition(event.position);
      if (positions.has(position.id)) throw new Error("Paper position was opened twice");
      positions.set(position.id, { ...position, fundingPnlUsd: 0, closedAt: undefined, realizedPnlUsd: undefined });
      return;
    }
    const position = positions.get(event.positionId);
    if (!position) throw new Error("Paper ledger event references an unknown position");
    if (event.type === "funding_recorded") {
      if (position.closedAt) throw new Error("Funding event follows paper close");
      validateFunding(event, position);
      const settlementKey = `${position.id}:${event.settlementTime}`;
      if (settlements.has(settlementKey)) throw new Error("Paper funding settlement is duplicated");
      settlements.add(settlementKey);
      position.fundingPnlUsd += event.cashFlowUsd;
      position.lastFundingSettlementTime = event.settlementTime;
      return;
    }
    if (event.type === "position_closed") {
      if (position.closedAt) throw new Error("Paper position was closed twice");
      validateClose(event, position);
      Object.assign(position, {
        closedAt: event.closedAt,
        realizedPnlUsd: event.realizedPnlUsd,
        ...(event.spotExit === undefined ? {} : { spotExit: event.spotExit }),
        ...(event.futuresExit === undefined ? {} : { futuresExit: event.futuresExit }),
        ...(event.exitCapturedAt === undefined ? {} : { exitCapturedAt: event.exitCapturedAt })
      });
      return;
    }
    if (!position.closedAt) throw new Error("Open paper position cannot be archived");
    if (archived.has(position.id)) throw new Error("Paper position was archived twice");
    archived.add(position.id);
  });
  if (positions.size > MAX_POSITIONS) throw new Error("Paper ledger contains too many positions");
  return [...positions.values()].filter((position) => !archived.has(position.id)).sort((left, right) => right.openedAt - left.openedAt || left.id.localeCompare(right.id));
}

export function loadPaperEvents(ownerId?: string): ArbitragePaperEvent[] {
  const raw = readTenantLocalItem(localStorage, KEY, ownerId);
  if (!raw) return migrateLegacyLedger(ownerId);
  try {
    const envelope = JSON.parse(raw) as { schemaVersion?: unknown; events?: unknown };
    if ((envelope.schemaVersion !== 2 && envelope.schemaVersion !== 3) || !Array.isArray(envelope.events)) throw new Error("Unsupported paper ledger schema");
    const events = envelope.schemaVersion === 2 ? migrateV2Events(envelope.events) : (envelope.events as ArbitragePaperEvent[]);
    replayPaperEvents(events);
    if (envelope.schemaVersion === 2) storePaperEvents(events, ownerId);
    return events;
  } catch {
    try {
      writeTenantLocalItem(localStorage, CORRUPT_KEY, raw.slice(0, MAX_BYTES), ownerId);
    } catch {
      /* Preserve the original key when backup storage is unavailable. */
    }
    return [];
  }
}

export function storePaperEvents(events: readonly ArbitragePaperEvent[], ownerId?: string) {
  replayPaperEvents(events);
  const value = JSON.stringify({ schemaVersion: 3, events });
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES) throw new Error("Paper ledger storage limit reached");
  writeTenantLocalItem(localStorage, KEY, value, ownerId);
}

function migrateV2Events(values: unknown[]): ArbitragePaperEvent[] {
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value as ArbitragePaperEvent;
    const event = value as ArbitragePaperEvent;
    if (event.type !== "position_opened" || !event.position || typeof event.position !== "object") return event;
    return { ...event, position: migrateLegacyPaperPosition(event.position) };
  });
}

function migrateLegacyLedger(ownerId?: string): ArbitragePaperEvent[] {
  const legacy = loadPaperPositions(ownerId).slice(0, MAX_POSITIONS);
  const events: ArbitragePaperEvent[] = [];
  for (const position of legacy.sort((left, right) => left.openedAt - right.openedAt || left.id.localeCompare(right.id))) {
    const open = { ...position, fundingPnlUsd: position.fundingPnlUsd ?? 0, closedAt: undefined, realizedPnlUsd: undefined };
    events.push({ id: `migration-open:${position.id}`, sequence: events.length + 1, recordedAt: position.openedAt, type: "position_opened", position: open });
    if (position.closedAt !== undefined && position.realizedPnlUsd !== undefined) {
      events.push({
        id: `migration-close:${position.id}`,
        sequence: events.length + 1,
        recordedAt: position.closedAt,
        type: "position_closed",
        positionId: position.id,
        valuation: "legacy-snapshot",
        closedAt: position.closedAt,
        realizedPnlUsd: position.realizedPnlUsd
      });
    }
  }
  if (events.length > 0) storePaperEvents(events, ownerId);
  return events;
}

function validateBase(event: ArbitragePaperEvent, sequence: number) {
  if (!event || typeof event !== "object" || !identifier(event.id) || event.sequence !== sequence || !positive(event.recordedAt)) {
    throw new Error("Paper ledger event envelope is invalid or out of order");
  }
}

function validatePosition(value: ArbitragePaperPosition) {
  if (
    !value ||
    typeof value !== "object" ||
    !identifier(value.id) ||
    !identifier(value.routeId) ||
    !symbol(value.symbol) ||
    !exchange(value.spotExchange) ||
    !exchange(value.futuresExchange) ||
    !positive(value.notionalUsd) ||
    !positive(value.matchedQuantity) ||
    !positive(value.spotQuantity) ||
    !positive(value.futuresQuantity) ||
    !positive(value.quantityStep) ||
    !positive(value.spotEntry) ||
    !positive(value.futuresEntry) ||
    !positive(value.openedAt) ||
    !nonNegative(value.estimatedRoundTripCostUsd) ||
    !finite(value.fundingPnlUsd) ||
    !validPaperRouteIdentity(value)
  )
    throw new Error("Paper open event contains an invalid position");
  return { ...value };
}

function validateFunding(event: PaperFundingEvent, position: ArbitragePaperPosition) {
  if (!positive(event.settlementTime) || event.settlementTime < position.openedAt || event.settlementTime > event.recordedAt || !finite(event.rate) || !positive(event.referencePrice) || !positive(event.quantity) || !finite(event.cashFlowUsd)) {
    throw new Error("Paper funding event is invalid");
  }
  const expected = event.quantity * event.referencePrice * event.rate;
  if (Math.abs(event.quantity - position.futuresQuantity) > tolerance(position.futuresQuantity) || Math.abs(event.cashFlowUsd - expected) > tolerance(expected)) {
    throw new Error("Paper funding cash flow does not match its provenance");
  }
}

function validateClose(event: PaperPositionClosedEvent, position: ArbitragePaperPosition) {
  if (!positive(event.closedAt) || event.closedAt < position.openedAt || !finite(event.realizedPnlUsd)) throw new Error("Paper close event is invalid");
  if (event.valuation === "legacy-snapshot") return;
  if (!positive(event.spotExit) || !positive(event.futuresExit) || !positive(event.exitCapturedAt)) throw new Error("Depth-valued paper close lacks exit provenance");
  const expected = position.spotQuantity * (event.spotExit - position.spotEntry) + position.futuresQuantity * (position.futuresEntry - event.futuresExit) - position.estimatedRoundTripCostUsd + position.fundingPnlUsd;
  if (Math.abs(event.realizedPnlUsd - expected) > tolerance(expected)) throw new Error("Paper close PnL does not match event provenance");
}

function nextSequence(events: readonly ArbitragePaperEvent[]) {
  return events.length + 1;
}

function eventId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 220;
}
function symbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{2,30}$/.test(value);
}
function exchange(value: unknown): value is "binance" | "bybit" {
  return value === "binance" || value === "bybit";
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}
function tolerance(value: number) {
  return Math.max(1e-9, Math.abs(value) * 1e-9);
}

function validPaperRouteIdentity(position: ArbitragePaperPosition) {
  if (position.spotInstrumentId !== `${position.spotExchange}:spot:${position.symbol}` || position.futuresInstrumentId !== `${position.futuresExchange}:perpetual:${position.symbol}`) return false;
  if (position.spotExchange === position.futuresExchange) return position.identityScope === "venue-native" && position.assetId.startsWith(`${position.spotExchange}:`);
  return position.identityScope === "cross-venue-reviewed" && position.economicAssetId === position.assetId && (position.assetId === "crypto:bitcoin" || position.assetId === "crypto:ethereum");
}
