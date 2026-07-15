import type { JsonValue } from "./types.js";

export type HistoricalDepthLevel = readonly [price: number, nativeQuantity: number];

export interface HistoricalDepthPayload {
  bids: HistoricalDepthLevel[];
  asks: HistoricalDepthLevel[];
}

export function parseHistoricalDepthSnapshot(value: JsonValue, instrumentId: string): HistoricalDepthPayload {
  const row = record(value, `depth snapshot ${instrumentId}`);
  const bids = depthLevels(row.bids, "bids", instrumentId);
  const asks = depthLevels(row.asks, "asks", instrumentId);
  if (bids[0]![0] >= asks[0]![0]) throw new Error(`depth snapshot ${instrumentId} is crossed or locked`);
  return { bids, asks };
}

function depthLevels(value: JsonValue | undefined, side: "bids" | "asks", instrumentId: string): HistoricalDepthLevel[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`depth snapshot ${instrumentId} ${side} must be non-empty`);
  const result: HistoricalDepthLevel[] = [];
  let previousPrice: number | undefined;
  for (const [index, raw] of value.entries()) {
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`depth snapshot ${instrumentId} ${side}[${index}] is invalid`);
    const price = positive(raw[0], `${side}[${index}].price`);
    const nativeQuantity = positive(raw[1], `${side}[${index}].nativeQuantity`);
    if (previousPrice !== undefined && (side === "bids" ? price >= previousPrice : price <= previousPrice)) {
      throw new Error(`depth snapshot ${instrumentId} ${side} is unsorted or contains duplicate prices`);
    }
    result.push([price, nativeQuantity]);
    previousPrice = price;
  }
  return result;
}

function record(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function positive(value: JsonValue | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}
