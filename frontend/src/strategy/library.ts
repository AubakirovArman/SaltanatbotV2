import { indicatorLogicPreview } from "../chart/indicatorLogic";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import { starterStrategyXml } from "./starter";
import { strategyTemplates } from "./templates";
import type { PineConversionReport, PineDiagnostic, PineLanguageProfile, PineSourceMapEntry } from "@saltanatbotv2/pine-compiler";

export type StrategyArtifactKind = "indicator" | "strategy";
export const ARTIFACT_SCHEMA_VERSION = 2;

export interface ArtifactParameter {
  name: string;
  value: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  optimizationEligible?: boolean;
}

export interface ArtifactRevision {
  version: number;
  semanticVersion: string;
  hash: string;
  irHash?: string;
  name: string;
  description: string;
  xml: string;
  code?: string;
  parameters?: ArtifactParameter[];
  dependencies?: string[];
  savedAt: number;
}

export interface StrategyArtifact {
  id: string;
  kind: StrategyArtifactKind;
  name: string;
  description: string;
  linkedIndicatorId?: string;
  xml: string;
  code?: string;
  version?: number;
  /** Fingerprint of the complete artifact payload used for version changes. */
  hash?: string;
  /** Fingerprint of canonical compiled StrategyIR only. */
  irHash?: string;
  schemaVersion?: number;
  semanticVersion?: string;
  parameters?: ArtifactParameter[];
  dependencies?: string[];
  history?: ArtifactRevision[];
  migration?: { fromSchema: number; toSchema: number; migratedAt: number };
  provenance?: {
    source: "local" | "pine" | "file" | "share" | "wizard" | "plugin";
    importedAt?: number;
    parentId?: string;
    parentHash?: string;
    pluginId?: string;
    pluginVersion?: string;
    publisher?: string;
    manifestHash?: string;
  };
  createdAt: number;
  updatedAt: number;
  /** Immutable import evidence. Blockly edits do not rewrite the original Pine source. */
  pine?: {
    source: string;
    language: PineLanguageProfile;
    diagnostics: PineDiagnostic[];
    report: PineConversionReport;
    sourceMap: PineSourceMapEntry[];
  };
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
  const defaults = createDefaultStrategyLibrary(indicators).map((artifact) => normalizeArtifact(artifact));
  if (!stored?.length) return defaults;
  const existing = new Map(stored.map((item) => {
    const normalized = normalizeArtifact(item);
    return [normalized.id, normalized];
  }));
  defaults.forEach((item) => {
    if (!existing.has(item.id)) existing.set(item.id, item);
  });
  return [...existing.values()];
}

export function normalizeArtifact(artifact: StrategyArtifact, now = Date.now()): StrategyArtifact {
  const fromSchema = artifact.schemaVersion ?? 1;
  return {
    ...artifact,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    semanticVersion: artifact.semanticVersion ?? `0.${Math.max(1, artifact.version ?? 1)}.0`,
    history: Array.isArray(artifact.history) ? artifact.history.slice(-30) : [],
    dependencies: Array.isArray(artifact.dependencies) ? [...new Set(artifact.dependencies.filter((id) => typeof id === "string" && id !== artifact.id))] : [],
    provenance: artifact.provenance ?? { source: artifact.pine ? "pine" : "local", importedAt: artifact.pine ? artifact.createdAt : undefined },
    migration: fromSchema < ARTIFACT_SCHEMA_VERSION ? { fromSchema, toSchema: ARTIFACT_SCHEMA_VERSION, migratedAt: now } : artifact.migration
  };
}

export function createNewArtifact(kind: StrategyArtifactKind, count: number): StrategyArtifact {
  const now = Date.now();
  const name = kind === "indicator" ? `Custom Indicator ${count}` : `Custom Strategy ${count}`;
  return {
    id: `${kind}:custom-${now}`,
    kind,
    name,
    description: kind === "indicator" ? "Draft indicator logic." : "Draft strategy logic.",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    semanticVersion: "0.1.0",
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
