import type { IndicatorConfig, IndicatorPane, IndicatorScalePlacement } from "./indicatorTypes";

export interface PaneIndicatorOverride {
  id: string;
  enabled: boolean;
  visible?: boolean;
  pane?: IndicatorPane;
  scalePlacement?: IndicatorScalePlacement;
  color?: string;
  period?: number;
  deviation?: number;
  bandColor?: string;
  fast?: number;
  slow?: number;
  signal?: number;
  signalColor?: string;
  histogramUp?: string;
  histogramDown?: string;
  smooth?: number;
}

const MAX_OVERRIDES = 32;

export function capturePaneIndicatorOverrides(indicators: IndicatorConfig[]): PaneIndicatorOverride[] {
  return indicators.slice(0, MAX_OVERRIDES).map((indicator) => ({
    id: indicator.id,
    enabled: indicator.enabled,
    ...(indicator.visible === undefined ? {} : { visible: indicator.visible }),
    ...(indicator.pane === undefined ? {} : { pane: indicator.pane }),
    ...(indicator.scalePlacement === undefined ? {} : { scalePlacement: indicator.scalePlacement }),
    color: indicator.color,
    ...("period" in indicator ? { period: indicator.period } : {}),
    ...(indicator.kind === "bollinger" ? { deviation: indicator.deviation, bandColor: indicator.bandColor } : {}),
    ...(indicator.kind === "macd" ? { fast: indicator.fast, slow: indicator.slow, signal: indicator.signal, signalColor: indicator.signalColor, histogramUp: indicator.histogramUp, histogramDown: indicator.histogramDown } : {}),
    ...(indicator.kind === "stochastic" ? { smooth: indicator.smooth, signalColor: indicator.signalColor } : {})
  }));
}

export function applyPaneIndicatorOverrides(indicators: IndicatorConfig[], overrides: PaneIndicatorOverride[] | undefined): IndicatorConfig[] {
  const byId = new Map((overrides ?? []).map((override) => [override.id, override]));
  return indicators.map((indicator) => {
    const override = byId.get(indicator.id);
    if (!override) return { ...indicator, enabled: false };
    const { id: _id, ...settings } = override;
    return { ...indicator, ...settings } as IndicatorConfig;
  });
}

export function normalizePaneIndicatorOverrides(value: unknown): PaneIndicatorOverride[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: PaneIndicatorOverride[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_OVERRIDES)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const id = safeId(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      enabled: item.enabled === true,
      ...(typeof item.visible === "boolean" ? { visible: item.visible } : {}),
      ...(item.pane === "auto" || item.pane === "main" || item.pane === "separate" ? { pane: item.pane } : {}),
      ...(item.scalePlacement === "left" || item.scalePlacement === "right" || item.scalePlacement === "hidden" ? { scalePlacement: item.scalePlacement } : {}),
      ...colorField("color", item.color),
      ...colorField("bandColor", item.bandColor),
      ...colorField("signalColor", item.signalColor),
      ...colorField("histogramUp", item.histogramUp),
      ...colorField("histogramDown", item.histogramDown),
      ...numberField("period", item.period, 1, 10_000),
      ...numberField("deviation", item.deviation, 0.01, 100),
      ...numberField("fast", item.fast, 1, 10_000),
      ...numberField("slow", item.slow, 1, 10_000),
      ...numberField("signal", item.signal, 1, 10_000),
      ...numberField("smooth", item.smooth, 1, 10_000)
    });
  }
  return result;
}

function safeId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? value : undefined;
}

function colorField<K extends "color" | "bandColor" | "signalColor" | "histogramUp" | "histogramDown">(key: K, value: unknown): Pick<PaneIndicatorOverride, K> | object {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? { [key]: value } as Pick<PaneIndicatorOverride, K> : {};
}

function numberField<K extends "period" | "deviation" | "fast" | "slow" | "signal" | "smooth">(key: K, value: unknown, min: number, max: number): Pick<PaneIndicatorOverride, K> | object {
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  const clamped = Math.min(max, Math.max(min, value));
  return { [key]: key === "deviation" ? clamped : Math.round(clamped) } as Pick<PaneIndicatorOverride, K>;
}
