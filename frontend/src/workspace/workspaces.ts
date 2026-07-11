import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { ChartType, DataExchange, Timeframe } from "../types";

const WORKSPACES_KEY = "sbv2:workspaces";
export const WORKSPACE_SCHEMA_VERSION = 2;
export const WORKSPACE_FILE_FORMAT = "saltanatbotv2.workspace";
export const WORKSPACE_FILE_VERSION = 1;
export const MAX_WORKSPACE_REVISIONS = 20;

export type ChartLayoutPreset = "single" | "split-vertical" | "split-horizontal" | "grid-4";

export interface WorkspaceChart {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  linkGroup?: string;
  linkSymbol: boolean;
  linkTimeframe: boolean;
  linkCrosshair: boolean;
}

export interface WorkspaceLayout {
  preset: ChartLayoutPreset;
  leftOpen: boolean;
  rightOpen: boolean;
  leftSize: number;
  rightSize: number;
  panelsSwapped: boolean;
}

export interface WorkspaceRevision {
  revision: number;
  savedAt: number;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  enabledIndicators: string[];
  theme: "dark" | "light";
  layout: WorkspaceLayout;
  charts: WorkspaceChart[];
}

export interface Workspace extends WorkspaceRevision {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  history: WorkspaceRevision[];
}

export interface WorkspaceContext {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  indicators: IndicatorConfig[];
  theme: "dark" | "light";
  layout?: Partial<WorkspaceLayout>;
  charts?: WorkspaceChart[];
}

export interface WorkspaceFile {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: typeof WORKSPACE_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  exportedAt: number;
  workspace: Workspace;
}

const defaultLayout: WorkspaceLayout = {
  preset: "single",
  leftOpen: true,
  rightOpen: true,
  leftSize: 260,
  rightSize: 280,
  panelsSwapped: false
};

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeWorkspace).filter((item): item is Workspace => item !== undefined);
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

export function captureWorkspace(name: string, context: WorkspaceContext, now = Date.now()): Workspace {
  const snapshot = snapshotFromContext(context, 1, now);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: `ws-${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Workspace",
    createdAt: now,
    updatedAt: now,
    history: [],
    ...snapshot
  };
}

/** Append a bounded immutable revision only when chart/layout state changed. */
export function reviseWorkspace(workspace: Workspace, context: WorkspaceContext, now = Date.now()): Workspace {
  const next = snapshotFromContext(context, workspace.revision + 1, now);
  if (revisionFingerprint(workspace) === revisionFingerprint(next)) return workspace;
  const previous = toRevision(workspace);
  return {
    ...workspace,
    ...next,
    updatedAt: now,
    history: [...workspace.history, previous].slice(-MAX_WORKSPACE_REVISIONS)
  };
}

export function rollbackWorkspace(workspace: Workspace, revision: number, now = Date.now()): Workspace | undefined {
  const target = workspace.history.find((item) => item.revision === revision);
  if (!target) return undefined;
  return {
    ...workspace,
    ...cloneRevision(target),
    revision: workspace.revision + 1,
    savedAt: now,
    updatedAt: now,
    history: [...workspace.history, toRevision(workspace)].slice(-MAX_WORKSPACE_REVISIONS)
  };
}

export function applyIndicatorSelection(indicators: IndicatorConfig[], enabledIds: string[]): IndicatorConfig[] {
  const wanted = new Set(enabledIds);
  return indicators.map((indicator) => ({ ...indicator, enabled: wanted.has(indicator.id) }));
}

export async function encodeWorkspaceFile(workspace: Workspace, now = Date.now()): Promise<string> {
  const payload = canonicalStringify(workspace);
  const file: WorkspaceFile = {
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    algorithm: "SHA-256",
    checksum: await sha256(payload),
    exportedAt: now,
    workspace
  };
  return JSON.stringify(file, null, 2);
}

export async function parseWorkspaceFile(raw: string): Promise<Workspace | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const file = parsed as Partial<WorkspaceFile>;
  if (file.format !== WORKSPACE_FILE_FORMAT || file.version !== WORKSPACE_FILE_VERSION || file.algorithm !== "SHA-256") return undefined;
  if (typeof file.checksum !== "string") return undefined;
  const workspace = normalizeWorkspace(file.workspace);
  if (!workspace || await sha256(canonicalStringify(file.workspace)) !== file.checksum) return undefined;
  return workspace;
}

export async function downloadWorkspaceFile(workspace: Workspace) {
  const blob = new Blob([await encodeWorkspaceFile(workspace)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(workspace.name) || "workspace"}.saltanat-workspace.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function snapshotFromContext(context: WorkspaceContext, revision: number, savedAt: number): WorkspaceRevision {
  const layout = normalizeLayout(context.layout);
  const charts = context.charts?.length
    ? context.charts.map((chart) => ({ ...chart }))
    : [defaultChart(context.symbol, context.timeframe, context.chartType)];
  return {
    revision,
    savedAt,
    symbol: context.symbol,
    timeframe: context.timeframe,
    chartType: context.chartType,
    cryptoExchange: context.cryptoExchange,
    enabledIndicators: context.indicators.filter((indicator) => indicator.enabled).map((indicator) => indicator.id),
    theme: context.theme,
    layout,
    charts
  };
}

function normalizeWorkspace(value: unknown): Workspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<Workspace>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.symbol !== "string") return undefined;
  if (typeof item.timeframe !== "string" || typeof item.chartType !== "string" || !Array.isArray(item.enabledIndicators)) return undefined;
  const createdAt = finiteNumber(item.createdAt, Date.now());
  const revision = Math.max(1, finiteNumber(item.revision, 1));
  const savedAt = finiteNumber(item.savedAt, createdAt);
  const layout = normalizeLayout(item.layout);
  const charts = Array.isArray(item.charts)
    ? item.charts.map(normalizeChart).filter((chart): chart is WorkspaceChart => chart !== undefined)
    : [];
  const base: Workspace = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: item.id,
    name: item.name,
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    cryptoExchange: item.cryptoExchange === "bybit" ? "bybit" : "binance",
    enabledIndicators: item.enabledIndicators.filter((id): id is string => typeof id === "string"),
    theme: item.theme === "light" ? "light" : "dark",
    revision,
    savedAt,
    createdAt,
    updatedAt: finiteNumber(item.updatedAt, savedAt),
    layout,
    charts: charts.length ? charts : [defaultChart(item.symbol, item.timeframe, item.chartType)],
    history: []
  };
  base.history = Array.isArray(item.history)
    ? item.history.map((entry) => normalizeRevision(entry, base)).filter((entry): entry is WorkspaceRevision => entry !== undefined).slice(-MAX_WORKSPACE_REVISIONS)
    : [];
  return base;
}

function normalizeRevision(value: unknown, fallback: Workspace): WorkspaceRevision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<WorkspaceRevision>;
  if (typeof item.symbol !== "string" || typeof item.timeframe !== "string" || typeof item.chartType !== "string") return undefined;
  const charts = Array.isArray(item.charts) ? item.charts.map(normalizeChart).filter((chart): chart is WorkspaceChart => chart !== undefined) : [];
  return {
    revision: Math.max(1, finiteNumber(item.revision, 1)),
    savedAt: finiteNumber(item.savedAt, fallback.createdAt),
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    cryptoExchange: item.cryptoExchange === "bybit" ? "bybit" : "binance",
    enabledIndicators: Array.isArray(item.enabledIndicators) ? item.enabledIndicators.filter((id): id is string => typeof id === "string") : [],
    theme: item.theme === "light" ? "light" : "dark",
    layout: normalizeLayout(item.layout),
    charts: charts.length ? charts : [defaultChart(item.symbol, item.timeframe, item.chartType)]
  };
}

function normalizeLayout(value?: Partial<WorkspaceLayout>): WorkspaceLayout {
  return {
    preset: value?.preset === "split-vertical" || value?.preset === "split-horizontal" || value?.preset === "grid-4" ? value.preset : "single",
    leftOpen: value?.leftOpen ?? true,
    rightOpen: value?.rightOpen ?? true,
    leftSize: clamp(finiteNumber(value?.leftSize, defaultLayout.leftSize), 180, 520),
    rightSize: clamp(finiteNumber(value?.rightSize, defaultLayout.rightSize), 220, 520),
    panelsSwapped: value?.panelsSwapped === true
  };
}

function normalizeChart(value: unknown): WorkspaceChart | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<WorkspaceChart>;
  if (typeof item.id !== "string" || typeof item.symbol !== "string" || typeof item.timeframe !== "string" || typeof item.chartType !== "string") return undefined;
  return {
    id: item.id,
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    linkGroup: typeof item.linkGroup === "string" ? item.linkGroup : undefined,
    linkSymbol: item.linkSymbol !== false,
    linkTimeframe: item.linkTimeframe !== false,
    linkCrosshair: item.linkCrosshair !== false
  };
}

function defaultChart(symbol: string, timeframe: Timeframe, chartType: ChartType): WorkspaceChart {
  return { id: "chart-1", symbol, timeframe, chartType, linkGroup: "primary", linkSymbol: true, linkTimeframe: true, linkCrosshair: true };
}

function toRevision(workspace: Workspace): WorkspaceRevision {
  return cloneRevision(workspace);
}

function cloneRevision(revision: WorkspaceRevision): WorkspaceRevision {
  return {
    revision: revision.revision,
    savedAt: revision.savedAt,
    symbol: revision.symbol,
    timeframe: revision.timeframe,
    chartType: revision.chartType,
    cryptoExchange: revision.cryptoExchange,
    enabledIndicators: [...revision.enabledIndicators],
    theme: revision.theme,
    layout: { ...revision.layout },
    charts: revision.charts.map((chart) => ({ ...chart }))
  };
}

function revisionFingerprint(revision: WorkspaceRevision): string {
  const { revision: _revision, savedAt: _savedAt, ...state } = cloneRevision(revision);
  return canonicalStringify(state);
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
