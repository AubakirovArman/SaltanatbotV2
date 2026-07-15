import type { ReplayDataset, ReplayEvent } from "./types.js";
import { HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE, replayBookProof } from "./engineManifest.js";
import { parseHistoricalDepthSnapshot, type HistoricalDepthPayload } from "./historicalDepth.js";

export interface ReplayInstrumentBinding {
  instrumentId: string;
  venue?: string;
  symbol?: string;
  marketType?: string;
  economicAssetId?: string;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional?: number;
}

export interface RecordedDepthBook extends HistoricalDepthPayload {
  instrumentId: string;
  sourceId: string;
  sequence: number;
  exchangeTs: number;
  receivedAt: number;
}

export interface RecordedSpreadBook extends Omit<RecordedDepthBook, "bids" | "asks"> {
  bids: Array<readonly [price: number, quantity: number]>;
  asks: Array<readonly [price: number, quantity: number]>;
}

export function recordedDepthBooks(events: ReadonlyMap<string, ReplayEvent>): Map<string, RecordedDepthBook> {
  const output = new Map<string, RecordedDepthBook>();
  for (const [instrumentId, event] of events) {
    const depth = parseHistoricalDepthSnapshot(event.payload, instrumentId);
    const proof = replayBookProof(event, instrumentId);
    if (depth.bids.length > HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE || depth.asks.length > HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE) {
      throw new Error(`depth snapshot ${instrumentId} exceeds ${HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE} levels per side`);
    }
    output.set(instrumentId, {
      instrumentId,
      sourceId: event.sourceId,
      sequence: proof.bookSequence,
      exchangeTs: event.exchangeTs,
      receivedAt: event.receivedAt,
      bids: depth.bids,
      asks: depth.asks
    });
  }
  return output;
}

/** Native spread prices may be negative; quantities and ordering remain strict. */
export function recordedSpreadBook(event: ReplayEvent, instrumentId: string): RecordedSpreadBook {
  const payload = record(event.payload, instrumentId);
  const proof = replayBookProof(event, instrumentId);
  const bids = signedLevels(payload.bids, "bids", instrumentId);
  const asks = signedLevels(payload.asks, "asks", instrumentId);
  if (bids[0]![0] >= asks[0]![0]) throw new Error(`spread snapshot ${instrumentId} is crossed or locked`);
  return { instrumentId, sourceId: event.sourceId, sequence: proof.bookSequence, exchangeTs: event.exchangeTs, receivedAt: event.receivedAt, bids, asks };
}

export function assertReplayInstrumentBindings(dataset: ReplayDataset, evaluatedAt: number, bindings: readonly ReplayInstrumentBinding[]): void {
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.instrumentId)) throw new Error(`duplicate replay instrument binding ${binding.instrumentId}`);
    ids.add(binding.instrumentId);
    const state = instrumentStateAt(dataset, binding.instrumentId, evaluatedAt);
    if (!state.active || !state.listing || !state.constraints) throw new Error(`instrument ${binding.instrumentId} has no active point-in-time metadata`);
    compareOptionalString(state.listing.venue, binding.venue, binding.instrumentId, "venue");
    compareOptionalString(state.listing.symbol, binding.symbol, binding.instrumentId, "symbol");
    compareOptionalString(state.listing.marketType, binding.marketType, binding.instrumentId, "marketType");
    compareOptionalString(state.listing.economicAssetId, binding.economicAssetId, binding.instrumentId, "economicAssetId");
    sameNumber(state.constraints.quantityStep, binding.quantityStep, binding.instrumentId, "quantityStep");
    sameNumber(state.constraints.minimumQuantity, binding.minimumQuantity, binding.instrumentId, "minimumQuantity");
    if (binding.minimumNotional !== undefined) sameNumber(state.constraints.minimumNotional, binding.minimumNotional, binding.instrumentId, "minimumNotional");
  }
}

interface InstrumentState {
  active: boolean;
  listing?: Record<string, unknown>;
  constraints?: { quantityStep: number; minimumQuantity: number; minimumNotional: number };
}

function instrumentStateAt(dataset: ReplayDataset, instrumentId: string, evaluatedAt: number): InstrumentState {
  const state: InstrumentState = { active: false };
  for (const event of dataset.events) {
    if (event.receivedAt > evaluatedAt) break;
    if (event.instrumentId !== instrumentId) continue;
    if (event.eventType === "instrument-listed") {
      const payload = record(event.payload, instrumentId);
      state.active = true;
      state.listing = payload;
      state.constraints = constraints(payload, instrumentId);
    } else if (event.eventType === "instrument-constraints-updated") {
      if (!state.active) throw new Error(`instrument ${instrumentId} constraints changed while inactive`);
      state.constraints = constraints(record(event.payload, instrumentId), instrumentId);
    } else if (event.eventType === "instrument-delisted") {
      state.active = false;
      state.listing = undefined;
      state.constraints = undefined;
    }
  }
  return state;
}

function record(value: unknown, instrumentId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`instrument ${instrumentId} metadata payload is invalid`);
  return value as Record<string, unknown>;
}

function constraints(value: Record<string, unknown>, instrumentId: string) {
  return {
    quantityStep: positive(value.quantityStep, instrumentId, "quantityStep"),
    minimumQuantity: positive(value.minimumQuantity, instrumentId, "minimumQuantity"),
    minimumNotional: positive(value.minimumNotional, instrumentId, "minimumNotional")
  };
}

function positive(value: unknown, instrumentId: string, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`instrument ${instrumentId} ${field} is invalid`);
  return value;
}

function signedLevels(value: unknown, side: "bids" | "asks", instrumentId: string): Array<readonly [number, number]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE) {
    throw new Error(`spread snapshot ${instrumentId} ${side} has an invalid level count`);
  }
  let previous: number | undefined;
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`spread snapshot ${instrumentId} ${side}[${index}] is invalid`);
    const price = raw[0];
    const quantity = raw[1];
    if (typeof price !== "number" || !Number.isFinite(price)) throw new Error(`spread snapshot ${instrumentId} ${side}[${index}] price is invalid`);
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) throw new Error(`spread snapshot ${instrumentId} ${side}[${index}] quantity is invalid`);
    if (previous !== undefined && (side === "bids" ? price >= previous : price <= previous)) throw new Error(`spread snapshot ${instrumentId} ${side} is unsorted`);
    previous = price;
    return [price, quantity] as const;
  });
}

function sameNumber(actual: number, expected: number, instrumentId: string, field: string) {
  if (!Number.isFinite(expected) || actual !== expected) throw new Error(`instrument ${instrumentId} ${field} does not match point-in-time registry metadata`);
}

function compareOptionalString(actual: unknown, expected: string | undefined, instrumentId: string, field: string) {
  if (expected === undefined) return;
  if (typeof actual !== "string" || actual !== expected) throw new Error(`instrument ${instrumentId} ${field} does not match point-in-time registry metadata`);
}
