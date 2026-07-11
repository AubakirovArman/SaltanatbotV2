/** Canonical transport-neutral market contracts shared by browser and server. */

export type AssetClass = "crypto" | "forex" | "stock" | "index";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1M";
export type ChartType = "candles" | "heikin" | "bars" | "line" | "area" | "baseline" | "renko";
export type DataExchange = "binance" | "bybit";

export interface Instrument {
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  provider: "binance" | "synthetic";
  /** Positive reference quote used only for a clearly labelled synthetic fallback. */
  basePrice: number;
  decimals: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  final?: boolean;
  source?: string;
}

export interface CatalogResponse {
  instruments: Instrument[];
  timeframes: Timeframe[];
  chartTypes: ChartType[];
}

export interface CandlesResponse {
  instrument: Instrument;
  candles: Candle[];
  provider: string;
  hasMore?: boolean;
}

export interface SparklineSeries {
  last: number | null;
  changePct: number;
  points: number[];
}

export interface SparklinesResponse {
  timeframe: Timeframe;
  series: Record<string, SparklineSeries | null>;
}

export type MarketStatus = "connected" | "fallback" | "error";

export interface StreamStatus {
  type: "status";
  status: MarketStatus;
  provider: string;
  message: string;
  ts: number;
}

export interface SnapshotMessage {
  type: "snapshot";
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  provider: string;
  ts: number;
}

export interface CandleMessage {
  type: "candle";
  symbol: string;
  timeframe: Timeframe;
  candle: Candle;
  provider: string;
  ts: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  ts: number;
}

export type StreamMessage = StreamStatus | SnapshotMessage | CandleMessage | ErrorMessage;

const timeframes = new Set<Timeframe>(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"]);
const chartTypes = new Set<ChartType>(["candles", "heikin", "bars", "line", "area", "baseline", "renko"]);
const assetClasses = new Set<AssetClass>(["crypto", "forex", "stock", "index"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function booleanOptional(value: unknown, label: string) {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be boolean when present`);
  return value as boolean | undefined;
}

export function parseCandle(value: unknown, label = "candle"): Candle {
  const input = record(value, label);
  const candle: Candle = {
    time: finite(input.time, `${label}.time`),
    open: finite(input.open, `${label}.open`),
    high: finite(input.high, `${label}.high`),
    low: finite(input.low, `${label}.low`),
    close: finite(input.close, `${label}.close`),
    volume: finite(input.volume, `${label}.volume`),
  };
  if (candle.time < 0) throw new Error(`${label}.time must be non-negative`);
  if (candle.open <= 0 || candle.high <= 0 || candle.low < 0 || candle.close <= 0) {
    throw new Error(`${label} prices must be positive (low may be zero)`);
  }
  if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) {
    throw new Error(`${label} OHLC range is inconsistent`);
  }
  if (candle.volume < 0) throw new Error(`${label}.volume must be non-negative`);
  const final = booleanOptional(input.final, `${label}.final`);
  if (final !== undefined) candle.final = final;
  if (input.source !== undefined) candle.source = string(input.source, `${label}.source`);
  return candle;
}

export function parseInstrument(value: unknown, label = "instrument"): Instrument {
  const input = record(value, label);
  const assetClass = string(input.assetClass, `${label}.assetClass`);
  const provider = string(input.provider, `${label}.provider`);
  if (!assetClasses.has(assetClass as AssetClass)) throw new Error(`${label}.assetClass is unsupported`);
  if (provider !== "binance" && provider !== "synthetic") throw new Error(`${label}.provider is unsupported`);
  const basePrice = finite(input.basePrice, `${label}.basePrice`);
  const decimals = finite(input.decimals, `${label}.decimals`);
  if (basePrice < 0) throw new Error(`${label}.basePrice must be non-negative`);
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new Error(`${label}.decimals must be a non-negative integer`);
  return {
    symbol: string(input.symbol, `${label}.symbol`),
    displayName: string(input.displayName, `${label}.displayName`),
    assetClass: assetClass as AssetClass,
    exchange: string(input.exchange, `${label}.exchange`),
    currency: string(input.currency, `${label}.currency`),
    provider,
    basePrice,
    decimals,
  };
}

function parseTimeframe(value: unknown, label: string): Timeframe {
  if (typeof value !== "string" || !timeframes.has(value as Timeframe)) throw new Error(`${label} is unsupported`);
  return value as Timeframe;
}

export function parseCatalogResponse(value: unknown): CatalogResponse {
  const input = record(value, "catalog response");
  if (!Array.isArray(input.instruments) || !Array.isArray(input.timeframes) || !Array.isArray(input.chartTypes)) {
    throw new Error("catalog response arrays are missing");
  }
  return {
    instruments: input.instruments.map((item, index) => parseInstrument(item, `instruments[${index}]`)),
    timeframes: input.timeframes.map((item, index) => parseTimeframe(item, `timeframes[${index}]`)),
    chartTypes: input.chartTypes.map((item, index) => {
      if (typeof item !== "string" || !chartTypes.has(item as ChartType)) throw new Error(`chartTypes[${index}] is unsupported`);
      return item as ChartType;
    }),
  };
}

export function parseCandlesResponse(value: unknown): CandlesResponse {
  const input = record(value, "candles response");
  if (!Array.isArray(input.candles)) throw new Error("candles response.candles must be an array");
  return {
    instrument: parseInstrument(input.instrument),
    candles: input.candles.map((item, index) => parseCandle(item, `candles[${index}]`)),
    provider: string(input.provider, "candles response.provider"),
    ...(booleanOptional(input.hasMore, "candles response.hasMore") === undefined ? {} : { hasMore: input.hasMore as boolean }),
  };
}

export function parseSparklinesResponse(value: unknown): SparklinesResponse {
  const input = record(value, "sparklines response");
  const seriesInput = record(input.series, "sparklines response.series");
  const series: Record<string, SparklineSeries | null> = {};
  for (const [symbol, raw] of Object.entries(seriesInput)) {
    if (raw === null) {
      series[symbol] = null;
      continue;
    }
    const item = record(raw, `series.${symbol}`);
    if (!Array.isArray(item.points)) throw new Error(`series.${symbol}.points must be an array`);
    const last = item.last === null ? null : finite(item.last, `series.${symbol}.last`);
    series[symbol] = {
      last,
      changePct: finite(item.changePct, `series.${symbol}.changePct`),
      points: item.points.map((point, index) => finite(point, `series.${symbol}.points[${index}]`)),
    };
  }
  return { timeframe: parseTimeframe(input.timeframe, "sparklines response.timeframe"), series };
}

export function parseStreamMessage(value: unknown): StreamMessage {
  const input = record(value, "stream message");
  const type = string(input.type, "stream message.type");
  const ts = finite(input.ts, "stream message.ts");
  if (type === "error") return { type, message: string(input.message, "stream message.message"), ts };
  if (type === "status") {
    const status = string(input.status, "stream message.status");
    if (status !== "connected" && status !== "fallback" && status !== "error") throw new Error("stream message.status is unsupported");
    return {
      type,
      status,
      provider: string(input.provider, "stream message.provider"),
      message: string(input.message, "stream message.message"),
      ts,
    };
  }
  if (type === "snapshot") {
    if (!Array.isArray(input.candles)) throw new Error("snapshot.candles must be an array");
    return {
      type,
      symbol: string(input.symbol, "snapshot.symbol"),
      timeframe: parseTimeframe(input.timeframe, "snapshot.timeframe"),
      candles: input.candles.map((item, index) => parseCandle(item, `snapshot.candles[${index}]`)),
      provider: string(input.provider, "snapshot.provider"),
      ts,
    };
  }
  if (type === "candle") {
    return {
      type,
      symbol: string(input.symbol, "candle message.symbol"),
      timeframe: parseTimeframe(input.timeframe, "candle message.timeframe"),
      candle: parseCandle(input.candle, "candle message.candle"),
      provider: string(input.provider, "candle message.provider"),
      ts,
    };
  }
  throw new Error(`Unsupported stream message type: ${type}`);
}
