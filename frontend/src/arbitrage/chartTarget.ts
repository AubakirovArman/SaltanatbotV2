import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { DataExchange, DataMarketType, PriceType, Timeframe } from "../types";

/** Complete chart route emitted by scanner rows; never infer perpetual vs spot from a symbol. */
export interface ArbitrageChartTarget {
  symbol: string;
  exchange: DataExchange;
  marketType: DataMarketType;
  priceType: PriceType;
  /** Optional screen context: switch the active chart to this timeframe. */
  timeframe?: Timeframe;
  /** Optional screen context: indicator configurations to merge into the chart. */
  indicators?: IndicatorConfig[];
}

/**
 * Merges requested indicator context into the current chart indicators.
 * A kind that already exists is enabled instead of duplicated; only missing
 * kinds are appended. Returns the original array when nothing changes.
 */
export function mergeChartTargetIndicators(current: IndicatorConfig[], requested: IndicatorConfig[]): IndicatorConfig[] {
  const enabledKinds = new Set<IndicatorConfig["kind"]>();
  const additions: IndicatorConfig[] = [];
  for (const indicator of requested) {
    if (current.some((item) => item.kind === indicator.kind)) enabledKinds.add(indicator.kind);
    else if (!additions.some((item) => item.kind === indicator.kind)) additions.push(indicator);
  }
  const requiresEnable = current.some((item) => enabledKinds.has(item.kind) && !item.enabled);
  if (!requiresEnable && additions.length === 0) return current;
  const updated = requiresEnable ? current.map((item) => (enabledKinds.has(item.kind) && !item.enabled ? { ...item, enabled: true } : item)) : current;
  return additions.length > 0 ? [...updated, ...additions] : updated;
}
