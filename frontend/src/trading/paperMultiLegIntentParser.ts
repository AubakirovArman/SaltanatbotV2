import type {
  PaperMultiLegIntentLeg,
  PaperMultiLegIntentRow,
  PaperMultiLegResidualExposureLine,
  PaperMultiLegSection
} from "./paperPortfolioTypes";

type JsonRecord = Record<string, unknown>;

/**
 * Additive multi-leg intent metadata is rendered leniently: malformed fields
 * and rows are dropped instead of failing the whole portfolio snapshot, so
 * older and newer server payload shapes both stay renderable. Absent values
 * are never rendered as zero, and netPnl may legitimately be negative. This
 * parser is the canonical definition of the browser-shaped field names the
 * server read-model mirrors exactly.
 */
export function lenientPaperMultiLegSection(value: unknown): PaperMultiLegSection | undefined {
  const item = record(value);
  if (!item) return undefined;
  const section: PaperMultiLegSection = { intents: lenientIntents(item.intents) };
  if (typeof item.killSwitchEnabled === "boolean") section.killSwitchEnabled = item.killSwitchEnabled;
  return section;
}

function lenientIntents(value: unknown): PaperMultiLegIntentRow[] {
  if (!Array.isArray(value)) return [];
  const rows: PaperMultiLegIntentRow[] = [];
  for (const entry of value) {
    const row = lenientIntent(entry);
    if (row) rows.push(row);
  }
  return rows;
}

function lenientIntent(value: unknown): PaperMultiLegIntentRow | undefined {
  const item = record(value);
  if (!item) return undefined;
  const intentId = lenientText(item.intentId);
  if (!intentId) return undefined;
  const row: PaperMultiLegIntentRow = { intentId, legs: lenientLegs(item.legs) };
  const status = lenientText(item.status);
  if (status) row.status = status;
  const outcome = lenientText(item.outcome);
  if (outcome) row.outcome = outcome;
  const sourceEngine = lenientText(item.sourceEngine);
  if (sourceEngine) row.sourceEngine = sourceEngine;
  const sourceOpportunityId = lenientText(item.sourceOpportunityId);
  if (sourceOpportunityId) row.sourceOpportunityId = sourceOpportunityId;
  const legCount = lenientCount(item.legCount);
  if (legCount !== undefined) row.legCount = legCount;
  const reservedCapital = lenientNonNegativeAmount(item.reservedCapital);
  if (reservedCapital !== undefined) row.reservedCapital = reservedCapital;
  const netPnl = lenientSignedAmount(item.netPnl);
  if (netPnl !== undefined) row.netPnl = netPnl;
  const fees = lenientNonNegativeAmount(item.fees);
  if (fees !== undefined) row.fees = fees;
  const createdAt = lenientCount(item.createdAt);
  if (createdAt !== undefined) row.createdAt = createdAt;
  const residualExposure = lenientResidualExposure(item.residualExposure);
  if (residualExposure.length > 0) row.residualExposure = residualExposure;
  return row;
}

function lenientLegs(value: unknown): PaperMultiLegIntentLeg[] {
  if (!Array.isArray(value)) return [];
  const legs: PaperMultiLegIntentLeg[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item) continue;
    const leg: PaperMultiLegIntentLeg = {};
    const venue = lenientText(item.venue);
    if (venue) leg.venue = venue;
    const instrumentId = lenientText(item.instrumentId);
    if (instrumentId) leg.instrumentId = instrumentId;
    if (item.side === "buy" || item.side === "sell") leg.side = item.side;
    const plannedQuantity = lenientNonNegativeAmount(item.plannedQuantity);
    if (plannedQuantity !== undefined) leg.plannedQuantity = plannedQuantity;
    const filledQuantity = lenientNonNegativeAmount(item.filledQuantity);
    if (filledQuantity !== undefined) leg.filledQuantity = filledQuantity;
    const averagePrice = lenientNonNegativeAmount(item.averagePrice);
    if (averagePrice !== undefined) leg.averagePrice = averagePrice;
    const fee = lenientNonNegativeAmount(item.fee);
    if (fee !== undefined) leg.fee = fee;
    if (typeof item.compensated === "boolean") leg.compensated = item.compensated;
    legs.push(leg);
  }
  return legs;
}

function lenientResidualExposure(value: unknown): PaperMultiLegResidualExposureLine[] {
  if (!Array.isArray(value)) return [];
  const lines: PaperMultiLegResidualExposureLine[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item) continue;
    const instrumentId = lenientText(item.instrumentId);
    const quantity = typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : undefined;
    if (!instrumentId || quantity === undefined) continue;
    const line: PaperMultiLegResidualExposureLine = { instrumentId, quantity };
    const quantityUnit = lenientText(item.quantityUnit);
    if (quantityUnit) line.quantityUnit = quantityUnit;
    const legId = lenientText(item.legId);
    if (legId) line.legId = legId;
    lines.push(line);
  }
  return lines;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function lenientText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lenientCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function lenientNonNegativeAmount(value: unknown): number | undefined {
  const amount = lenientSignedAmount(value);
  return amount !== undefined && amount >= 0 ? amount : undefined;
}

function lenientSignedAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)\.\d{6}$/.test(value)) return Number(value);
  return undefined;
}
