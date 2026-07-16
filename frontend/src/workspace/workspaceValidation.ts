import type { BaseIndicatorConfig, IndicatorConfig } from "../chart/indicatorTypes";
import { normalizeDrawings } from "../chart/drawingStore";
import { TOOL_POINT_COUNT } from "../chart/drawings";
import { CHART_TIME_ZONES } from "../chart/timeAxis";
import type { ChartType, Timeframe } from "../types";
import type {
  WorkspaceChart,
  WorkspaceDrawingScope,
  WorkspaceMode,
  WorkspaceStrategySelection
} from "./workspaces";

export function normalizeWorkspaceName(value: string, maximum: number): string {
  return Array.from(value.trim()).filter((character) => !isControlCharacter(character)).join("").slice(0, maximum) || "Workspace";
}

export function normalizeWorkspaceMode(value: unknown): WorkspaceMode {
  return value === "strategy" || value === "trade" || value === "screener" ? value : "chart";
}

export function normalizeWorkspaceDrawingScopes(value: unknown, charts: WorkspaceChart[]): WorkspaceDrawingScope[] {
  const source = Array.isArray(value) ? value : [];
  const byScope = new Map<string, WorkspaceDrawingScope>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const scope = item as Partial<WorkspaceDrawingScope>;
    if (!validWorkspaceIdentifier(scope.chartId, 64) || !validWorkspaceSymbol(scope.symbol)) continue;
    const key = `${scope.chartId}\u0000${scope.symbol}`;
    if (byScope.has(key)) continue;
    byScope.set(key, { chartId: scope.chartId, symbol: scope.symbol, drawings: normalizeDrawings(scope.drawings) });
  }
  return charts.map((chart) => byScope.get(`${chart.id}\u0000${chart.symbol}`) ?? { chartId: chart.id, symbol: chart.symbol, drawings: [] });
}

export function normalizeWorkspaceStrategySelection(value: unknown): WorkspaceStrategySelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<WorkspaceStrategySelection>;
  if (!validWorkspaceIdentifier(item.id, 160) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) return undefined;
  const parameters: Record<string, number> = {};
  if (item.parameters && typeof item.parameters === "object" && !Array.isArray(item.parameters)) {
    for (const [key, parameter] of Object.entries(item.parameters).slice(0, 128)) {
      if (validWorkspaceIdentifier(key, 128) && typeof parameter === "number" && Number.isFinite(parameter)) parameters[key] = parameter;
    }
  }
  return {
    id: item.id,
    revision: Number(item.revision),
    hash: typeof item.hash === "string" && /^[0-9a-f]{8,128}$/i.test(item.hash) ? item.hash.toLowerCase() : undefined,
    parameters
  };
}

export function normalizeWorkspaceIndicators(value: unknown, maximum: number): IndicatorConfig[] {
  if (!Array.isArray(value)) return [];
  const result: IndicatorConfig[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const indicator = normalizeIndicator(entry);
    if (!indicator || ids.has(indicator.id)) continue;
    ids.add(indicator.id);
    result.push(indicator);
    if (result.length >= maximum) break;
  }
  return result;
}

function normalizeIndicator(value: unknown): IndicatorConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!validWorkspaceIdentifier(item.id, 128) || !validText(item.label, 120) || !validColor(item.color)) return undefined;
  const base: BaseIndicatorConfig = {
    id: item.id,
    label: item.label,
    enabled: item.enabled === true,
    visible: item.visible === false ? false : undefined,
    pane: item.pane === "main" || item.pane === "separate" ? item.pane : "auto",
    scalePlacement: item.scalePlacement === "left" || item.scalePlacement === "hidden" ? item.scalePlacement : "right",
    logicCode: validText(item.logicCode, 100_000) ? item.logicCode : undefined,
    logicXml: validText(item.logicXml, 100_000) ? item.logicXml : undefined,
    logicVersion: positiveInteger(item.logicVersion),
    logicHash: typeof item.logicHash === "string" && /^[0-9a-f]{64}$/i.test(item.logicHash) ? item.logicHash.toLowerCase() : undefined,
    color: item.color
  };
  const period = boundedNumber(item.period, 1, 100_000);
  if (item.kind === "sma" || item.kind === "ema" || item.kind === "rsi" || item.kind === "vwap" || item.kind === "atr") {
    return period === undefined ? undefined : { ...base, kind: item.kind, period };
  }
  if (item.kind === "bollinger") {
    const deviation = boundedNumber(item.deviation, 0.01, 100);
    return period === undefined || deviation === undefined || !validColor(item.bandColor) ? undefined : { ...base, kind: "bollinger", period, deviation, bandColor: item.bandColor };
  }
  if (item.kind === "macd") {
    const fast = boundedNumber(item.fast, 1, 100_000);
    const slow = boundedNumber(item.slow, 1, 100_000);
    const signal = boundedNumber(item.signal, 1, 100_000);
    return fast === undefined || slow === undefined || signal === undefined || !validColor(item.signalColor) || !validColor(item.histogramUp) || !validColor(item.histogramDown)
      ? undefined
      : { ...base, kind: "macd", fast, slow, signal, signalColor: item.signalColor, histogramUp: item.histogramUp, histogramDown: item.histogramDown };
  }
  if (item.kind === "stochastic") {
    const smooth = boundedNumber(item.smooth, 1, 100_000);
    return period === undefined || smooth === undefined || !validColor(item.signalColor) ? undefined : { ...base, kind: "stochastic", period, smooth, signalColor: item.signalColor };
  }
  if (item.kind === "obv") return { ...base, kind: "obv" };
  return undefined;
}

export function strictWorkspaceShape(
  value: unknown,
  schemaVersion: number,
  maximumRevisions: number,
  maximumIndicators: number
): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion", "id", "name", "createdAt", "updatedAt", "history",
    "revision", "savedAt", "mode", "symbol", "timeframe", "chartType", "cryptoExchange",
    "enabledIndicators", "indicators", "compareOverlays", "theme", "layout", "charts",
    "activeChartId", "drawings", "selectedStrategy"
  ];
  if (!hasOnlyKeys(item, allowed) || item.schemaVersion !== schemaVersion || !Array.isArray(item.history) || item.history.length > maximumRevisions) return false;
  if (!validWorkspaceIdentifier(item.id, 160) || !validText(item.name, 120) || !nonnegativeNumber(item.createdAt) || !nonnegativeNumber(item.updatedAt)) return false;
  if (!strictRevision(item, maximumIndicators, true)) return false;
  const revisionKeys = allowed.filter((key) => !["schemaVersion", "id", "name", "createdAt", "updatedAt", "history"].includes(key));
  return item.history.every((entry) => Boolean(entry) && typeof entry === "object" && hasOnlyKeys(entry as object, revisionKeys) && strictRevision(entry as Record<string, unknown>, maximumIndicators, true));
}

export function strictLegacyWorkspaceShape(value: unknown, maximumRevisions: number): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const schemaVersion = item.schemaVersion;
  if (schemaVersion !== 7) return false;
  const allowed = [
    "schemaVersion", "id", "name", "createdAt", "updatedAt", "history",
    "revision", "savedAt", "symbol", "timeframe", "chartType", "cryptoExchange",
    "enabledIndicators", "compareOverlays", "theme", "layout", "charts"
  ];
  if (!hasOnlyKeys(item, allowed) || !Array.isArray(item.history) || item.history.length > maximumRevisions) return false;
  if (!validWorkspaceIdentifier(item.id, 160) || !validText(item.name, 120) || !nonnegativeNumber(item.createdAt) || !nonnegativeNumber(item.updatedAt)) return false;
  if (!strictLegacyRevision(item)) return false;
  const revisionKeys = allowed.filter((key) => !["schemaVersion", "id", "name", "createdAt", "updatedAt", "history"].includes(key));
  return item.history.every((entry) => Boolean(entry) && typeof entry === "object" && hasOnlyKeys(entry as object, revisionKeys) && strictLegacyRevision(entry as Record<string, unknown>));
}

export function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

export function strictWorkspaceFileMetadata(metadata: unknown, workspace: unknown, maximumName: number): boolean {
  if (metadata === undefined) return true;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !hasOnlyKeys(metadata, ["clientId", "name", "schemaVersion"])) return false;
  const item = metadata as Record<string, unknown>;
  const payload = workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : undefined;
  return validWorkspaceIdentifier(item.clientId, 160)
    && validText(item.name, maximumName)
    && item.name.trim() === item.name
    && Number.isSafeInteger(item.schemaVersion)
    && Number(item.schemaVersion) >= 1
    && Number(item.schemaVersion) <= 10_000
    && payload?.id === item.clientId
    && payload.name === item.name
    && payload.schemaVersion === item.schemaVersion;
}

export function validWorkspaceIdentifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function validWorkspaceSymbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !Array.from(value).some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function validColor(value: unknown): value is string {
  return validText(value, 128);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

export function isWorkspaceTimeframe(value: unknown): value is Timeframe {
  return value === "1m" || value === "5m" || value === "15m" || value === "30m" || value === "1h" || value === "2h" || value === "4h" || value === "1d" || value === "1w" || value === "1M";
}

export function isWorkspaceChartType(value: unknown): value is ChartType {
  return value === "candles" || value === "hollow" || value === "heikin" || value === "bars" || value === "line" || value === "step" || value === "area" || value === "baseline" || value === "renko" || value === "linebreak" || value === "kagi" || value === "pnf";
}

function strictRevision(item: Record<string, unknown>, maximumIndicators: number, current: boolean): boolean {
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || !nonnegativeNumber(item.savedAt)) return false;
  if (current && item.mode !== "chart" && item.mode !== "strategy" && item.mode !== "trade" && item.mode !== "screener") return false;
  if (item.cryptoExchange !== "binance" && item.cryptoExchange !== "bybit") return false;
  if (item.theme !== "dark" && item.theme !== "light") return false;
  if (!validWorkspaceSymbol(item.symbol) || !isWorkspaceTimeframe(item.timeframe) || !isWorkspaceChartType(item.chartType)) return false;
  if (!strictLayout(item.layout)) return false;
  if (!Array.isArray(item.enabledIndicators) || item.enabledIndicators.length > 128 || item.enabledIndicators.some((id) => !validWorkspaceIdentifier(id, 128))) return false;
  const charts = item.charts;
  if (current && (!Array.isArray(charts) || charts.length < 1 || charts.length > 4)) return false;
  if (charts !== undefined && (!Array.isArray(charts) || charts.length > 4 || !uniqueIds(charts) || charts.some((chart) => !strictChart(chart)))) return false;
  const indicators = item.indicators;
  if (current && (!Array.isArray(indicators) || indicators.length > maximumIndicators)) return false;
  if (indicators !== undefined && (!Array.isArray(indicators) || indicators.length > maximumIndicators || !uniqueIds(indicators) || indicators.some((indicator) => !strictIndicator(indicator)))) return false;
  if (current) {
    const indicatorIds = new Set((indicators as Record<string, unknown>[]).map((indicator) => indicator.id));
    if ((item.enabledIndicators as string[]).some((id) => !indicatorIds.has(id))) return false;
  }
  if (!strictCompareList(item.compareOverlays)) return false;
  const drawings = item.drawings;
  if (current && (!Array.isArray(drawings) || drawings.length !== (charts as unknown[]).length)) return false;
  if (drawings !== undefined && (!Array.isArray(drawings) || drawings.length > 4 || drawings.some((scope) => !strictDrawingScope(scope)))) return false;
  if (current && !drawingScopesMatchCharts(drawings as unknown[], charts as unknown[])) return false;
  if (current && item.activeChartId !== undefined && !(charts as Record<string, unknown>[]).some((chart) => chart.id === item.activeChartId)) return false;
  return item.selectedStrategy === undefined || strictStrategySelection(item.selectedStrategy);
}

function strictChart(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const allowed = ["id", "symbol", "timeframe", "chartType", "exchange", "marketType", "priceType", "timeZone", "linkChartType", "linkGroup", "linkSymbol", "linkTimeframe", "linkCrosshair", "linkTimeRange", "linkIndicators", "indicatorOverrides", "linkCompare", "compareOverlays"];
  const booleans = ["linkChartType", "linkSymbol", "linkTimeframe", "linkCrosshair", "linkTimeRange", "linkIndicators", "linkCompare"];
  return hasOnlyKeys(item, allowed)
    && validWorkspaceIdentifier(item.id, 64)
    && validWorkspaceSymbol(item.symbol)
    && isWorkspaceTimeframe(item.timeframe)
    && isWorkspaceChartType(item.chartType)
    && (item.exchange === undefined || item.exchange === "binance" || item.exchange === "bybit")
    && (item.marketType === undefined || item.marketType === "spot" || item.marketType === "linear" || item.marketType === "inverse")
    && (item.priceType === undefined || item.priceType === "last" || item.priceType === "mark" || item.priceType === "index")
    && (item.timeZone === undefined || CHART_TIME_ZONES.includes(item.timeZone as typeof CHART_TIME_ZONES[number]))
    && booleans.every((key) => typeof item[key] === "boolean")
    && (item.linkGroup === undefined || validWorkspaceIdentifier(item.linkGroup, 64))
    && (item.indicatorOverrides === undefined || strictIndicatorOverrides(item.indicatorOverrides))
    && (item.compareOverlays === undefined || strictCompareList(item.compareOverlays));
}

function strictIndicator(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const base = ["id", "label", "enabled", "visible", "pane", "scalePlacement", "logicCode", "logicXml", "logicVersion", "logicHash", "color", "kind"];
  if (!validWorkspaceIdentifier(item.id, 128) || !validText(item.label, 120) || typeof item.enabled !== "boolean" || !validText(item.color, 128)) return false;
  if (item.visible !== undefined && typeof item.visible !== "boolean") return false;
  if (item.pane !== undefined && item.pane !== "auto" && item.pane !== "main" && item.pane !== "separate") return false;
  if (item.scalePlacement !== undefined && item.scalePlacement !== "left" && item.scalePlacement !== "right" && item.scalePlacement !== "hidden") return false;
  if (item.logicCode !== undefined && !validText(item.logicCode, 100_000)) return false;
  if (item.logicXml !== undefined && !validText(item.logicXml, 100_000)) return false;
  if (item.logicVersion !== undefined && positiveInteger(item.logicVersion) === undefined) return false;
  if (item.logicHash !== undefined && (typeof item.logicHash !== "string" || !/^[0-9a-f]{64}$/i.test(item.logicHash))) return false;
  if (item.kind === "obv") return hasOnlyKeys(item, base);
  if (item.kind === "sma" || item.kind === "ema" || item.kind === "rsi" || item.kind === "vwap" || item.kind === "atr") {
    return hasOnlyKeys(item, [...base, "period"]) && bounded(item.period, 1, 100_000);
  }
  if (item.kind === "bollinger") return hasOnlyKeys(item, [...base, "period", "deviation", "bandColor"]) && bounded(item.period, 1, 100_000) && bounded(item.deviation, 0.01, 100) && validText(item.bandColor, 128);
  if (item.kind === "stochastic") return hasOnlyKeys(item, [...base, "period", "smooth", "signalColor"]) && bounded(item.period, 1, 100_000) && bounded(item.smooth, 1, 100_000) && validText(item.signalColor, 128);
  if (item.kind === "macd") return hasOnlyKeys(item, [...base, "fast", "slow", "signal", "signalColor", "histogramUp", "histogramDown"]) && bounded(item.fast, 1, 100_000) && bounded(item.slow, 1, 100_000) && bounded(item.signal, 1, 100_000) && validText(item.signalColor, 128) && validText(item.histogramUp, 128) && validText(item.histogramDown, 128);
  return false;
}

function strictCompareList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 3
    && value.every((entry) => {
      if (!entry || typeof entry !== "object" || !hasOnlyKeys(entry, ["id", "symbol", "timeframe", "chartType", "color", "upColor", "downColor"])) return false;
      const item = entry as Record<string, unknown>;
      return validWorkspaceIdentifier(item.id, 128)
        && validWorkspaceSymbol(item.symbol)
        && isWorkspaceTimeframe(item.timeframe)
        && (item.chartType === "candles" || item.chartType === "hollow" || item.chartType === "heikin" || item.chartType === "bars" || item.chartType === "line" || item.chartType === "step" || item.chartType === "area" || item.chartType === "baseline")
        && validText(item.color, 128)
        && validText(item.upColor, 128)
        && validText(item.downColor, 128);
    });
}

function strictDrawingScope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return hasOnlyKeys(item, ["chartId", "symbol", "drawings"])
    && validWorkspaceIdentifier(item.chartId, 64)
    && validWorkspaceSymbol(item.symbol)
    && Array.isArray(item.drawings)
    && item.drawings.length <= 500
    && item.drawings.every(strictDrawing);
}

function strictDrawing(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const tool = typeof item.tool === "string" && item.tool in TOOL_POINT_COUNT ? item.tool as keyof typeof TOOL_POINT_COUNT : undefined;
  return hasOnlyKeys(item, ["id", "tool", "points", "style", "locked", "hidden"])
    && validText(item.id, 128)
    && tool !== undefined
    && Array.isArray(item.points)
    && item.points.length === TOOL_POINT_COUNT[tool]
    && item.points.every((point) => Boolean(point) && typeof point === "object" && hasOnlyKeys(point as object, ["time", "price"]) && finiteNumber((point as Record<string, unknown>).time) && finiteNumber((point as Record<string, unknown>).price))
    && Boolean(item.style)
    && typeof item.style === "object"
    && strictDrawingStyle(item.style as object)
    && (item.locked === undefined || typeof item.locked === "boolean")
    && (item.hidden === undefined || typeof item.hidden === "boolean");
}

function strictStrategySelection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!hasOnlyKeys(item, ["id", "revision", "hash", "parameters"]) || !validWorkspaceIdentifier(item.id, 160) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) return false;
  if (item.hash !== undefined && (typeof item.hash !== "string" || !/^[0-9a-f]{8,128}$/i.test(item.hash))) return false;
  if (!item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters) || Object.keys(item.parameters).length > 128) return false;
  return Object.entries(item.parameters as Record<string, unknown>).every(([key, parameter]) => validWorkspaceIdentifier(key, 128) && typeof parameter === "number" && Number.isFinite(parameter));
}

function drawingScopesMatchCharts(scopes: unknown[], charts: unknown[]): boolean {
  const expected = new Set(charts.map((chart) => {
    const item = chart as Record<string, unknown>;
    return `${item.id}\u0000${item.symbol}`;
  }));
  const actual = new Set(scopes.map((scope) => {
    const item = scope as Record<string, unknown>;
    return `${item.chartId}\u0000${item.symbol}`;
  }));
  return expected.size === actual.size && [...expected].every((key) => actual.has(key));
}

function uniqueIds(values: unknown[]): boolean {
  const ids = values.map((value) => (value as Record<string, unknown>)?.id);
  return ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length;
}

function strictLayout(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasOnlyKeys(value, ["preset", "leftOpen", "rightOpen", "leftSize", "rightSize", "panelsSwapped"])) return false;
  const item = value as Record<string, unknown>;
  return (item.preset === "single" || item.preset === "split-vertical" || item.preset === "split-horizontal" || item.preset === "grid-4")
    && typeof item.leftOpen === "boolean"
    && typeof item.rightOpen === "boolean"
    && bounded(item.leftSize, 180, 520)
    && bounded(item.rightSize, 220, 520)
    && typeof item.panelsSwapped === "boolean";
}

function strictDrawingStyle(value: object): boolean {
  if (!hasOnlyKeys(value, ["color", "width", "dashed", "fill", "extendLeft", "extendRight", "levels"])) return false;
  const item = value as Record<string, unknown>;
  return validText(item.color, 64)
    && bounded(item.width, 0.5, 8)
    && (item.dashed === undefined || typeof item.dashed === "boolean")
    && (item.fill === undefined || validText(item.fill, 128))
    && (item.extendLeft === undefined || typeof item.extendLeft === "boolean")
    && (item.extendRight === undefined || typeof item.extendRight === "boolean")
    && (item.levels === undefined || (Array.isArray(item.levels) && item.levels.length <= 20 && item.levels.every(finiteNumber)));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

function nonnegativeNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return finiteNumber(value) && value >= minimum && value <= maximum;
}

function strictIndicatorOverrides(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 32) return false;
  const allowed = ["id", "enabled", "visible", "pane", "scalePlacement", "color", "period", "deviation", "bandColor", "fast", "slow", "signal", "signalColor", "histogramUp", "histogramDown", "smooth"];
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || !hasOnlyKeys(entry, allowed)) return false;
    const item = entry as Record<string, unknown>;
    return validWorkspaceIdentifier(item.id, 128)
      && typeof item.enabled === "boolean"
      && (item.visible === undefined || typeof item.visible === "boolean")
      && (item.pane === undefined || item.pane === "auto" || item.pane === "main" || item.pane === "separate")
      && (item.scalePlacement === undefined || item.scalePlacement === "left" || item.scalePlacement === "right" || item.scalePlacement === "hidden")
      && (item.color === undefined || validText(item.color, 128))
      && (item.period === undefined || bounded(item.period, 1, 100_000))
      && (item.deviation === undefined || bounded(item.deviation, 0.01, 100))
      && (item.bandColor === undefined || validText(item.bandColor, 128))
      && (item.fast === undefined || bounded(item.fast, 1, 100_000))
      && (item.slow === undefined || bounded(item.slow, 1, 100_000))
      && (item.signal === undefined || bounded(item.signal, 1, 100_000))
      && (item.signalColor === undefined || validText(item.signalColor, 128))
      && (item.histogramUp === undefined || validText(item.histogramUp, 128))
      && (item.histogramDown === undefined || validText(item.histogramDown, 128))
      && (item.smooth === undefined || bounded(item.smooth, 1, 100_000));
  });
}

function strictLegacyRevision(item: Record<string, unknown>): boolean {
  return Number.isSafeInteger(item.revision)
    && Number(item.revision) >= 1
    && nonnegativeNumber(item.savedAt)
    && validWorkspaceSymbol(item.symbol)
    && isWorkspaceTimeframe(item.timeframe)
    && isWorkspaceChartType(item.chartType)
    && (item.cryptoExchange === "binance" || item.cryptoExchange === "bybit")
    && item.theme !== undefined
    && (item.theme === "dark" || item.theme === "light")
    && Array.isArray(item.enabledIndicators)
    && item.enabledIndicators.length <= 128
    && item.enabledIndicators.every((id) => validWorkspaceIdentifier(id, 128))
    && strictCompareList(item.compareOverlays)
    && strictLayout(item.layout)
    && Array.isArray(item.charts)
    && item.charts.length >= 1
    && item.charts.length <= 4
    && uniqueIds(item.charts)
    && item.charts.every(strictChart);
}
