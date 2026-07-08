export type IndicatorKind = "sma" | "ema" | "bollinger" | "rsi" | "macd" | "vwap" | "atr" | "stochastic" | "obv";

export interface BaseIndicatorConfig {
  id: string;
  label: string;
  enabled: boolean;
  visible?: boolean;
  logicCode?: string;
  logicXml?: string;
  color: string;
}

export interface PeriodIndicatorConfig extends BaseIndicatorConfig {
  kind: "sma" | "ema" | "rsi" | "vwap" | "atr";
  period: number;
}

export interface StochasticConfig extends BaseIndicatorConfig {
  kind: "stochastic";
  period: number;
  smooth: number;
  signalColor: string;
}

export interface ObvConfig extends BaseIndicatorConfig {
  kind: "obv";
}

export interface BollingerConfig extends BaseIndicatorConfig {
  kind: "bollinger";
  period: number;
  deviation: number;
  bandColor: string;
}

export interface MacdConfig extends BaseIndicatorConfig {
  kind: "macd";
  fast: number;
  slow: number;
  signal: number;
  signalColor: string;
  histogramUp: string;
  histogramDown: string;
}

export type IndicatorConfig =
  | PeriodIndicatorConfig
  | BollingerConfig
  | MacdConfig
  | StochasticConfig
  | ObvConfig;

export function isIndicatorVisible(indicator: IndicatorConfig) {
  return indicator.enabled && indicator.visible !== false;
}

export interface SeriesPoint {
  time: number;
  value?: number;
}

export interface BollingerPoint {
  time: number;
  middle?: number;
  upper?: number;
  lower?: number;
}

export interface MacdPoint {
  time: number;
  macd?: number;
  signal?: number;
  histogram?: number;
}

export interface StochasticPoint {
  time: number;
  k?: number;
  d?: number;
}
