import type { Candle } from "../types";
import type { BollingerPoint, MacdPoint, SeriesPoint, StochasticPoint } from "./indicatorTypes";

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

/** Rolling VWAP over a window: sum(typical·volume) / sum(volume) across `period` bars. */
export function vwap(candles: Candle[], period: number): SeriesPoint[] {
  let pvSum = 0;
  let volSum = 0;
  const typical = (candle: Candle) => (candle.high + candle.low + candle.close) / 3;
  return candles.map((candle, index) => {
    pvSum += typical(candle) * candle.volume;
    volSum += candle.volume;
    if (index >= period) {
      const old = candles[index - period];
      pvSum -= typical(old) * old.volume;
      volSum -= old.volume;
    }
    if (index < period - 1) return { time: candle.time };
    return { time: candle.time, value: volSum === 0 ? candle.close : pvSum / volSum };
  });
}

/** Average True Range with Wilder's smoothing (mirrors backend ta.atr). */
export function atr(candles: Candle[], period: number): SeriesPoint[] {
  const tr = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const prevClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
  });
  const points: SeriesPoint[] = candles.map((candle) => ({ time: candle.time }));
  let prev = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i < period) {
      if (i === period - 1) {
        let sum = 0;
        for (let j = 0; j < period; j += 1) sum += tr[j];
        prev = sum / period;
        points[i] = { time: candles[i].time, value: prev };
      }
      continue;
    }
    prev = (prev * (period - 1) + tr[i]) / period;
    points[i] = { time: candles[i].time, value: prev };
  }
  return points;
}

/**
 * Stochastic oscillator: %K = position of close in the [lowest low, highest high]
 * window, then %D is an SMA of %K over `smooth` bars.
 */
export function stochastic(candles: Candle[], period: number, smooth: number): StochasticPoint[] {
  const rawK = candles.map((candle, index) => {
    if (index < period - 1) return undefined;
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = index - period + 1; j <= index; j += 1) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }
    const span = highest - lowest;
    return span === 0 ? 50 : ((candle.close - lowest) / span) * 100;
  });
  return candles.map((candle, index) => {
    const k = rawK[index];
    let d: number | undefined;
    if (index >= period - 2 + smooth) {
      let sum = 0;
      let count = 0;
      for (let j = index - smooth + 1; j <= index; j += 1) {
        const value = rawK[j];
        if (value === undefined) { count = -1; break; }
        sum += value;
        count += 1;
      }
      if (count === smooth) d = sum / smooth;
    }
    return { time: candle.time, k, d };
  });
}

/** On-Balance Volume: cumulative volume, signed by the close-to-close direction. */
export function obv(candles: Candle[]): SeriesPoint[] {
  let running = 0;
  return candles.map((candle, index) => {
    if (index === 0) {
      running = 0;
      return { time: candle.time, value: 0 };
    }
    const prevClose = candles[index - 1].close;
    if (candle.close > prevClose) running += candle.volume;
    else if (candle.close < prevClose) running -= candle.volume;
    return { time: candle.time, value: running };
  });
}

function valueFromAverages(avgGain: number, avgLoss: number) {
  if (avgLoss === 0) return 100;
  const relative = avgGain / avgLoss;
  return 100 - 100 / (1 + relative);
}
