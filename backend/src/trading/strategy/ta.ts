import type { Candle } from "../../types.js";

export type PriceField = "open" | "high" | "low" | "close" | "volume" | "hl2" | "hlc3" | "ohlc4";

const NaNArray = (n: number) => new Array<number>(n).fill(NaN);

/** One candle's value for a price field (incl. the hl2/hlc3/ohlc4 composites). */
export function priceAt(candle: Candle, field: PriceField): number {
  switch (field) {
    case "open": return candle.open;
    case "high": return candle.high;
    case "low": return candle.low;
    case "volume": return candle.volume;
    case "hl2": return (candle.high + candle.low) / 2;
    case "hlc3": return (candle.high + candle.low + candle.close) / 3;
    case "ohlc4": return (candle.open + candle.high + candle.low + candle.close) / 4;
    case "close":
    default: return candle.close;
  }
}

export function sourceSeries(candles: Candle[], field: PriceField): number[] {
  return candles.map((candle) => priceAt(candle, field));
}

export function sma(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < src.length; i += 1) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  if (period < 1) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < src.length; i += 1) {
    prev = Number.isNaN(prev) ? src[i] : src[i] * k + prev * (1 - k);
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

export function wma(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < src.length; i += 1) {
    let acc = 0;
    for (let j = 0; j < period; j += 1) acc += src[i - j] * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

export function vwma(src: number[], volume: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period - 1; i < src.length; i += 1) {
    let pv = 0;
    let vol = 0;
    for (let j = 0; j < period; j += 1) {
      pv += src[i - j] * volume[i - j];
      vol += volume[i - j];
    }
    out[i] = vol === 0 ? NaN : pv / vol;
  }
  return out;
}

export function stdev(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  const means = sma(src, period);
  for (let i = period - 1; i < src.length; i += 1) {
    let acc = 0;
    for (let j = 0; j < period; j += 1) acc += (src[i - j] - means[i]) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

export function rsi(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < src.length; i += 1) {
    const change = src[i] - src[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = rsiFromAverages(avgGain, avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = rsiFromAverages(avgGain, avgLoss);
    }
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function atr(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const tr = NaNArray(n);
  for (let i = 0; i < n; i += 1) {
    if (i === 0) {
      tr[i] = candles[i].high - candles[i].low;
    } else {
      const prevClose = candles[i - 1].close;
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
    }
  }
  // Wilder's smoothing.
  const out = NaNArray(n);
  let prev = NaN;
  for (let i = 0; i < n; i += 1) {
    if (i < period) {
      if (i === period - 1) {
        let sum = 0;
        for (let j = 0; j < period; j += 1) sum += tr[j];
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function highest(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period - 1; i < src.length; i += 1) {
    let max = -Infinity;
    for (let j = 0; j < period; j += 1) max = Math.max(max, src[i - j]);
    out[i] = max;
  }
  return out;
}

export function lowest(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period - 1; i < src.length; i += 1) {
    let min = Infinity;
    for (let j = 0; j < period; j += 1) min = Math.min(min, src[i - j]);
    out[i] = min;
  }
  return out;
}

export function change(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period; i < src.length; i += 1) out[i] = src[i] - src[i - period];
  return out;
}

export function bollingerBand(
  src: number[],
  period: number,
  dev: number,
  band: "upper" | "middle" | "lower"
): number[] {
  const mid = sma(src, period);
  if (band === "middle") return mid;
  const sd = stdev(src, period);
  return mid.map((m, i) => (Number.isNaN(m) ? NaN : band === "upper" ? m + sd[i] * dev : m - sd[i] * dev));
}

/** Stochastic %K: position of close inside the [lowest low, highest high] window. */
export function stochK(candles: Candle[], period: number): number[] {
  const highs = highest(candles.map((c) => c.high), period);
  const lows = lowest(candles.map((c) => c.low), period);
  return candles.map((candle, i) => {
    if (Number.isNaN(highs[i]) || Number.isNaN(lows[i])) return NaN;
    const span = highs[i] - lows[i];
    return span === 0 ? 50 : ((candle.close - lows[i]) / span) * 100;
  });
}

export function williamsR(candles: Candle[], period: number): number[] {
  const highs = highest(candles.map((c) => c.high), period);
  const lows = lowest(candles.map((c) => c.low), period);
  return candles.map((candle, i) => {
    if (Number.isNaN(highs[i]) || Number.isNaN(lows[i])) return NaN;
    const span = highs[i] - lows[i];
    return span === 0 ? -50 : (-100 * (highs[i] - candle.close)) / span;
  });
}

export function cci(candles: Candle[], period: number): number[] {
  const tp = sourceSeries(candles, "hlc3");
  const mean = sma(tp, period);
  return tp.map((value, i) => {
    if (Number.isNaN(mean[i])) return NaN;
    let dev = 0;
    for (let j = 0; j < period; j += 1) dev += Math.abs(tp[i - j] - mean[i]);
    dev /= period;
    return dev === 0 ? 0 : (value - mean[i]) / (0.015 * dev);
  });
}

/** Rate of change, percent: (src / src[n bars ago] - 1) * 100. */
export function roc(src: number[], period: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = period; i < src.length; i += 1) {
    if (src[i - period] !== 0) out[i] = (src[i] / src[i - period] - 1) * 100;
  }
  return out;
}

export function macdLine(
  src: number[],
  fast: number,
  slow: number,
  signal: number,
  line: "macd" | "signal" | "histogram"
): number[] {
  const fastEma = ema(src, fast);
  const slowEma = ema(src, slow);
  const macd = src.map((_, i) =>
    Number.isNaN(fastEma[i]) || Number.isNaN(slowEma[i]) ? NaN : fastEma[i] - slowEma[i]
  );
  if (line === "macd") return macd;
  const clean = macd.map((v) => (Number.isNaN(v) ? 0 : v));
  const signalSeries = ema(clean, signal).map((v, i) => (Number.isNaN(macd[i]) ? NaN : v));
  if (line === "signal") return signalSeries;
  return macd.map((v, i) => (Number.isNaN(v) || Number.isNaN(signalSeries[i]) ? NaN : v - signalSeries[i]));
}
