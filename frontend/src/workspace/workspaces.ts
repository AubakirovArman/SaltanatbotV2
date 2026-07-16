import type { IndicatorConfig } from "../chart/indicatorTypes";
import { normalizePaneIndicatorOverrides, type PaneIndicatorOverride } from "../chart/paneIndicators";
import { normalizeCompareOverlays } from "../chart/compareConfig";
import type { CompareOverlayConfig } from "../chart/types";
import type { ChartType, DataExchange, DataMarketType, PriceType, Timeframe } from "../types";
import { DEFAULT_CHART_TIME_ZONE, LEGACY_CHART_TIME_ZONE, normalizeChartTimeZone, type ChartTimeZone } from "../chart/timeAxis";
import { claimLegacyTenantLocalData } from "../app/tenantLocalStorage";
import type { DrawingObject } from "../chart/drawings";
import { browserSha256 } from "../security/browserSha256";
import { boundWorkspaceHistory, MAX_WORKSPACE_DOCUMENT_BYTES, MAX_WORKSPACE_FILE_BYTES, workspaceDocumentBytes } from "./workspaceFileLimits";
import { retryMigratedWorkspaceCleanup, WORKSPACES_CLAIM_KEY, WORKSPACES_KEY } from "./workspaceMigrationStorage";
export { removeMigratedWorkspaceSource } from "./workspaceMigrationStorage";
import {
  hasOnlyKeys,
  isWorkspaceChartType,
  isWorkspaceTimeframe,
  normalizeWorkspaceDrawingScopes,
  normalizeWorkspaceIndicators,
  normalizeWorkspaceMode,
  normalizeWorkspaceName,
  normalizeWorkspaceStrategySelection,
  strictLegacyWorkspaceShape,
  strictWorkspaceFileMetadata,
  strictWorkspaceShape,
  validWorkspaceIdentifier,
  validWorkspaceSymbol
} from "./workspaceValidation";

const WORKSPACES_CACHE_KEY = "sbv2:workspace-cache:v1";
const WORKSPACES_REMOTE_IDS_KEY = "sbv2:workspace-remote-ids:v1";
const LAST_ACTIVE_WORKSPACE_KEY = "sbv2:last-active-workspace:v1";
export const WORKSPACE_SCHEMA_VERSION = 8;
export const WORKSPACE_FILE_FORMAT = "saltanatbotv2.workspace";
export const WORKSPACE_FILE_VERSION = 1;
export const MAX_WORKSPACE_REVISIONS = 20;
export { MAX_WORKSPACE_DOCUMENT_BYTES, MAX_WORKSPACE_FILE_BYTES } from "./workspaceFileLimits";
export const MAX_WORKSPACE_NAME_LENGTH = 120;
export const MAX_WORKSPACE_INDICATORS = 128;

export type ChartLayoutPreset = "single" | "split-vertical" | "split-horizontal" | "grid-4";
export type WorkspaceMode = "chart" | "strategy" | "trade" | "screener";

export interface WorkspaceDrawingScope {
  chartId: string;
  symbol: string;
  drawings: DrawingObject[];
}

export interface WorkspaceStrategySelection {
  id: string;
  revision: number;
  hash?: string;
  parameters: Record<string, number>;
}

export interface WorkspaceChart {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  /** Optional for backwards compatibility; absent values inherit the workspace exchange and spot/last. */
  exchange?: DataExchange;
  marketType?: DataMarketType;
  priceType?: PriceType;
  timeZone?: ChartTimeZone;
  linkChartType: boolean;
  linkGroup?: string;
  linkSymbol: boolean;
  linkTimeframe: boolean;
  linkCrosshair: boolean;
  linkTimeRange: boolean;
  linkIndicators: boolean;
  indicatorOverrides?: PaneIndicatorOverride[];
  linkCompare: boolean;
  compareOverlays?: CompareOverlayConfig[];
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
  mode: WorkspaceMode;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  enabledIndicators: string[];
  indicators: IndicatorConfig[];
  compareOverlays: CompareOverlayConfig[];
  theme: "dark" | "light";
  layout: WorkspaceLayout;
  charts: WorkspaceChart[];
  activeChartId?: string;
  drawings: WorkspaceDrawingScope[];
  selectedStrategy?: WorkspaceStrategySelection;
}

export interface Workspace extends WorkspaceRevision {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  history: WorkspaceRevision[];
}

export interface WorkspaceContext {
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  cryptoExchange: DataExchange;
  indicators: IndicatorConfig[];
  compareOverlays?: CompareOverlayConfig[];
  theme: "dark" | "light";
  layout?: Partial<WorkspaceLayout>;
  charts?: WorkspaceChart[];
  activeChartId?: string;
  mode?: WorkspaceMode;
  drawings?: WorkspaceDrawingScope[];
  selectedStrategy?: WorkspaceStrategySelection;
}

export interface WorkspaceFile {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: typeof WORKSPACE_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  exportedAt: number;
  workspace: Workspace;
  metadata?: {
    clientId: string;
    name: string;
    schemaVersion: number;
  };
}

export type WorkspaceFileRejection =
  | "too_large"
  | "invalid_json"
  | "invalid_envelope"
  | "unsupported_version"
  | "invalid_checksum"
  | "invalid_workspace";

export type WorkspaceFileParseResult = { ok: true; workspace: Workspace } | { ok: false; reason: WorkspaceFileRejection };

const defaultLayout: WorkspaceLayout = {
  preset: "single",
  leftOpen: true,
  rightOpen: true,
  leftSize: 260,
  rightSize: 280,
  panelsSwapped: false
};

export function loadWorkspaces(ownerId?: string): Workspace[] {
  if (ownerId === "") return [];
  const key = ownerId ? `${WORKSPACES_KEY}:${ownerId}` : WORKSPACES_KEY;
  if (ownerId && !retryMigratedWorkspaceCleanup(ownerId)) claimLegacyWorkspaces(ownerId, key);
  const source = readWorkspaces(key);
  if (!ownerId) return source;
  const cached = readWorkspaces(`${WORKSPACES_CACHE_KEY}:${ownerId}`);
  const merged = new Map(source.map((workspace) => [workspace.id, workspace]));
  cached.forEach((workspace) => merged.set(workspace.id, workspace));
  return [...merged.values()];
}

function readWorkspaces(key: string): Workspace[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeWorkspace).filter((item): item is Workspace => item !== undefined);
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: Workspace[], ownerId?: string) {
  if (ownerId === "") return;
  try {
    window.localStorage.setItem(ownerId ? `${WORKSPACES_CACHE_KEY}:${ownerId}` : WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}

export function loadKnownRemoteWorkspaceIds(ownerId: string): string[] {
  if (!ownerId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(`${WORKSPACES_REMOTE_IDS_KEY}:${ownerId}`) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => validWorkspaceIdentifier(id, 160)).slice(-1_000) : [];
  } catch {
    return [];
  }
}

export function saveKnownRemoteWorkspaceIds(ownerId: string, ids: Iterable<string>): void {
  if (!ownerId) return;
  try {
    const normalized = [...new Set(ids)].filter((id) => validWorkspaceIdentifier(id, 160)).slice(-1_000);
    localStorage.setItem(`${WORKSPACES_REMOTE_IDS_KEY}:${ownerId}`, JSON.stringify(normalized));
  } catch {
    // A missing tombstone cache may cause a safe re-pull, never cross-owner access.
  }
}

export function loadLastActiveWorkspaceId(ownerId?: string): string | undefined {
  if (ownerId === "") return undefined;
  try {
    const value = localStorage.getItem(ownerId ? `${LAST_ACTIVE_WORKSPACE_KEY}:${ownerId}` : LAST_ACTIVE_WORKSPACE_KEY);
    return validWorkspaceIdentifier(value, 160) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastActiveWorkspaceId(id: string | undefined, ownerId?: string): void {
  if (ownerId === "") return;
  try {
    const key = ownerId ? `${LAST_ACTIVE_WORKSPACE_KEY}:${ownerId}` : LAST_ACTIVE_WORKSPACE_KEY;
    if (id && validWorkspaceIdentifier(id, 160)) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // The server workspace itself remains durable.
  }
}

function claimLegacyWorkspaces(ownerId: string, scopedKey: string): void {
  try {
    if (!claimLegacyTenantLocalData(localStorage, ownerId)) return;
    if (localStorage.getItem(WORKSPACES_CLAIM_KEY) !== ownerId || localStorage.getItem(scopedKey) !== null) return;
    localStorage.setItem(scopedKey, JSON.stringify(readWorkspaces(WORKSPACES_KEY)));
  } catch {
    // A failed claim is retried only for the same owner and never exposed to a second account.
  }
}

export function captureWorkspace(name: string, context: WorkspaceContext, now = Date.now()): Workspace {
  const snapshot = snapshotFromContext(context, 1, now);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: `ws-${now}-${Math.random().toString(36).slice(2, 7)}`,
    name: normalizeWorkspaceName(name, MAX_WORKSPACE_NAME_LENGTH),
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
  const portable = portableWorkspace(workspace);
  const payload = canonicalStringify(portable);
  const file: WorkspaceFile = {
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    algorithm: "SHA-256",
    checksum: await browserSha256(payload),
    exportedAt: now,
    workspace: portable
  };
  return JSON.stringify(file);
}

export async function parseWorkspaceFile(raw: string): Promise<Workspace | undefined> {
  const result = await parseWorkspaceFileDetailed(raw);
  return result.ok ? result.workspace : undefined;
}

export async function parseWorkspaceFileDetailed(raw: string): Promise<WorkspaceFileParseResult> {
  if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_FILE_BYTES) return { ok: false, reason: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || !hasOnlyKeys(parsed, ["format", "version", "algorithm", "checksum", "exportedAt", "workspace", "metadata"])) return { ok: false, reason: "invalid_envelope" };
  const file = parsed as Partial<WorkspaceFile>;
  if (file.format !== WORKSPACE_FILE_FORMAT || file.version !== WORKSPACE_FILE_VERSION || file.algorithm !== "SHA-256") return { ok: false, reason: "unsupported_version" };
  if (!Number.isSafeInteger(file.exportedAt) || Number(file.exportedAt) < 0 || typeof file.checksum !== "string" || !/^[0-9a-f]{64}$/.test(file.checksum)) return { ok: false, reason: "invalid_envelope" };
  if (workspaceDocumentBytes(file.workspace) > MAX_WORKSPACE_DOCUMENT_BYTES) return { ok: false, reason: "too_large" };
  if (!strictWorkspaceFileMetadata(file.metadata, file.workspace, MAX_WORKSPACE_NAME_LENGTH)) return { ok: false, reason: "invalid_envelope" };
  if ((await browserSha256(canonicalStringify(file.workspace))) !== file.checksum) return { ok: false, reason: "invalid_checksum" };
  const importedSchema = file.workspace && typeof file.workspace === "object" ? Number((file.workspace as { schemaVersion?: unknown }).schemaVersion) : Number.NaN;
  if (importedSchema > WORKSPACE_SCHEMA_VERSION) return { ok: false, reason: "unsupported_version" };
  const validShape = importedSchema === WORKSPACE_SCHEMA_VERSION
    ? strictWorkspaceShape(file.workspace, WORKSPACE_SCHEMA_VERSION, MAX_WORKSPACE_REVISIONS, MAX_WORKSPACE_INDICATORS)
    : strictLegacyWorkspaceShape(file.workspace, MAX_WORKSPACE_REVISIONS);
  if (!validShape) return { ok: false, reason: "invalid_workspace" };
  const workspace = normalizeWorkspace(file.workspace);
  if (!workspace) return { ok: false, reason: "invalid_workspace" };
  return { ok: true, workspace };
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
  const charts = context.charts?.length ? context.charts.map(cloneChart) : [defaultChart(context.symbol, context.timeframe, context.chartType)];
  const indicators = normalizeWorkspaceIndicators(context.indicators, MAX_WORKSPACE_INDICATORS);
  return {
    revision,
    savedAt,
    mode: normalizeWorkspaceMode(context.mode),
    symbol: context.symbol,
    timeframe: context.timeframe,
    chartType: context.chartType,
    cryptoExchange: context.cryptoExchange,
    enabledIndicators: indicators.filter((indicator) => indicator.enabled).map((indicator) => indicator.id),
    indicators,
    compareOverlays: normalizeCompareOverlays(context.compareOverlays, context.timeframe, context.chartType),
    theme: context.theme,
    layout,
    charts,
    activeChartId: charts.some((chart) => chart.id === context.activeChartId) ? context.activeChartId : charts[0]?.id,
    drawings: normalizeWorkspaceDrawingScopes(context.drawings, charts),
    selectedStrategy: normalizeWorkspaceStrategySelection(context.selectedStrategy)
  };
}

export function normalizeWorkspace(value: unknown): Workspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<Workspace>;
  if (!validWorkspaceIdentifier(item.id, 160) || typeof item.name !== "string" || !validWorkspaceSymbol(item.symbol)) return undefined;
  if (!isWorkspaceTimeframe(item.timeframe) || !isWorkspaceChartType(item.chartType) || !Array.isArray(item.enabledIndicators)) return undefined;
  const createdAt = finiteNumber(item.createdAt, Date.now());
  const revision = Math.max(1, finiteNumber(item.revision, 1));
  const savedAt = finiteNumber(item.savedAt, createdAt);
  const layout = normalizeLayout(item.layout);
  const charts = Array.isArray(item.charts)
    ? item.charts.map((chart, index) => normalizeChart(chart, item.schemaVersion === WORKSPACE_SCHEMA_VERSION, index === 0, item.schemaVersion === WORKSPACE_SCHEMA_VERSION ? DEFAULT_CHART_TIME_ZONE : LEGACY_CHART_TIME_ZONE)).filter((chart): chart is WorkspaceChart => chart !== undefined)
    : [];
  const base: Workspace = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: item.id,
    name: normalizeWorkspaceName(item.name, MAX_WORKSPACE_NAME_LENGTH),
    mode: normalizeWorkspaceMode(item.mode),
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    cryptoExchange: item.cryptoExchange === "bybit" ? "bybit" : "binance",
    enabledIndicators: item.enabledIndicators.filter((id): id is string => typeof id === "string"),
    indicators: normalizeWorkspaceIndicators(item.indicators, MAX_WORKSPACE_INDICATORS),
    compareOverlays: normalizeCompareOverlays(item.compareOverlays, item.timeframe, item.chartType),
    theme: item.theme === "light" ? "light" : "dark",
    revision,
    savedAt,
    createdAt,
    updatedAt: finiteNumber(item.updatedAt, savedAt),
    archivedAt: typeof item.archivedAt === "number" && Number.isFinite(item.archivedAt) ? item.archivedAt : undefined,
    layout,
    charts: charts.length ? charts : [defaultChart(item.symbol, item.timeframe, item.chartType, item.schemaVersion === WORKSPACE_SCHEMA_VERSION ? DEFAULT_CHART_TIME_ZONE : LEGACY_CHART_TIME_ZONE)],
    activeChartId: undefined,
    drawings: [],
    selectedStrategy: normalizeWorkspaceStrategySelection(item.selectedStrategy),
    history: []
  };
  base.activeChartId = base.charts.some((chart) => chart.id === item.activeChartId) ? item.activeChartId : base.charts[0]?.id;
  base.drawings = normalizeWorkspaceDrawingScopes(item.drawings, base.charts);
  base.history = Array.isArray(item.history)
    ? item.history
        .map((entry) => normalizeRevision(entry, base))
        .filter((entry): entry is WorkspaceRevision => entry !== undefined)
        .slice(-MAX_WORKSPACE_REVISIONS)
    : [];
  return base;
}

function normalizeRevision(value: unknown, fallback: Workspace): WorkspaceRevision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<WorkspaceRevision>;
  if (!validWorkspaceSymbol(item.symbol) || !isWorkspaceTimeframe(item.timeframe) || !isWorkspaceChartType(item.chartType)) return undefined;
  const charts = Array.isArray(item.charts) ? item.charts.map((chart, index) => normalizeChart(chart, false, index === 0, LEGACY_CHART_TIME_ZONE)).filter((chart): chart is WorkspaceChart => chart !== undefined) : [];
  const normalizedCharts = charts.length ? charts : [defaultChart(item.symbol, item.timeframe, item.chartType, LEGACY_CHART_TIME_ZONE)];
  const indicators = normalizeWorkspaceIndicators(item.indicators, MAX_WORKSPACE_INDICATORS);
  return {
    revision: Math.max(1, finiteNumber(item.revision, 1)),
    savedAt: finiteNumber(item.savedAt, fallback.createdAt),
    mode: normalizeWorkspaceMode(item.mode),
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    cryptoExchange: item.cryptoExchange === "bybit" ? "bybit" : "binance",
    enabledIndicators: indicators.length
      ? indicators.filter((indicator) => indicator.enabled).map((indicator) => indicator.id)
      : Array.isArray(item.enabledIndicators) ? item.enabledIndicators.filter((id): id is string => typeof id === "string") : [],
    indicators,
    compareOverlays: normalizeCompareOverlays(item.compareOverlays, item.timeframe, item.chartType),
    theme: item.theme === "light" ? "light" : "dark",
    layout: normalizeLayout(item.layout),
    charts: normalizedCharts,
    activeChartId: normalizedCharts.some((chart) => chart.id === item.activeChartId) ? item.activeChartId : normalizedCharts[0]?.id,
    drawings: normalizeWorkspaceDrawingScopes(item.drawings, normalizedCharts),
    selectedStrategy: normalizeWorkspaceStrategySelection(item.selectedStrategy)
  };
}

function normalizeLayout(value?: Partial<WorkspaceLayout>): WorkspaceLayout {
  return {
    preset: value?.preset === "split-vertical" || value?.preset === "split-horizontal" || value?.preset === "grid-4" ? value.preset : "single",
    leftOpen: typeof value?.leftOpen === "boolean" ? value.leftOpen : true,
    rightOpen: typeof value?.rightOpen === "boolean" ? value.rightOpen : true,
    leftSize: clamp(finiteNumber(value?.leftSize, defaultLayout.leftSize), 180, 520),
    rightSize: clamp(finiteNumber(value?.rightSize, defaultLayout.rightSize), 220, 520),
    panelsSwapped: value?.panelsSwapped === true
  };
}

function normalizeChart(value: unknown, missingLinkChartType: boolean, primary: boolean, fallbackTimeZone: ChartTimeZone): WorkspaceChart | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<WorkspaceChart>;
  if (!validWorkspaceIdentifier(item.id, 64) || !validWorkspaceSymbol(item.symbol) || !isWorkspaceTimeframe(item.timeframe) || !isWorkspaceChartType(item.chartType)) return undefined;
  const linkIndicators = item.linkIndicators !== false;
  const linkCompare = item.linkCompare !== false;
  return {
    id: item.id,
    symbol: item.symbol,
    timeframe: item.timeframe,
    chartType: item.chartType,
    exchange: item.exchange === "binance" || item.exchange === "bybit" ? item.exchange : undefined,
    marketType: item.marketType === "linear" || item.marketType === "inverse" ? item.marketType : "spot",
    priceType: item.priceType === "mark" || item.priceType === "index" ? item.priceType : "last",
    timeZone: normalizeChartTimeZone(item.timeZone, fallbackTimeZone),
    linkChartType: primary || (typeof item.linkChartType === "boolean" ? item.linkChartType : missingLinkChartType),
    linkGroup: typeof item.linkGroup === "string" ? item.linkGroup : undefined,
    linkSymbol: item.linkSymbol !== false,
    linkTimeframe: item.linkTimeframe !== false,
    linkCrosshair: item.linkCrosshair !== false,
    linkTimeRange: item.linkTimeRange !== false,
    linkIndicators,
    indicatorOverrides: linkIndicators ? undefined : normalizePaneIndicatorOverrides(item.indicatorOverrides),
    linkCompare,
    compareOverlays: linkCompare ? undefined : normalizeCompareOverlays(item.compareOverlays, item.timeframe, item.chartType)
  };
}

function defaultChart(symbol: string, timeframe: Timeframe, chartType: ChartType, timeZone = DEFAULT_CHART_TIME_ZONE): WorkspaceChart {
  return { id: "chart-1", symbol, timeframe, chartType, timeZone, linkChartType: true, linkGroup: "primary", linkSymbol: true, linkTimeframe: true, linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true };
}

function toRevision(workspace: Workspace): WorkspaceRevision {
  return cloneRevision(workspace);
}

function cloneRevision(revision: WorkspaceRevision): WorkspaceRevision {
  return {
    revision: revision.revision,
    savedAt: revision.savedAt,
    mode: revision.mode,
    symbol: revision.symbol,
    timeframe: revision.timeframe,
    chartType: revision.chartType,
    cryptoExchange: revision.cryptoExchange,
    enabledIndicators: [...revision.enabledIndicators],
    indicators: revision.indicators.map(cloneIndicator),
    compareOverlays: revision.compareOverlays.map((overlay) => ({ ...overlay })),
    theme: revision.theme,
    layout: { ...revision.layout },
    charts: revision.charts.map(cloneChart),
    activeChartId: revision.activeChartId,
    drawings: revision.drawings.map((scope) => ({ chartId: scope.chartId, symbol: scope.symbol, drawings: scope.drawings.map(cloneDrawing) })),
    selectedStrategy: revision.selectedStrategy
      ? { ...revision.selectedStrategy, parameters: { ...revision.selectedStrategy.parameters } }
      : undefined
  };
}

function cloneChart(chart: WorkspaceChart): WorkspaceChart {
  return {
    ...chart,
    marketType: chart.marketType ?? "spot",
    priceType: chart.priceType ?? "last",
    timeZone: chart.timeZone ?? DEFAULT_CHART_TIME_ZONE,
    indicatorOverrides: chart.indicatorOverrides?.map((override) => ({ ...override })),
    compareOverlays: chart.compareOverlays?.map((overlay) => ({ ...overlay }))
  };
}

function revisionFingerprint(revision: WorkspaceRevision): string {
  const { revision: _revision, savedAt: _savedAt, ...state } = cloneRevision(revision);
  return canonicalStringify(state);
}

export function workspaceContentFingerprint(workspace: Workspace): string {
  return revisionFingerprint(workspace);
}

export function workspaceRemotePayload(workspace: Workspace): Workspace {
  return { ...portableWorkspace(workspace), history: [] };
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function cloneIndicator(indicator: IndicatorConfig): IndicatorConfig {
  return { ...indicator };
}

function cloneDrawing(drawing: DrawingObject): DrawingObject {
  return { ...drawing, points: drawing.points.map((point) => ({ ...point })) as DrawingObject["points"], style: { ...drawing.style, levels: drawing.style.levels ? [...drawing.style.levels] : undefined } };
}

function portableWorkspace(workspace: Workspace): Workspace {
  return boundWorkspaceHistory({ ...workspace, archivedAt: undefined, history: workspace.history.slice(-MAX_WORKSPACE_REVISIONS).map(cloneRevision), ...cloneRevision(workspace) });
}
