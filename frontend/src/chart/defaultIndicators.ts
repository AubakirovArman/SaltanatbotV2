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
    }
  ];
}
