import type { Candle } from "../types";

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

export function correlationSeries(a: number[], b: number[], period: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = NaNArray(n);
  if (period < 2) return out;
  for (let i = period - 1; i < n; i += 1) {
    let sumA = 0;
    let sumB = 0;
    let valid = true;
    for (let j = 0; j < period; j += 1) {
      const av = a[i - j];
      const bv = b[i - j];
      if (!Number.isFinite(av) || !Number.isFinite(bv)) {
        valid = false;
        break;
      }
      sumA += av;
      sumB += bv;
    }
    if (!valid) continue;
    const meanA = sumA / period;
    const meanB = sumB / period;
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (let j = 0; j < period; j += 1) {
      const da = a[i - j] - meanA;
      const db = b[i - j] - meanB;
      cov += da * db;
      varA += da * da;
      varB += db * db;
    }
    const denom = Math.sqrt(varA * varB);
    out[i] = denom === 0 ? NaN : cov / denom;
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

/* ================= wave 3 indicator primitives =================
   Pure array functions over candles/series with Pine-accurate semantics.
   All output NaN until the indicator is warm (Pine `na`). This block is
   kept byte-identical between the frontend and backend copies of ta.ts. */

/** Wilder's RMA (alpha = 1/period), seeded by the SMA of the first `period`
 *  finite values. Local copy — the evaluators keep their own for `ma:rma`. */
function rmaSmooth(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  let seed = 0;
  let count = 0;
  let prev = NaN;
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      count += 1;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** ta.valuewhen: the value of `src` on the Nth most recent bar where `cond`
 *  was true (occurrence 0 = most recent). NaN until enough matches exist. */
export function valueWhen(cond: boolean[], src: number[], occurrence: number): number[] {
  const out = NaNArray(cond.length);
  const occ = Math.max(0, Math.round(occurrence));
  const matches: number[] = [];
  for (let i = 0; i < cond.length; i += 1) {
    if (cond[i]) matches.push(src[i]);
    out[i] = matches[matches.length - 1 - occ] ?? NaN;
  }
  return out;
}

/** ta.highestbars / ta.lowestbars: offset (0 or negative) to the extremum of
 *  `src` in the trailing window. Ties pick the most recent bar. */
export function extremeBars(kind: "highest" | "lowest", src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period - 1; i < src.length; i += 1) {
    let best = kind === "highest" ? -Infinity : Infinity;
    let bestIdx = -1;
    for (let j = i - period + 1; j <= i; j += 1) {
      const v = src[j];
      if (Number.isNaN(v)) continue;
      if (kind === "highest" ? v >= best : v <= best) {
        best = v;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) out[i] = -(i - bestIdx);
  }
  return out;
}

/** ta.linreg: least-squares line over the window (x = 0..period-1, oldest →
 *  newest), evaluated at x = period - 1 - offset. */
export function linregSeries(src: number[], period: number, offset: number): number[] {
  const out = NaNArray(src.length);
  const sumX = (period * (period - 1)) / 2;
  const sumX2 = ((period - 1) * period * (2 * period - 1)) / 6;
  const denom = period * sumX2 - sumX * sumX;
  for (let i = period - 1; i < src.length; i += 1) {
    let sumY = 0;
    let sumXY = 0;
    let bad = false;
    for (let j = 0; j < period; j += 1) {
      const y = src[i - period + 1 + j];
      if (Number.isNaN(y)) { bad = true; break; }
      sumY += y;
      sumXY += j * y;
    }
    if (bad) continue;
    const slope = denom === 0 ? 0 : (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1 - offset);
  }
  return out;
}

/** ta.vwap: session-anchored VWAP — cumulative Σ(hlc3·vol)/Σvol, reset when
 *  the UTC day changes. */
export function vwapSeries(candles: Candle[]): number[] {
  const out = NaNArray(candles.length);
  let cumPV = 0;
  let cumV = 0;
  let day = NaN;
  for (let i = 0; i < candles.length; i += 1) {
    const d = Math.floor(candles[i].time / 86400000);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
    }
    cumPV += priceAt(candles[i], "hlc3") * candles[i].volume;
    cumV += candles[i].volume;
    out[i] = cumV === 0 ? NaN : cumPV / cumV;
  }
  return out;
}

/** ta.supertrend: ATR bands around hl2 with ratcheting final bands.
 *  dir = -1 uptrend (value rides the lower band), +1 downtrend. */
export function supertrendSeries(candles: Candle[], factor: number, atrPeriod: number): { value: number[]; dir: number[] } {
  const n = candles.length;
  const value = NaNArray(n);
  const dir = NaNArray(n);
  const atrS = atr(candles, atrPeriod);
  let prevLower = NaN;
  let prevUpper = NaN;
  let prevSuper = NaN;
  for (let i = 0; i < n; i += 1) {
    const a = atrS[i];
    if (Number.isNaN(a)) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    let lower = mid - factor * a;
    let upper = mid + factor * a;
    const prevClose = i > 0 ? candles[i - 1].close : NaN;
    // Final-band carry: a band only ratchets while close hasn't broken it.
    if (!Number.isNaN(prevLower) && !(lower > prevLower || prevClose < prevLower)) lower = prevLower;
    if (!Number.isNaN(prevUpper) && !(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;
    let d: number;
    if (Number.isNaN(prevSuper)) d = 1;
    else if (prevSuper === prevUpper) d = candles[i].close > upper ? -1 : 1;
    else d = candles[i].close < lower ? 1 : -1;
    const st = d === -1 ? lower : upper;
    value[i] = st;
    dir[i] = d;
    prevLower = lower;
    prevUpper = upper;
    prevSuper = st;
  }
  return { value, dir };
}

/** ta.dmi: Wilder's directional movement — +DI / -DI over diLen, ADX = RMA of
 *  DX over adxLen. */
export function dmiSeries(candles: Candle[], diLen: number, adxLen: number): { plus: number[]; minus: number[]; adx: number[] } {
  const n = candles.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trur = atr(candles, diLen);
  const plusSm = rmaSmooth(plusDM, diLen);
  const minusSm = rmaSmooth(minusDM, diLen);
  const plus = NaNArray(n);
  const minus = NaNArray(n);
  const dx = NaNArray(n);
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(trur[i]) || Number.isNaN(plusSm[i]) || Number.isNaN(minusSm[i])) continue;
    plus[i] = trur[i] === 0 ? 0 : (100 * plusSm[i]) / trur[i];
    minus[i] = trur[i] === 0 ? 0 : (100 * minusSm[i]) / trur[i];
    const sum = plus[i] + minus[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plus[i] - minus[i])) / sum;
  }
  const adx = rmaSmooth(dx, adxLen);
  return { plus, minus, adx };
}

/** ta.mfi: money flow index over typical price (hlc3) and volume. */
export function mfiSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = NaNArray(n);
  const tp = sourceSeries(candles, "hlc3");
  const pos = new Array<number>(n).fill(0);
  const neg = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const flow = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) pos[i] = flow;
    else if (tp[i] < tp[i - 1]) neg[i] = flow;
  }
  for (let i = period; i < n; i += 1) {
    let up = 0;
    let down = 0;
    for (let j = 0; j < period; j += 1) {
      up += pos[i - j];
      down += neg[i - j];
    }
    if (down === 0) {
      if (up !== 0) out[i] = 100;
      continue;
    }
    out[i] = 100 - 100 / (1 + up / down);
  }
  return out;
}

/** ta.cmo: Chande momentum — 100·(Σup − Σdown)/(Σup + Σdown) of 1-bar momenta. */
export function cmoSeries(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period; i < src.length; i += 1) {
    let up = 0;
    let down = 0;
    let bad = false;
    for (let j = 0; j < period; j += 1) {
      const d = src[i - j] - src[i - j - 1];
      if (Number.isNaN(d)) { bad = true; break; }
      if (d > 0) up += d;
      else down -= d;
    }
    if (bad) continue;
    const total = up + down;
    out[i] = total === 0 ? 0 : (100 * (up - down)) / total;
  }
  return out;
}

/** ta.tsi: true strength index — double-EMA-smoothed 1-bar momentum ratio. */
export function tsiSeries(src: number[], shortLen: number, longLen: number): number[] {
  const n = src.length;
  const pc = NaNArray(n);
  const apc = NaNArray(n);
  for (let i = 1; i < n; i += 1) {
    pc[i] = src[i] - src[i - 1];
    apc[i] = Math.abs(pc[i]);
  }
  const num = ema(ema(pc, longLen), shortLen);
  const den = ema(ema(apc, longLen), shortLen);
  return num.map((v, i) =>
    Number.isNaN(v) || Number.isNaN(den[i]) || den[i] === 0 ? NaN : (100 * v) / den[i]
  );
}

/** ta.alma: Arnaud Legoux MA — gaussian window weights with
 *  m = offset·(period−1), s = period/sigma (j = 0 oldest … period−1 newest). */
export function almaSeries(src: number[], period: number, offset: number, sigma: number): number[] {
  const out = NaNArray(src.length);
  if (sigma <= 0) return out;
  const m = offset * (period - 1);
  const s = period / sigma;
  const weights: number[] = [];
  let norm = 0;
  for (let j = 0; j < period; j += 1) {
    const w = Math.exp(-((j - m) ** 2) / (2 * s * s));
    weights.push(w);
    norm += w;
  }
  for (let i = period - 1; i < src.length; i += 1) {
    let acc = 0;
    let bad = false;
    for (let j = 0; j < period; j += 1) {
      const v = src[i - period + 1 + j];
      if (Number.isNaN(v)) { bad = true; break; }
      acc += v * weights[j];
    }
    if (!bad) out[i] = acc / norm;
  }
  return out;
}

/** ta.cog: center of gravity — −Σ(src[i−j]·(j+1)) / Σ src[i−j], the most
 *  recent bar weighted 1. */
export function cogSeries(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period - 1; i < src.length; i += 1) {
    let num = 0;
    let den = 0;
    let bad = false;
    for (let j = 0; j < period; j += 1) {
      const v = src[i - j];
      if (Number.isNaN(v)) { bad = true; break; }
      num += v * (j + 1);
      den += v;
    }
    if (bad || den === 0) continue;
    out[i] = -num / den;
  }
  return out;
}

/** ta.percentrank: percent of the PREVIOUS `period` values (excluding the
 *  current bar) that are ≤ the current value, 0..100. */
export function percentRankSeries(src: number[], period: number): number[] {
  const out = NaNArray(src.length);
  for (let i = period; i < src.length; i += 1) {
    const cur = src[i];
    if (Number.isNaN(cur)) continue;
    let count = 0;
    let bad = false;
    for (let j = 1; j <= period; j += 1) {
      const v = src[i - j];
      if (Number.isNaN(v)) { bad = true; break; }
      if (v <= cur) count += 1;
    }
    if (!bad) out[i] = (100 * count) / period;
  }
  return out;
}

/** ta.sar: classic parabolic stop-and-reverse (ported from Pine's reference
 *  implementation, including the two-bar high/low clamp). */
export function sarSeries(candles: Candle[], start: number, inc: number, max: number): number[] {
  const n = candles.length;
  const out = NaNArray(n);
  if (n < 2) return out;
  let result = NaN;
  let maxMin = NaN;
  let acceleration = NaN;
  let isBelow = false;
  for (let i = 1; i < n; i += 1) {
    let isFirstTrendBar = false;
    if (i === 1) {
      if (candles[i].close > candles[i - 1].close) {
        isBelow = true;
        maxMin = candles[i].high;
        result = candles[i - 1].low;
      } else {
        isBelow = false;
        maxMin = candles[i].low;
        result = candles[i - 1].high;
      }
      isFirstTrendBar = true;
      acceleration = start;
    }
    result += acceleration * (maxMin - result);
    if (isBelow) {
      if (result > candles[i].low) {
        isFirstTrendBar = true;
        isBelow = false;
        result = Math.max(candles[i].high, maxMin);
        maxMin = candles[i].low;
        acceleration = start;
      }
    } else if (result < candles[i].high) {
      isFirstTrendBar = true;
      isBelow = true;
      result = Math.min(candles[i].low, maxMin);
      maxMin = candles[i].high;
      acceleration = start;
    }
    if (!isFirstTrendBar) {
      if (isBelow) {
        if (candles[i].high > maxMin) {
          maxMin = candles[i].high;
          acceleration = Math.min(acceleration + inc, max);
        }
      } else if (candles[i].low < maxMin) {
        maxMin = candles[i].low;
        acceleration = Math.min(acceleration + inc, max);
      }
    }
    if (isBelow) {
      result = Math.min(result, candles[i - 1].low);
      if (i > 1) result = Math.min(result, candles[i - 2].low);
    } else {
      result = Math.max(result, candles[i - 1].high);
      if (i > 1) result = Math.max(result, candles[i - 2].high);
    }
    out[i] = result;
  }
  return out;
}

/** ta.kc: Keltner channels — EMA(close) middle, bands ± mult·RMA(TR). */
export function kcSeries(candles: Candle[], period: number, mult: number): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = ema(sourceSeries(candles, "close"), period);
  const range = atr(candles, period);
  const upper = middle.map((m, i) => (Number.isNaN(m) || Number.isNaN(range[i]) ? NaN : m + mult * range[i]));
  const lower = middle.map((m, i) => (Number.isNaN(m) || Number.isNaN(range[i]) ? NaN : m - mult * range[i]));
  return { upper, middle, lower };
}
