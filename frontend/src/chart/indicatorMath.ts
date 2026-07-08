import type { Candle } from "../types";
import type { BollingerPoint, MacdPoint, SeriesPoint } from "./indicatorTypes";

export function sma(candles: Candle[], period: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let sum = 0;
  candles.forEach((candle, index) => {
    sum += candle.close;
    if (index >= period) sum -= candles[index - period].close;
    points.push({
      time: candle.time,
      value: index >= period - 1 ? sum / period : undefined
    });
  });
  return points;
}

export function ema(candles: Candle[], period: number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | undefined;
  candles.forEach((candle, index) => {
    previous = previous === undefined ? candle.close : candle.close * multiplier + previous * (1 - multiplier);
    points.push({ time: candle.time, value: index >= period - 1 ? previous : undefined });
  });
  return points;
}

export function bollinger(candles: Candle[], period: number, deviation: number): BollingerPoint[] {
  return candles.map((candle, index) => {
    if (index < period - 1) return { time: candle.time };
    const window = candles.slice(index - period + 1, index + 1);
    const mean = window.reduce((sum, item) => sum + item.close, 0) / period;
    const variance = window.reduce((sum, item) => sum + (item.close - mean) ** 2, 0) / period;
    const band = Math.sqrt(variance) * deviation;
    return {
      time: candle.time,
      middle: mean,
      upper: mean + band,
      lower: mean - band
    };
  });
}

export function rsi(candles: Candle[], period: number): SeriesPoint[] {
  let avgGain = 0;
  let avgLoss = 0;
  return candles.map((candle, index) => {
    if (index === 0) return { time: candle.time };
    const change = candle.close - candles[index - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      return { time: candle.time, value: index === period ? valueFromAverages(avgGain, avgLoss) : undefined };
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    return { time: candle.time, value: valueFromAverages(avgGain, avgLoss) };
  });
}

export function macd(candles: Candle[], fast: number, slow: number, signal: number): MacdPoint[] {
  const fastEma = ema(candles, fast);
  const slowEma = ema(candles, slow);
  const macdSeries = candles.map((candle, index) => ({
    time: candle.time,
    value:
      fastEma[index].value !== undefined && slowEma[index].value !== undefined
        ? fastEma[index].value! - slowEma[index].value!
        : undefined
  }));
  const signalInput = macdSeries.map((point) => ({
    time: point.time,
    open: point.value ?? 0,
    high: point.value ?? 0,
    low: point.value ?? 0,
    close: point.value ?? 0,
    volume: 0
  }));
  const signalSeries = ema(signalInput, signal);
  return macdSeries.map((point, index) => {
    const signalValue = point.value === undefined ? undefined : signalSeries[index].value;
    return {
      time: point.time,
      macd: point.value,
      signal: signalValue,
      histogram: point.value !== undefined && signalValue !== undefined ? point.value - signalValue : undefined
    };
  });
}

function valueFromAverages(avgGain: number, avgLoss: number) {
  if (avgLoss === 0) return 100;
  const relative = avgGain / avgLoss;
  return 100 - 100 / (1 + relative);
}
