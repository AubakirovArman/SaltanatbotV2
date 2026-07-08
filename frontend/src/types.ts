export type AssetClass = "crypto" | "forex" | "stock" | "index";

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1M";

export type ChartType = "candles" | "heikin" | "bars" | "line" | "area" | "baseline" | "renko";

/** Which exchange live crypto market data is sourced from. */
export type DataExchange = "binance" | "bybit";

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

export type StreamMessage =
  | {
      type: "snapshot";
      symbol: string;
      timeframe: Timeframe;
      candles: Candle[];
      provider: string;
      ts: number;
    }
  | {
      type: "candle";
      symbol: string;
      timeframe: Timeframe;
      candle: Candle;
      provider: string;
      ts: number;
    }
  | {
      type: "status";
      status: "connected" | "fallback" | "error";
      provider: string;
      message: string;
      ts: number;
    }
  | {
      type: "error";
      message: string;
      ts: number;
    };
