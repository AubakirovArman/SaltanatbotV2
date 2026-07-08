import type { IndicatorConfig } from "./indicatorTypes";

export function createDefaultIndicators(): IndicatorConfig[] {
  return [
    {
      id: "sma-20",
      kind: "sma",
      label: "SMA",
      enabled: true,
      period: 20,
      color: "#f7c948"
    },
    {
      id: "ema-50",
      kind: "ema",
      label: "EMA",
      enabled: false,
      period: 50,
      color: "#4db6ff"
    },
    {
      id: "bb-20",
      kind: "bollinger",
      label: "Bollinger",
      enabled: true,
      period: 20,
      deviation: 2,
      color: "#b48cff",
      bandColor: "#8f9bb3"
    },
    {
      id: "rsi-14",
      kind: "rsi",
      label: "RSI",
      enabled: true,
      period: 14,
      color: "#23c97a"
    },
    {
      id: "macd-12-26",
      kind: "macd",
      label: "MACD",
      enabled: false,
      fast: 12,
      slow: 26,
      signal: 9,
      color: "#4db6ff",
      signalColor: "#f7c948",
      histogramUp: "#23c97a",
      histogramDown: "#ef5350"
    },
    {
      id: "vwap-20",
      kind: "vwap",
      label: "VWAP",
      enabled: false,
      period: 20,
      color: "#ff9e64"
    },
    {
      id: "atr-14",
      kind: "atr",
      label: "ATR",
      enabled: false,
      period: 14,
      color: "#e0af68"
    },
    {
      id: "stoch-14",
      kind: "stochastic",
      label: "Stochastic",
      enabled: false,
      period: 14,
      smooth: 3,
      color: "#7dcfff",
      signalColor: "#f7768e"
    },
    {
      id: "obv",
      kind: "obv",
      label: "OBV",
      enabled: false,
      color: "#9ece6a"
    }
  ];
}
