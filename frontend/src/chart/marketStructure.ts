import type { Candle } from "../types";
import { confirmedCandleCount } from "./confirmedCandles";

export { confirmedCandleCount } from "./confirmedCandles";

export type StructureDirection = "bullish" | "bearish";
export type SwingLabel = "H" | "L" | "HH" | "LH" | "HL" | "LL";

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
  label: SwingLabel;
  confirmedAt: number;
  confirmationIndex: number;
}

export interface StructureBreak {
  time: number;
  price: number;
  direction: StructureDirection;
  kind: "bos" | "choch";
  sourceTime: number;
}

export interface FairValueGap {
  id: string;
  direction: StructureDirection;
  createdTime: number;
  top: number;
  bottom: number;
  mitigatedAt?: number;
}

export interface MarketStructureSettings {
  showStructure: boolean;
  showFvg: boolean;
  swingStrength: number;
}

export interface MarketStructureSnapshot {
  swings: SwingPoint[];
  breaks: StructureBreak[];
  fairValueGaps: FairValueGap[];
  trend: StructureDirection | "neutral";
  lastConfirmedTime?: number;
  settings: MarketStructureSettings;
}

export const DEFAULT_MARKET_STRUCTURE_SETTINGS: MarketStructureSettings = { showStructure: true, showFvg: false, swingStrength: 3 };

export function analyzeMarketStructure(candles: Candle[], settings: MarketStructureSettings): MarketStructureSnapshot {
  const normalized = { ...settings, swingStrength: Math.max(2, Math.min(8, Math.round(settings.swingStrength))) };
  const closedEnd = confirmedCandleCount(candles);
  const closed = candles.slice(0, closedEnd);
  const swings = normalized.showStructure ? detectConfirmedSwings(closed, normalized.swingStrength) : [];
  const structure = normalized.showStructure ? detectStructureBreaks(closed, swings) : { breaks: [], trend: "neutral" as const };
  const fairValueGaps = normalized.showFvg ? detectFairValueGaps(closed) : [];
  return {
    swings,
    breaks: structure.breaks,
    fairValueGaps,
    trend: structure.trend,
    lastConfirmedTime: closed.at(-1)?.time,
    settings: normalized
  };
}

function detectConfirmedSwings(candles: Candle[], strength: number) {
  const swings: SwingPoint[] = [];
  let previousHigh: number | undefined;
  let previousLow: number | undefined;
  for (let index = strength; index + strength < candles.length; index += 1) {
    const candidate = candles[index];
    let high = true;
    let low = true;
    for (let offset = 1; offset <= strength; offset += 1) {
      high &&= candidate.high > candles[index - offset].high && candidate.high > candles[index + offset].high;
      low &&= candidate.low < candles[index - offset].low && candidate.low < candles[index + offset].low;
    }
    const confirmationIndex = index + strength;
    const confirmedAt = candles[confirmationIndex].time;
    if (high) {
      swings.push({ index, time: candidate.time, price: candidate.high, kind: "high", label: previousHigh === undefined ? "H" : candidate.high > previousHigh ? "HH" : "LH", confirmedAt, confirmationIndex });
      previousHigh = candidate.high;
    }
    if (low) {
      swings.push({ index, time: candidate.time, price: candidate.low, kind: "low", label: previousLow === undefined ? "L" : candidate.low > previousLow ? "HL" : "LL", confirmedAt, confirmationIndex });
      previousLow = candidate.low;
    }
  }
  return swings.sort((left, right) => left.confirmationIndex - right.confirmationIndex || left.index - right.index || left.kind.localeCompare(right.kind));
}

function detectStructureBreaks(candles: Candle[], swings: SwingPoint[]) {
  const breaks: StructureBreak[] = [];
  let trend: MarketStructureSnapshot["trend"] = "neutral";
  let high: SwingPoint | undefined;
  let low: SwingPoint | undefined;
  let highBroken = true;
  let lowBroken = true;
  let swingIndex = 0;
  for (let index = 0; index < candles.length; index += 1) {
    while (swings[swingIndex]?.confirmationIndex === index) {
      const swing = swings[swingIndex++];
      if (swing.kind === "high") {
        high = swing;
        highBroken = false;
      } else {
        low = swing;
        lowBroken = false;
      }
    }
    const candle = candles[index];
    if (high && !highBroken && candle.close > high.price) {
      breaks.push({ time: candle.time, price: high.price, direction: "bullish", kind: trend === "bearish" ? "choch" : "bos", sourceTime: high.time });
      trend = "bullish";
      highBroken = true;
    } else if (low && !lowBroken && candle.close < low.price) {
      breaks.push({ time: candle.time, price: low.price, direction: "bearish", kind: trend === "bullish" ? "choch" : "bos", sourceTime: low.time });
      trend = "bearish";
      lowBroken = true;
    }
  }
  return { breaks, trend };
}

function detectFairValueGaps(candles: Candle[]) {
  const gaps: FairValueGap[] = [];
  for (let index = 2; index < candles.length; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];
    let gap: FairValueGap | undefined;
    if (third.low > first.high) {
      gap = { id: `bullish:${third.time}`, direction: "bullish", createdTime: third.time, top: third.low, bottom: first.high };
    } else if (third.high < first.low) {
      gap = { id: `bearish:${third.time}`, direction: "bearish", createdTime: third.time, top: first.low, bottom: third.high };
    }
    if (!gap) continue;
    for (let later = index + 1; later < candles.length; later += 1) {
      const candle = candles[later];
      const mitigated = gap.direction === "bullish" ? candle.low <= gap.bottom : candle.high >= gap.top;
      if (mitigated) {
        gap.mitigatedAt = candle.time;
        break;
      }
    }
    gaps.push(gap);
  }
  return gaps;
}
