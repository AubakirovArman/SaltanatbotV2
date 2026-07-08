// Named chart layouts ("workspaces"): capture the chart context — symbol,
// interval, chart type, exchange, enabled indicators (+ theme) — so users can
// snapshot a setup and jump back to it. Persisted under its own namespace so it
// never collides with the app's existing localStorage keys.
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { ChartType, DataExchange, Timeframe } from "../types";

const WORKSPACES_KEY = "sbv2:workspaces";

export interface Workspace {
  id: string;
  name: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  /** ids of the indicators that were enabled when the workspace was saved. */
  enabledIndicators: string[];
  theme: "dark" | "light";
  createdAt: number;
}

export interface WorkspaceContext {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  indicators: IndicatorConfig[];
  theme: "dark" | "light";
}

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Workspace[]).filter(isWorkspace) : [];
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: Workspace[]) {
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}

/** Snapshot the current chart context into a named workspace. */
export function captureWorkspace(name: string, context: WorkspaceContext): Workspace {
  return {
    id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Workspace",
    symbol: context.symbol,
    timeframe: context.timeframe,
    chartType: context.chartType,
    cryptoExchange: context.cryptoExchange,
    enabledIndicators: context.indicators.filter((indicator) => indicator.enabled).map((indicator) => indicator.id),
    theme: context.theme,
    createdAt: Date.now()
  };
}

/** Re-derive the indicator list for a workspace: enable exactly the saved set. */
export function applyIndicatorSelection(indicators: IndicatorConfig[], enabledIds: string[]): IndicatorConfig[] {
  const wanted = new Set(enabledIds);
  return indicators.map((indicator) => ({ ...indicator, enabled: wanted.has(indicator.id) }));
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const ws = value as Partial<Workspace>;
  return (
    typeof ws.id === "string" &&
    typeof ws.name === "string" &&
    typeof ws.symbol === "string" &&
    typeof ws.timeframe === "string" &&
    typeof ws.chartType === "string" &&
    Array.isArray(ws.enabledIndicators)
  );
}
