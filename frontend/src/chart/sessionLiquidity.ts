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
  const session = candles.filter((candle) => utcDayStart(candle.time) === dayStart);
  if (session.length === 0) return undefined;

  const priorDaily = [...dailyCandles]
    .filter((candle) => utcDayStart(candle.time) < dayStart)
    .sort((left, right) => right.time - left.time)[0];
  const weighted = weightedTypicalPrice(session);
  const previousDayHigh = finitePositive(priorDaily?.high);
  const previousDayLow = finitePositive(priorDaily?.low);

  return {
    dayStart,
    open: session[0].open,
    high: Math.max(...session.map((candle) => candle.high)),
    low: Math.min(...session.map((candle) => candle.low)),
    vwap: weighted?.mean,
    upperBand: weighted ? weighted.mean + weighted.deviation : undefined,
    lowerBand: weighted ? weighted.mean - weighted.deviation : undefined,
    previousDayHigh,
    previousDayLow,
    sweeps: detectConfirmedSweeps(session, previousDayHigh, previousDayLow)
  };
}

function weightedTypicalPrice(candles: Candle[]) {
  let weight = 0;
  let weightedSum = 0;
  let weightedSquareSum = 0;
  for (const candle of candles) {
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

function detectConfirmedSweeps(session: Candle[], previousDayHigh?: number, previousDayLow?: number) {
  const sweeps: LiquiditySweep[] = [];
  session.forEach((candle, index) => {
    // The live tail is provisional unless the provider explicitly finalized it.
    if (candle.final === false || (index === session.length - 1 && candle.final !== true)) return;
    if (previousDayHigh !== undefined && candle.high > previousDayHigh && candle.close < previousDayHigh) {
      sweeps.push({ time: candle.time, price: candle.high, side: "high" });
    }
    if (previousDayLow !== undefined && candle.low < previousDayLow && candle.close > previousDayLow) {
      sweeps.push({ time: candle.time, price: candle.low, side: "low" });
    }
  });
  return sweeps;
}

function finitePositive(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
