import { sha256 } from "./canonical.js";
import type { JsonValue, ReplayDataset } from "./types.js";

export interface HistoricalFundingSettlementProvenance {
  settlementId: string;
  settledAt: number;
  receivedAt: number;
  sourceId: string;
  sequence: number;
  eventDigest: `sha256:${string}`;
}

export interface HistoricalFundingSettlement extends HistoricalFundingSettlementProvenance {
  instrumentId: string;
  rate: number;
  referencePrice: number;
}

export function buildHistoricalFundingTimeline(dataset: ReplayDataset, derivativeInstrumentIds: Iterable<string>) {
  const instruments = new Set(derivativeInstrumentIds);
  const candidates: HistoricalFundingSettlement[] = [];
  let rejected = 0;
  for (const event of dataset.events) {
    if (event.eventType !== "funding-settlement" || !event.instrumentId || !instruments.has(event.instrumentId)) continue;
    const payload = record(event.payload, "funding payload");
    if (payload.verified !== true) {
      rejected += 1;
      continue;
    }
    if (payload.settlementAt !== undefined) {
      const declaredSettlementAt = timestamp(payload.settlementAt, "funding settlementAt");
      if (declaredSettlementAt !== event.exchangeTs) throw new Error("funding settlementAt must equal the event exchangeTs");
    }
    candidates.push({
      instrumentId: event.instrumentId,
      settlementId: text(payload.settlementId, "funding settlementId"),
      settledAt: event.exchangeTs,
      receivedAt: event.receivedAt,
      sourceId: event.sourceId,
      sequence: event.sequence,
      eventDigest: sha256(event as unknown as JsonValue),
      rate: finite(payload.rate, "funding rate"),
      referencePrice: positive(payload.referencePrice, "funding referencePrice")
    });
  }
  candidates.sort(compareFundingSettlement);
  const byInstrument = new Map<string, HistoricalFundingSettlement[]>();
  const bySettlementId = new Map<string, HistoricalFundingSettlement>();
  let duplicates = 0;
  for (const candidate of candidates) {
    const key = `${candidate.instrumentId}\u0000${candidate.settlementId}`;
    const previous = bySettlementId.get(key);
    if (previous) {
      if (previous.settledAt !== candidate.settledAt || previous.rate !== candidate.rate || previous.referencePrice !== candidate.referencePrice) {
        throw new Error(`conflicting funding settlement ${candidate.settlementId} for ${candidate.instrumentId}`);
      }
      duplicates += 1;
      continue;
    }
    bySettlementId.set(key, candidate);
    const values = byInstrument.get(candidate.instrumentId) ?? [];
    values.push(candidate);
    byInstrument.set(candidate.instrumentId, values);
  }
  return { byInstrument, rejected, duplicates };
}

export function fundingSettlementsWithin(timeline: HistoricalFundingSettlement[], openedAt: number, closedAt: number) {
  // Funding accounts for an actual venue settlement, not an information signal.
  // Ownership is [open, close): a close-then-reopen at the same replay event
  // assigns the boundary settlement to the new position exactly once.
  return timeline.filter((settlement) => settlement.settledAt >= openedAt && settlement.settledAt < closedAt);
}

function compareFundingSettlement(left: HistoricalFundingSettlement, right: HistoricalFundingSettlement) {
  return left.settledAt - right.settledAt || left.sourceId.localeCompare(right.sourceId) || left.sequence - right.sequence || left.receivedAt - right.receivedAt;
}

function record(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value: JsonValue | undefined, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finite(value: JsonValue | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positive(value: JsonValue | undefined, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function timestamp(value: JsonValue | undefined, label: string) {
  const result = finite(value, label);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`);
  return result;
}
