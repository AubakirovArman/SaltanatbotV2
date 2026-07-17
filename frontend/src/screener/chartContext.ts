import type { ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import type { IndicatorConfig } from "../chart/indicatorTypes";

/**
 * Maps the indicator filters of a screen definition to chart indicator
 * configurations. One configuration per indicator kind: the chart merge in
 * App.tsx only enables kinds that already exist, so duplicates are pointless.
 */
export function screenerChartIndicators(definition: ScreenerDefinitionV1): IndicatorConfig[] {
  const indicators: IndicatorConfig[] = [];
  const kinds = new Set<IndicatorConfig["kind"]>();
  const push = (indicator: IndicatorConfig) => {
    if (kinds.has(indicator.kind)) return;
    kinds.add(indicator.kind);
    indicators.push(indicator);
  };
  for (const filter of definition.filters) {
    if (filter.kind === "rsi") {
      push({ id: `screener-rsi-${filter.period}`, kind: "rsi", label: "RSI", enabled: true, period: filter.period, color: "#23c97a" });
    } else if (filter.kind === "ma-cross") {
      push(movingAverage(filter.fastType, filter.fastPeriod));
      push(movingAverage(filter.slowType, filter.slowPeriod));
    } else if (filter.kind === "macd") {
      push({
        id: `screener-macd-${filter.fast}-${filter.slow}`,
        kind: "macd",
        label: "MACD",
        enabled: true,
        fast: filter.fast,
        slow: filter.slow,
        signal: filter.signal,
        color: "#4db6ff",
        signalColor: "#f7c948",
        histogramUp: "#23c97a",
        histogramDown: "#ef5350"
      });
    } else if (filter.kind === "atr-percent") {
      push({ id: `screener-atr-${filter.period}`, kind: "atr", label: "ATR", enabled: true, period: filter.period, color: "#e0af68" });
    }
  }
  return indicators;
}

function movingAverage(type: "ema" | "sma", period: number): IndicatorConfig {
  return {
    id: `screener-${type}-${period}`,
    kind: type,
    label: type.toUpperCase(),
    enabled: true,
    period,
    color: type === "ema" ? "#4db6ff" : "#f7c948"
  };
}
