import { TOOL_POINT_COUNT, type DrawingObject, type DrawingStyle, type ShapeTool } from "./drawings";

const LEGACY_PREFIX = "mf:drawings:";
const STORAGE_PREFIX = "sbv2:drawings:v2:";
export const MAX_DRAWINGS_PER_PANE = 500;

/** Drawings follow a symbol across timeframes, but never leak into another chart pane. */
export function drawingStorageKey(symbol: string, chartId = "chart-1"): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(validSegment(chartId, "chart-1"))}:${encodeURIComponent(validSegment(symbol, "unknown"))}`;
}

export function loadDrawings(symbol: string, chartId = "chart-1"): DrawingObject[] {
  try {
    const key = drawingStorageKey(symbol, chartId);
    const current = window.localStorage.getItem(key);
    if (current) return parseDrawings(current);

    // Version 1 stored one set per symbol. Preserve it only in the primary pane;
    // secondary panes intentionally start empty instead of inheriting drawings.
    if (chartId !== "chart-1") return [];
    const legacyKey = `${LEGACY_PREFIX}${symbol}`;
    const legacy = window.localStorage.getItem(legacyKey);
    if (!legacy) return [];
    const migrated = parseDrawings(legacy);
    try {
      if (migrated.length > 0) window.localStorage.setItem(key, JSON.stringify(migrated));
      window.localStorage.removeItem(legacyKey);
    } catch {
      // Keep the validated runtime snapshot when migration persistence is unavailable.
    }
    return migrated;
  } catch {
    return [];
  }
}

export function saveDrawings(symbol: string, drawings: DrawingObject[], chartId = "chart-1") {
  try {
    const key = drawingStorageKey(symbol, chartId);
    const normalized = normalizeDrawings(drawings);
    if (normalized.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(normalized));
  } catch {
    // Non-fatal: private mode etc.
  }
}

export function normalizeDrawings(value: unknown): DrawingObject[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const normalized: DrawingObject[] = [];
  for (const item of value) {
    const drawing = normalizeDrawing(item);
    if (!drawing || ids.has(drawing.id)) continue;
    ids.add(drawing.id);
    normalized.push(drawing);
    if (normalized.length >= MAX_DRAWINGS_PER_PANE) break;
  }
  return normalized;
}

function parseDrawings(raw: string): DrawingObject[] {
  try {
    return normalizeDrawings(JSON.parse(raw));
  } catch {
    return [];
  }
}

function normalizeDrawing(value: unknown): DrawingObject | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<DrawingObject>;
  if (!validText(item.id, 128) || !isShapeTool(item.tool) || !Array.isArray(item.points) || item.points.length !== TOOL_POINT_COUNT[item.tool]) return undefined;
  const points = item.points.map((point) => {
    if (!point || typeof point !== "object") return undefined;
    const time = finite((point as { time?: unknown }).time);
    const price = finite((point as { price?: unknown }).price);
    return time === undefined || price === undefined ? undefined : { time, price };
  });
  if (points.some((point) => point === undefined)) return undefined;
  const style = normalizeStyle(item.style, item.tool);
  if (!style) return undefined;
  return { id: item.id, tool: item.tool, points: points as DrawingObject["points"], style, locked: item.locked === true || undefined, hidden: item.hidden === true || undefined };
}

function normalizeStyle(value: unknown, tool: ShapeTool): DrawingStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<DrawingStyle>;
  if (!validText(item.color, 64) || typeof item.width !== "number" || !Number.isFinite(item.width)) return undefined;
  const levels = Array.isArray(item.levels) ? item.levels.filter((level): level is number => typeof level === "number" && Number.isFinite(level)).slice(0, 20) : undefined;
  return {
    color: item.color,
    width: clamp(item.width, 0.5, 8),
    dashed: item.dashed === true || undefined,
    fill: validText(item.fill, 128) ? item.fill : undefined,
    extendLeft: item.extendLeft === true || undefined,
    extendRight: item.extendRight === true || undefined,
    levels: (tool === "fib" || tool === "anchored-vwap") && levels?.length ? levels : undefined
  };
}

function isShapeTool(value: unknown): value is ShapeTool {
  return typeof value === "string" && value in TOOL_POINT_COUNT;
}

function validSegment(value: string, fallback: string): string {
  return validText(value.trim(), 64) ? value.trim() : fallback;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
