import type { DrawingStorageEventDetail } from "../chart/drawingStore";
import { loadDrawings, restoreDrawings } from "../chart/drawingStore";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import { DEFAULT_CHART_TIME_ZONE } from "../chart/timeAxis";
import type { Locale } from "../i18n";
import type { ChartType, Timeframe } from "../types";
import type { Workspace, WorkspaceChart } from "./workspaces";
import type { ChartLayoutPreset, WorkspaceMode } from "./workspaces";

export type DrawingSnapshotMap = Map<string, DrawingStorageEventDetail["drawings"]>;
export type WorkspaceTemplateKind = "monitoring" | "research" | "backtest" | "paper-robot";

export function captureWorkspaceDrawings(charts: WorkspaceChart[], ownerId: string | undefined, snapshots: DrawingSnapshotMap) {
  return charts.map((chart) => ({
    chartId: chart.id,
    symbol: chart.symbol,
    drawings: snapshots.get(drawingSnapshotKey(chart.id, chart.symbol)) ?? loadDrawings(chart.symbol, chart.id, ownerId)
  }));
}

export function restoreWorkspaceDrawings(workspace: Workspace, ownerId: string | undefined, snapshots: DrawingSnapshotMap): void {
  const scopes = new Map(workspace.drawings.map((scope) => [drawingSnapshotKey(scope.chartId, scope.symbol), scope.drawings]));
  workspace.charts.forEach((chart) => {
    const drawings = restoreDrawings(chart.symbol, scopes.get(drawingSnapshotKey(chart.id, chart.symbol)) ?? [], chart.id, ownerId);
    snapshots.set(drawingSnapshotKey(chart.id, chart.symbol), drawings);
  });
}

export function drawingSnapshotKey(chartId: string, symbol: string): string {
  return `${chartId}\u0000${symbol}`;
}

export function uniqueWorkspaceId(candidate: string, workspaces: Workspace[]): string {
  const stem = candidate.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 150) || `ws-${Date.now()}`;
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  if (!ids.has(stem)) return stem;
  let index = 2;
  while (ids.has(`${stem.slice(0, 150)}-${index}`)) index += 1;
  return `${stem.slice(0, 150)}-${index}`;
}

export function duplicateWorkspace(source: Workspace, workspaces: Workspace[], now = Date.now()): Workspace {
  return {
    ...source,
    id: uniqueWorkspaceId(`${source.id}-copy-${now}`, workspaces),
    name: `${source.name} (copy)`.slice(0, 120),
    revision: 1,
    savedAt: now,
    createdAt: now,
    updatedAt: now,
    archivedAt: undefined,
    history: []
  };
}

export function workspaceTemplate(kind: WorkspaceTemplateKind, locale: Locale): { name: string; mode: WorkspaceMode } {
  const names: Record<Locale, Record<WorkspaceTemplateKind, string>> = {
    en: { monitoring: "Monitoring", research: "Research", backtest: "Backtest", "paper-robot": "Paper robot" },
    ru: { monitoring: "Мониторинг", research: "Исследование", backtest: "Бэктест", "paper-robot": "Paper-робот" },
    kk: { monitoring: "Мониторинг", research: "Зерттеу", backtest: "Бэктест", "paper-robot": "Paper робот" }
  };
  const modes: Record<WorkspaceTemplateKind, WorkspaceMode> = {
    monitoring: "chart",
    research: "screener",
    backtest: "strategy",
    "paper-robot": "trade"
  };
  return { name: names[locale][kind], mode: modes[kind] };
}

export function chartsForWorkspaceLayout(
  preset: ChartLayoutPreset,
  current: WorkspaceChart[],
  symbol: string,
  timeframe: Timeframe,
  chartType: ChartType
): WorkspaceChart[] {
  const count = preset === "single" ? 1 : preset === "grid-4" ? 4 : 2;
  return Array.from({ length: count }, (_, index) => current[index] ?? {
    id: `chart-${index + 1}`,
    symbol,
    timeframe,
    chartType,
    marketType: "spot",
    priceType: "last",
    timeZone: DEFAULT_CHART_TIME_ZONE,
    linkChartType: true,
    linkGroup: "primary",
    linkSymbol: index === 0,
    linkTimeframe: true,
    linkCrosshair: true,
    linkTimeRange: true,
    linkIndicators: true,
    linkCompare: true
  });
}

export function hydrateLegacyWorkspaceIndicators(workspaces: Workspace[], catalog: IndicatorConfig[]): Workspace[] {
  return workspaces.map((workspace) => {
    const hydrate = (indicators: IndicatorConfig[], enabledIndicators: string[]) => {
      if (indicators.length || enabledIndicators.length === 0) return { indicators, enabledIndicators };
      const enabled = new Set(enabledIndicators);
      const hydrated = catalog.map((indicator) => ({ ...indicator, enabled: enabled.has(indicator.id) }));
      return { indicators: hydrated, enabledIndicators: hydrated.filter((indicator) => indicator.enabled).map((indicator) => indicator.id) };
    };
    const current = hydrate(workspace.indicators, workspace.enabledIndicators);
    return {
      ...workspace,
      indicators: current.indicators,
      enabledIndicators: current.enabledIndicators,
      history: workspace.history.map((revision) => {
        const hydrated = hydrate(revision.indicators, revision.enabledIndicators);
        return { ...revision, indicators: hydrated.indicators, enabledIndicators: hydrated.enabledIndicators };
      })
    };
  });
}

export function missingLegacyWorkspaceIndicatorIds(workspaces: Workspace[], catalog: IndicatorConfig[]): string[] {
  const available = new Set(catalog.map((indicator) => indicator.id));
  const missing = new Set<string>();
  const inspect = (indicators: IndicatorConfig[], enabledIndicators: string[]) => {
    if (indicators.length) return;
    enabledIndicators.forEach((id) => {
      if (!available.has(id)) missing.add(id);
    });
  };
  workspaces.forEach((workspace) => {
    inspect(workspace.indicators, workspace.enabledIndicators);
    workspace.history.forEach((revision) => inspect(revision.indicators, revision.enabledIndicators));
  });
  return [...missing];
}
