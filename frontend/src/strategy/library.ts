import { indicatorLogicPreview } from "../chart/indicatorLogic";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import { starterStrategyXml } from "./starter";
import { strategyTemplates } from "./templates";

export type StrategyArtifactKind = "indicator" | "strategy";

export interface StrategyArtifact {
  id: string;
  kind: StrategyArtifactKind;
  name: string;
  description: string;
  linkedIndicatorId?: string;
  xml: string;
  code?: string;
  version?: number;
  hash?: string;
  createdAt: number;
  updatedAt: number;
}

export function createDefaultStrategyLibrary(indicators: IndicatorConfig[]) {
  const now = Date.now();
  return [
    ...indicators.map((indicator) => indicatorToArtifact(indicator, now)),
    {
      id: "strategy:price-cross-ema",
      kind: "strategy",
      name: "Price Cross EMA",
      description: "Buy when close crosses above EMA 21 and plot the EMA line.",
      xml: starterStrategyXml,
      code: "",
      createdAt: now,
      updatedAt: now
    } satisfies StrategyArtifact,
    ...strategyTemplates.map((template) => ({
      id: template.id,
      kind: "strategy" as const,
      name: template.name,
      description: template.description,
      xml: template.xml,
      code: "",
      createdAt: now,
      updatedAt: now
    } satisfies StrategyArtifact))
  ];
}

export function mergeDefaultStrategyLibrary(
  stored: StrategyArtifact[] | undefined,
  indicators: IndicatorConfig[]
) {
  const defaults = createDefaultStrategyLibrary(indicators);
  if (!stored?.length) return defaults;
  const existing = new Map(stored.map((item) => [item.id, item]));
  defaults.forEach((item) => {
    if (!existing.has(item.id)) existing.set(item.id, item);
  });
  return [...existing.values()];
}

export function createNewArtifact(kind: StrategyArtifactKind, count: number): StrategyArtifact {
  const now = Date.now();
  const name = kind === "indicator" ? `Custom Indicator ${count}` : `Custom Strategy ${count}`;
  return {
    id: `${kind}:custom-${now}`,
    kind,
    name,
    description: kind === "indicator" ? "Draft indicator logic." : "Draft strategy logic.",
    xml: kind === "indicator" ? customIndicatorXml(name) : starterStrategyXml,
    createdAt: now,
    updatedAt: now
  };
}

export function indicatorToArtifact(indicator: IndicatorConfig, now = Date.now()): StrategyArtifact {
  return {
    id: indicatorArtifactId(indicator.id),
    kind: "indicator",
    name: indicator.label,
    description: `${indicator.label} ${indicatorSummaryText(indicator)} chart logic.`,
    linkedIndicatorId: indicator.id,
    xml: indicator.logicXml ?? indicatorXml(indicator),
    code: indicator.logicCode ?? indicatorLogicPreview(indicator),
    createdAt: now,
    updatedAt: now
  };
}

export function indicatorArtifactId(indicatorId: string) {
  return `indicator:${indicatorId}`;
}

function indicatorXml(indicator: IndicatorConfig) {
  if (indicator.kind === "bollinger") return bollingerXml(indicator);
  if (indicator.kind === "macd") return macdXml(indicator);
  if (indicator.kind === "rsi") {
    return singlePlotXml({
      name: `${indicator.label} ${indicator.period}`,
      label: `${indicator.label} ${indicator.period}`,
      color: indicator.color,
      value: rsiValue(indicator.period)
    });
  }
  if (indicator.kind === "sma" || indicator.kind === "ema") {
    return singlePlotXml({
      name: `${indicator.label} ${indicator.period}`,
      label: `${indicator.label} ${indicator.period}`,
      color: indicator.color,
      value: maValue(indicator.kind, indicator.period)
    });
  }
  // VWAP / ATR / Stochastic / OBV have no dedicated Blockly block yet — seed the
  // editable logic with a close-price plot so the artifact stays valid/editable.
  return singlePlotXml({
    name: indicator.label,
    label: indicator.label,
    color: indicator.color,
    value: closeBlock()
  });
}

function bollingerXml(indicator: Extract<IndicatorConfig, { kind: "bollinger" }>) {
  return strategyXml(`${indicator.label} ${indicator.period}`, [
    plotBlock(`${indicator.label} mid`, indicator.color, bollingerValue("middle", indicator.period, indicator.deviation)),
    plotBlock(`${indicator.label} upper`, indicator.bandColor, bollingerValue("upper", indicator.period, indicator.deviation)),
    plotBlock(`${indicator.label} lower`, indicator.bandColor, bollingerValue("lower", indicator.period, indicator.deviation))
  ]);
}

function macdXml(indicator: Extract<IndicatorConfig, { kind: "macd" }>) {
  return strategyXml(`${indicator.label} ${indicator.fast}/${indicator.slow}/${indicator.signal}`, [
    plotBlock("MACD", indicator.color, macdValue("macd", indicator.fast, indicator.slow, indicator.signal)),
    plotBlock("MACD signal", indicator.signalColor, macdValue("signal", indicator.fast, indicator.slow, indicator.signal)),
    plotBlock("MACD hist", indicator.histogramUp, macdValue("histogram", indicator.fast, indicator.slow, indicator.signal))
  ]);
}

function singlePlotXml(input: { name: string; label: string; color: string; value: string }) {
  return strategyXml(input.name, [plotBlock(input.label, input.color, input.value)]);
}

function customIndicatorXml(name: string) {
  return singlePlotXml({
    name,
    label: name,
    color: "#4db6ff",
    value: maValue("sma", 20)
  });
}

function strategyXml(name: string, blocks: string[]) {
  return `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="strategy_start" x="24" y="24">
    <field name="NAME">${escapeXml(name)}</field>
    <statement name="RULES">
      ${chainBlocks(blocks)}
    </statement>
  </block>
</xml>`;
}

function chainBlocks(blocks: string[]): string {
  return blocks.reduceRight((next, block) => (
    next ? `${block}<next>${next}</next></block>` : `${block}</block>`
  ), "");
}

function plotBlock(label: string, color: string, value: string) {
  return `<block type="plot_series">
  <field name="LABEL">${escapeXml(label)}</field>
  <field name="COLOR">${escapeXml(color)}</field>
  <value name="VALUE">${value}</value>`;
}

function maValue(kind: "sma" | "ema", period: number) {
  return `<block type="indicator_ma">
    <field name="KIND">${kind}</field>
    <value name="PERIOD">${numberBlock(period)}</value>
    <value name="SOURCE">${closeBlock()}</value>
  </block>`;
}

function rsiValue(period: number) {
  return `<block type="indicator_rsi">
    <value name="PERIOD">${numberBlock(period)}</value>
    <value name="SOURCE">${closeBlock()}</value>
  </block>`;
}

function bollingerValue(band: "upper" | "middle" | "lower", period: number, deviation: number) {
  return `<block type="indicator_bollinger">
    <field name="BAND">${band}</field>
    <value name="PERIOD">${numberBlock(period)}</value>
    <value name="DEV">${numberBlock(deviation)}</value>
    <value name="SOURCE">${closeBlock()}</value>
  </block>`;
}

function macdValue(line: "macd" | "signal" | "histogram", fast: number, slow: number, signal: number) {
  return `<block type="indicator_macd">
    <field name="LINE">${line}</field>
    <value name="FAST">${numberBlock(fast)}</value>
    <value name="SLOW">${numberBlock(slow)}</value>
    <value name="SIGNAL">${numberBlock(signal)}</value>
    <value name="SOURCE">${closeBlock()}</value>
  </block>`;
}

function numberBlock(value: number) {
  return `<block type="math_number"><field name="NUM">${value}</field></block>`;
}

function closeBlock() {
  return `<block type="market_price"><field name="FIELD">close</field></block>`;
}

function indicatorSummaryText(indicator: IndicatorConfig) {
  if (indicator.kind === "macd") return `${indicator.fast}/${indicator.slow}/${indicator.signal}`;
  if (indicator.kind === "bollinger") return `${indicator.period}, dev ${indicator.deviation}`;
  if (indicator.kind === "stochastic") return `${indicator.period}, smooth ${indicator.smooth}`;
  if (indicator.kind === "obv") return "cumulative";
  return `${indicator.period}`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
