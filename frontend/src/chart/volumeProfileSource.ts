import type { Candle } from "../types";

export const VOLUME_PROFILE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type VolumeProfileTimeframe = (typeof VOLUME_PROFILE_TIMEFRAMES)[number];
export type VolumeProfileSource = "chart" | VolumeProfileTimeframe;
export type VolumeProfileSourceIssue = "fallback" | "incomplete" | "no-data" | "range-too-wide" | "request";

export interface VisibleTimeRange {
  startTime: number;
  endTime: number;
}

export interface VolumeProfileCandlePage {
  candles: Candle[];
  provider: string;
  hasMore?: boolean;
}

export class VolumeProfileSourceError extends Error {
  constructor(readonly code: Exclude<VolumeProfileSourceIssue, "request">, message: string) {
    super(message);
    this.name = "VolumeProfileSourceError";
  }
}

const TIMEFRAME_MS: Record<VolumeProfileTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000
};

/** Independent profiles refresh completed bars at source cadence and evolving bars at least every five minutes. */
export function volumeProfileRefreshIntervalMs(timeframe: VolumeProfileTimeframe): number {
  return Math.min(TIMEFRAME_MS[timeframe], 5 * 60_000);
}

export function normalizeVolumeProfileSource(value: unknown): VolumeProfileSource {
  if (value === "chart") return value;
  return VOLUME_PROFILE_TIMEFRAMES.some((timeframe) => timeframe === value) ? value as VolumeProfileTimeframe : "chart";
}

/** Return only source bars whose real time span overlaps the visible chart span. */
export function candlesIntersectingRange(
  candles: readonly Candle[],
  range: VisibleTimeRange,
  timeframe: VolumeProfileTimeframe
): Candle[] {
  const duration = TIMEFRAME_MS[timeframe];
  if (!validRange(range)) return [];
  return candles
    .filter((candle) => Number.isFinite(candle.time) && candle.time < range.endTime && candle.time + duration > range.startTime)
    .sort((left, right) => left.time - right.time);
}

export function visibleCandleTimeRange(
  candles: readonly Candle[],
  start: number,
  end: number,
  barTimeMs: number
): VisibleTimeRange | undefined {
  const first = candles[Math.max(0, start)];
  const last = candles[Math.max(0, Math.min(candles.length, end) - 1)];
  if (!first || !last || !Number.isFinite(barTimeMs) || barTimeMs <= 0) return undefined;
  return { startTime: first.time, endTime: last.time + barTimeMs };
}

export async function loadRealVolumeProfileCandles(input: {
  timeframe: VolumeProfileTimeframe;
  range: VisibleTimeRange;
  signal: AbortSignal;
  fetchPage: (endTime: number, limit: number, signal: AbortSignal) => Promise<VolumeProfileCandlePage>;
  pageSize?: number;
  maxCandles?: number;
  /** Observation boundary for a visible chart bar that is still forming. Defaults to wall-clock now. */
  observedAt?: number;
}): Promise<Candle[]> {
  const pageSize = Math.max(10, Math.min(1_000, Math.trunc(input.pageSize ?? 1_000)));
  const maxCandles = Math.max(pageSize, Math.min(12_000, Math.trunc(input.maxCandles ?? 12_000)));
  if (!validRange(input.range)) throw new VolumeProfileSourceError("no-data", "Visible time range is invalid");
  const expected = Math.ceil((input.range.endTime - input.range.startTime) / TIMEFRAME_MS[input.timeframe]) + 2;
  if (expected > maxCandles) {
    throw new VolumeProfileSourceError("range-too-wide", `Visible range needs about ${expected} ${input.timeframe} candles`);
  }

  const unique = new Map<number, Candle>();
  let cursor = Math.ceil(input.range.endTime) - 1;
  let earliest = Number.POSITIVE_INFINITY;
  while (unique.size < maxCandles && earliest > input.range.startTime) {
    throwIfAborted(input.signal);
    const page = await input.fetchPage(cursor, Math.min(pageSize, maxCandles - unique.size), input.signal);
    assertRealPage(page);
    if (page.candles.length === 0) break;
    for (const candle of page.candles) unique.set(candle.time, candle);
    const nextEarliest = Math.min(...page.candles.map((candle) => candle.time));
    if (!Number.isFinite(nextEarliest) || nextEarliest >= earliest || nextEarliest > cursor) break;
    earliest = nextEarliest;
    cursor = earliest - 1;
    if (earliest > input.range.startTime && page.hasMore === false) break;
  }

  if (unique.size === 0) throw new VolumeProfileSourceError("no-data", "No source candles were returned");
  if (earliest > input.range.startTime) {
    throw new VolumeProfileSourceError("incomplete", "Source candles do not cover the visible range");
  }
  const filtered = candlesIntersectingRange([...unique.values()], input.range, input.timeframe);
  if (filtered.length === 0) throw new VolumeProfileSourceError("no-data", "No source candles intersect the visible range");
  const duration = TIMEFRAME_MS[input.timeframe];
  const observedAt = input.observedAt ?? Date.now();
  if (!Number.isFinite(observedAt)) throw new VolumeProfileSourceError("no-data", "Observation time is invalid");
  const coverageEnd = Math.min(input.range.endTime, observedAt);
  if (coverageEnd <= input.range.startTime) throw new VolumeProfileSourceError("no-data", "Visible range has no observable source span");
  const first = filtered[0]!;
  const last = filtered.at(-1)!;
  if (first.time > input.range.startTime || first.time + duration <= input.range.startTime || last.time + duration < coverageEnd) {
    throw new VolumeProfileSourceError("incomplete", "Source candles do not cover both visible-range boundaries");
  }
  for (let index = 1; index < filtered.length; index += 1) {
    if (filtered[index]!.time > filtered[index - 1]!.time + duration) {
      throw new VolumeProfileSourceError("incomplete", "Source candles contain a gap inside the visible range");
    }
  }
  return filtered;
}

function assertRealPage(page: VolumeProfileCandlePage) {
  const sourceNames = [page.provider, ...page.candles.map((candle) => candle.source ?? "")];
  if (sourceNames.some((source) => !isExplicitRealSource(source))) {
    throw new VolumeProfileSourceError("fallback", "A candle page was not explicitly sourced from Binance or Bybit");
  }
}

function isExplicitRealSource(value: string) {
  const source = value.trim().toLowerCase();
  return (source.includes("binance") || source.includes("bybit")) && !source.includes("fallback") && !source.includes("synthetic");
}

function validRange(range: VisibleTimeRange) {
  return Number.isFinite(range.startTime) && Number.isFinite(range.endTime) && range.endTime > range.startTime;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
