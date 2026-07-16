import type { Candle } from "../types";

const DAY_MS = 86_400_000;

export interface LiquiditySweep {
  time: number;
  price: number;
  side: "high" | "low";
}

export interface SessionLiquiditySnapshot {
  dayStart: number;
  open: number;
  high: number;
  low: number;
  vwap?: number;
  upperBand?: number;
  lowerBand?: number;
  previousDayHigh?: number;
  previousDayLow?: number;
  sweeps: LiquiditySweep[];
}

/** UTC day boundary used by exchange daily candles and the chart session map. */
export function utcDayStart(time: number) {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

/**
 * Builds an intraday context without fabricating tick data. VWAP and deviation
 * use each bar's typical price weighted by its reported OHLCV volume.
 */
export function analyzeSessionLiquidity(candles: Candle[], dailyCandles: Candle[]): SessionLiquiditySnapshot | undefined {
  const latest = candles.at(-1);
  if (!latest) return undefined;
  const dayStart = utcDayStart(latest.time);
  let start = 0;
  let end = candles.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (candles[middle].time < dayStart) start = middle + 1;
    else end = middle;
  }
  if (start >= candles.length || utcDayStart(candles[start].time) !== dayStart) return undefined;

  let priorDaily: Candle | undefined;
  for (const candle of dailyCandles) {
    if (utcDayStart(candle.time) >= dayStart) continue;
    if (!priorDaily || candle.time > priorDaily.time) priorDaily = candle;
  }
  const weighted = weightedTypicalPrice(candles, start);
  const previousDayHigh = finitePositive(priorDaily?.high);
  const previousDayLow = finitePositive(priorDaily?.low);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (let index = start; index < candles.length; index += 1) {
    high = Math.max(high, candles[index].high);
    low = Math.min(low, candles[index].low);
  }

  return {
    dayStart,
    open: candles[start].open,
    high,
    low,
    vwap: weighted?.mean,
    upperBand: weighted ? weighted.mean + weighted.deviation : undefined,
    lowerBand: weighted ? weighted.mean - weighted.deviation : undefined,
    previousDayHigh,
    previousDayLow,
    sweeps: detectConfirmedSweeps(candles, start, previousDayHigh, previousDayLow)
  };
}

function weightedTypicalPrice(candles: Candle[], start: number) {
  let weight = 0;
  let weightedSum = 0;
  let weightedSquareSum = 0;
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!Number.isFinite(candle.volume) || candle.volume <= 0) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    if (!Number.isFinite(typical)) continue;
    weight += candle.volume;
    weightedSum += typical * candle.volume;
    weightedSquareSum += typical * typical * candle.volume;
  }
  if (weight <= 0) return undefined;
  const mean = weightedSum / weight;
  const variance = Math.max(0, weightedSquareSum / weight - mean * mean);
  return { mean, deviation: Math.sqrt(variance) };
}

function detectConfirmedSweeps(candles: Candle[], start: number, previousDayHigh?: number, previousDayLow?: number) {
  const sweeps: LiquiditySweep[] = [];
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    // The live tail is provisional unless the provider explicitly finalized it.
    if (candle.final === false || (index === candles.length - 1 && candle.final !== true)) continue;
    if (previousDayHigh !== undefined && candle.high > previousDayHigh && candle.close < previousDayHigh) {
      sweeps.push({ time: candle.time, price: candle.high, side: "high" });
    }
    if (previousDayLow !== undefined && candle.low < previousDayLow && candle.close > previousDayLow) {
      sweeps.push({ time: candle.time, price: candle.low, side: "low" });
    }
  }
  return sweeps;
}

function finitePositive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
