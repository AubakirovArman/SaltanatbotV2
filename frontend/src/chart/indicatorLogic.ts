import type { IndicatorConfig } from "./indicatorTypes";

export function indicatorSummary(indicator: IndicatorConfig) {
  if (indicator.kind === "macd") return `${indicator.fast}/${indicator.slow}/${indicator.signal}`;
  if (indicator.kind === "bollinger") return `${indicator.period} · ${indicator.deviation}`;
  if (indicator.kind === "stochastic") return `${indicator.period} · ${indicator.smooth}`;
  if (indicator.kind === "obv") return "cumulative";
  return String(indicator.period);
}

export function indicatorLogicPreview(indicator: IndicatorConfig) {
  if (indicator.logicCode) return indicator.logicCode;
  if (indicator.kind === "macd") {
    return [
      `macd = indicators.macd(close, ${indicator.fast}, ${indicator.slow}, ${indicator.signal})`,
      `plot(macd.line, color: "${indicator.color}")`,
      `plot(macd.signal, color: "${indicator.signalColor}")`
    ].join("\n");
  }
  if (indicator.kind === "bollinger") {
    return [
      `bands = indicators.bollinger(close, ${indicator.period}, ${indicator.deviation})`,
      `plot(bands.middle, color: "${indicator.color}")`,
      `plot(bands.upper/lower, color: "${indicator.bandColor}")`
    ].join("\n");
  }
  if (indicator.kind === "stochastic") {
    return [
      `stoch = indicators.stochastic(candles, ${indicator.period}, ${indicator.smooth})`,
      `plot(stoch.k, color: "${indicator.color}")`,
      `plot(stoch.d, color: "${indicator.signalColor}")`
    ].join("\n");
  }
  if (indicator.kind === "obv") {
    return [
      `value = indicators.obv(close, volume)`,
      `plot(value, color: "${indicator.color}")`
    ].join("\n");
  }
  return [
    `value = indicators.${indicator.kind}(${indicator.kind === "vwap" || indicator.kind === "atr" ? "candles" : "close"}, ${indicator.period})`,
    `plot(value, color: "${indicator.color}")`
  ].join("\n");
}
