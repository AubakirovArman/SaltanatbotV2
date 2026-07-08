export type AssetClass = "crypto" | "forex" | "stock" | "index";

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1M";

export interface Instrument {
  symbol: string;
  displayName: string;
  assetClass: AssetClass;
  exchange: string;
  currency: string;
  provider: "binance" | "synthetic";
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

export type ChartType = "candles" | "heikin" | "bars" | "line" | "area" | "baseline" | "renko";

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

export type StreamMessage =
  | StreamStatus
  | SnapshotMessage
  | CandleMessage
  | ErrorMessage;
