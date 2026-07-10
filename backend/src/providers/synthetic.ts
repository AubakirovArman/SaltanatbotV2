import type { Candle, Instrument, Timeframe } from "../types.js";
import { alignTime, timeframeMs } from "../market/timeframes.js";
import type { CandleRange, MarketProvider, MarketRouteOptions, MarketSubscription } from "./provider.js";

/**
 * Deterministic synthetic market.
 *
 * The closed-bar price path is a pure function of the bar index (fractal value
 * noise), so history is stable no matter how the client paginates into it — a
 * request for the same [startTime, endTime] window always returns identical
 * bars. Only the currently forming bar wiggles live around its deterministic
 * anchor close.
 */
export class SyntheticProvider implements MarketProvider {
  readonly name = "Synthetic realtime";

  private live = new Map<string, Candle>();

  async getCandles(instrument: Instrument, timeframe: Timeframe, range: CandleRange, _options?: MarketRouteOptions) {
    const tf = timeframeMs[timeframe];
    const nowBucket = alignTime(Date.now(), timeframe);
    const end = range.endTime !== undefined ? alignTime(range.endTime, timeframe) : nowBucket;
    const cappedEnd = Math.min(end, nowBucket);

    const bars: Candle[] = [];
    let time = cappedEnd;
    while (bars.length < range.limit && time >= 0) {
      if (range.startTime !== undefined && time < range.startTime) break;
      bars.push(this.closedBar(instrument, timeframe, time));
      time -= tf;
    }
    bars.reverse();

    // Overlay the live forming bar if it is inside the window.
    const liveBar = this.live.get(this.key(instrument, timeframe));
    if (liveBar && bars.length > 0 && bars[bars.length - 1].time === liveBar.time) {
      bars[bars.length - 1] = { ...liveBar };
    }
    return bars;
  }

  async subscribe(
    instrument: Instrument,
    timeframe: Timeframe,
    onCandle: (candle: Candle) => void,
    onStatus?: (message: string) => void,
    _options?: MarketRouteOptions
  ): Promise<MarketSubscription> {
    onStatus?.("Synthetic live stream active");
    const interval = setInterval(() => {
      onCandle(this.advance(instrument, timeframe));
    }, 1000);
    return { close: () => clearInterval(interval) };
  }

  /** Live forming-bar advance: random walk around the deterministic anchor. */
  private advance(instrument: Instrument, timeframe: Timeframe): Candle {
    const key = this.key(instrument, timeframe);
    const now = Date.now();
    const bucket = alignTime(now, timeframe);
    const anchor = this.closedBar(instrument, timeframe, bucket);
    let current = this.live.get(key);

    if (!current || current.time !== bucket) {
      current = { ...anchor, final: false };
    }

    const volatility = this.volatility(instrument) / 4;
    const jitter = this.noise(`${instrument.symbol}:tick`, now) * volatility;
    const close = Math.max(current.close * (1 + jitter), this.minPrice(instrument));
    const next: Candle = {
      time: bucket,
      open: current.open,
      high: Math.max(current.high, close),
      low: Math.min(current.low, close),
      close,
      volume: current.volume + this.volume(instrument, now) / 80,
      final: false,
      source: this.name
    };
    this.live.set(key, next);
    return { ...next };
  }

  /** Pure deterministic OHLCV for a closed bar at `time`. */
  private closedBar(instrument: Instrument, timeframe: Timeframe, time: number): Candle {
    const tf = timeframeMs[timeframe];
    const index = Math.floor(time / tf);
    const scale = this.volatility(instrument) * 26;
    const closePath = (i: number) => instrument.basePrice * Math.exp(this.walk(instrument.symbol, i) * scale);
    const open = closePath(index - 1);
    const close = closePath(index);
    const wick = Math.abs(this.noise(`${instrument.symbol}:wick`, time)) * this.volatility(instrument);
    return {
      time,
      open,
      high: Math.max(open, close) * (1 + wick),
      low: Math.min(open, close) * (1 - wick),
      close,
      volume: this.volume(instrument, time),
      final: true,
      source: this.name
    };
  }

  /** Fractal value-noise random walk — smooth, bounded, deterministic in `index`. */
  private walk(symbol: string, index: number): number {
    const layers = [
      { period: 512, amp: 1 },
      { period: 128, amp: 0.5 },
      { period: 32, amp: 0.25 },
      { period: 8, amp: 0.12 }
    ];
    let sum = 0;
    for (const layer of layers) {
      sum += this.valueNoise(`${symbol}:${layer.period}`, index / layer.period) * layer.amp;
    }
    return sum;
  }

  /** Continuous value noise: hashed lattice with smoothstep interpolation. */
  private valueNoise(seed: string, x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.hashUnit(seed, i);
    const b = this.hashUnit(seed, i + 1);
    const t = f * f * (3 - 2 * f);
    return (a + (b - a) * t) * 2 - 1;
  }

  private hashUnit(seed: string, value: number): number {
    let hash = 2166136261;
    const text = `${seed}:${value}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  private key(instrument: Instrument, timeframe: Timeframe) {
    return `${instrument.symbol}:${timeframe}`;
  }

  private volatility(instrument: Instrument) {
    if (instrument.assetClass === "forex") return 0.0007;
    if (instrument.assetClass === "index") return 0.0018;
    if (instrument.assetClass === "stock") return 0.0035;
    return 0.0045;
  }

  private minPrice(instrument: Instrument) {
    return instrument.basePrice * 0.05;
  }

  private volume(instrument: Instrument, time: number) {
    const base = instrument.assetClass === "crypto" ? 600 : 80_000;
    return base * (1 + Math.abs(this.noise(`${instrument.symbol}:volume`, time)) * 5);
  }

  private noise(seed: string, value: number) {
    return this.hashUnit(`${seed}:${Math.floor(value / 1000)}`, 0) * 2 - 1;
  }
}
