import { readTenantLocalItem, removeTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

export const SCANNER_WORKSPACE_STORAGE_KEY = "sbv2:arbitrage-workspace:v2";
export const LEGACY_SCANNER_WORKSPACE_STORAGE_KEY = "sbv2:arbitrage-workspace:v1";

export type ScannerMode = "basis" | "triangular" | "native";
export type ScannerVisualization = "table" | "heatmap" | "compare";
export type ScannerFilterValue = string | number | boolean;

export interface ScannerPreset {
  id: string;
  name: string;
  filters: Record<string, ScannerFilterValue>;
  columns: string[];
  visualization: ScannerVisualization;
  compareIds: [string, string];
  updatedAt: number;
}

export interface ScannerWorkspacePreferences {
  columns: string[];
  visualization: ScannerVisualization;
  compareIds: [string, string];
  presets: ScannerPreset[];
  selectedPresetId: string;
}

interface StoredEnvelope {
  version: 2;
  modes: Partial<Record<ScannerMode, unknown>>;
}

interface WorkspaceRules {
  allowedColumns: readonly string[];
  defaultColumns: readonly string[];
  requiredColumns: readonly string[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MAX_RAW_LENGTH = 65_536;
const MAX_PRESETS = 12;
const MAX_COLUMNS = 16;
const MAX_FILTERS = 24;
const MAX_NAME_LENGTH = 40;
const MAX_FILTER_STRING_LENGTH = 80;
const MAX_ID_LENGTH = 120;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000_000;
const VALID_MODES: ScannerMode[] = ["basis", "triangular", "native"];
const VALID_VISUALIZATIONS: ScannerVisualization[] = ["table", "heatmap", "compare"];

export function loadScannerWorkspace(mode: ScannerMode, allowedColumns: readonly string[], defaultColumns: readonly string[], requiredColumns: readonly string[] = [], storage = browserStorage(), ownerId?: string): ScannerWorkspacePreferences {
  const rules = { allowedColumns, defaultColumns, requiredColumns };
  const fallback = defaultWorkspace(rules);
  if (!storage) return fallback;
  const current = readRaw(storage, SCANNER_WORKSPACE_STORAGE_KEY, ownerId);
  const parsed = parseEnvelope(current);
  if (parsed) return sanitizeWorkspace(parsed.modes[mode], rules);

  const legacy = parseLegacyEnvelope(current) ?? parseLegacyEnvelope(readRaw(storage, LEGACY_SCANNER_WORKSPACE_STORAGE_KEY, ownerId));
  if (!legacy) return fallback;
  const migrated = sanitizeWorkspace(legacy.modes[mode], rules);
  const modes = Object.fromEntries(VALID_MODES.filter((key) => legacy.modes[key] !== undefined).map((key) => [key, legacy.modes[key]]));
  modes[mode] = migrated;
  if (!writeEnvelope(storage, { version: 2, modes }, ownerId)) writeEnvelope(storage, { version: 2, modes: { [mode]: migrated } }, ownerId);
  safeRemove(storage, LEGACY_SCANNER_WORKSPACE_STORAGE_KEY, ownerId);
  return migrated;
}

export function storeScannerWorkspace(mode: ScannerMode, preferences: ScannerWorkspacePreferences, allowedColumns: readonly string[], defaultColumns: readonly string[], requiredColumns: readonly string[] = [], storage = browserStorage(), ownerId?: string): ScannerWorkspacePreferences {
  const rules = { allowedColumns, defaultColumns, requiredColumns };
  const sanitized = sanitizeWorkspace(preferences, rules);
  if (!storage) return sanitized;
  const current = parseEnvelope(readRaw(storage, SCANNER_WORKSPACE_STORAGE_KEY, ownerId));
  if (!writeEnvelope(storage, { version: 2, modes: { ...(current?.modes ?? {}), [mode]: sanitized } }, ownerId)) {
    writeEnvelope(storage, { version: 2, modes: { [mode]: sanitized } }, ownerId);
  }
  return sanitized;
}

export function saveScannerPreset(preferences: ScannerWorkspacePreferences, name: string, filters: Record<string, ScannerFilterValue>, now = Date.now()): ScannerWorkspacePreferences {
  const safeName = cleanText(name, MAX_NAME_LENGTH);
  if (!safeName) return preferences;
  const preset: ScannerPreset = {
    id: createPresetId(now),
    name: safeName,
    filters: sanitizeFilters(filters),
    columns: preferences.columns.slice(0, MAX_COLUMNS),
    visualization: preferences.visualization,
    compareIds: sanitizeCompareIds(preferences.compareIds),
    updatedAt: clampInteger(now, 0, Number.MAX_SAFE_INTEGER)
  };
  const presets = [preset, ...preferences.presets].slice(0, MAX_PRESETS);
  return { ...preferences, presets, selectedPresetId: preset.id };
}

export function deleteScannerPreset(preferences: ScannerWorkspacePreferences, presetId: string): ScannerWorkspacePreferences {
  const presets = preferences.presets.filter((preset) => preset.id !== presetId);
  return { ...preferences, presets, selectedPresetId: preferences.selectedPresetId === presetId ? "" : preferences.selectedPresetId };
}

export function findScannerPreset(preferences: ScannerWorkspacePreferences, presetId: string): ScannerPreset | undefined {
  return preferences.presets.find((preset) => preset.id === presetId);
}

function sanitizeWorkspace(value: unknown, rules: WorkspaceRules): ScannerWorkspacePreferences {
  const input = record(value);
  const columns = sanitizeColumns(input?.columns, rules);
  const visualization = VALID_VISUALIZATIONS.includes(input?.visualization as ScannerVisualization) ? (input?.visualization as ScannerVisualization) : VALID_VISUALIZATIONS.includes(input?.view as ScannerVisualization) ? (input?.view as ScannerVisualization) : "table";
  const compareIds = sanitizeCompareIds(input?.compareIds);
  const rawPresets = Array.isArray(input?.presets) ? input.presets.slice(0, MAX_PRESETS * 2) : [];
  const seen = new Set<string>();
  const presets: ScannerPreset[] = [];
  for (const candidate of rawPresets) {
    const preset = sanitizePreset(candidate, rules);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
    if (presets.length >= MAX_PRESETS) break;
  }
  const selectedPresetId = cleanId(input?.selectedPresetId);
  return {
    columns,
    visualization,
    compareIds,
    presets,
    selectedPresetId: presets.some((preset) => preset.id === selectedPresetId) ? selectedPresetId : ""
  };
}

function sanitizePreset(value: unknown, rules: WorkspaceRules): ScannerPreset | undefined {
  const input = record(value);
  if (!input) return undefined;
  const id = cleanId(input.id);
  const name = cleanText(input.name, MAX_NAME_LENGTH);
  if (!id || !name) return undefined;
  const visualization = VALID_VISUALIZATIONS.includes(input.visualization as ScannerVisualization) ? (input.visualization as ScannerVisualization) : VALID_VISUALIZATIONS.includes(input.view as ScannerVisualization) ? (input.view as ScannerVisualization) : "table";
  return {
    id,
    name,
    filters: sanitizeFilters(input.filters),
    columns: sanitizeColumns(input.columns, rules),
    visualization,
    compareIds: sanitizeCompareIds(input.compareIds),
    updatedAt: clampInteger(input.updatedAt, 0, Number.MAX_SAFE_INTEGER)
  };
}

function sanitizeColumns(value: unknown, rules: WorkspaceRules): string[] {
  const allowed = new Set(rules.allowedColumns.slice(0, MAX_COLUMNS));
  const required = unique(rules.requiredColumns.filter((column) => allowed.has(column)));
  const source = Array.isArray(value) ? value : rules.defaultColumns;
  const selected = unique(source.filter((column): column is string => typeof column === "string" && allowed.has(column)));
  const wanted = new Set([...required, ...selected]);
  const combined = rules.allowedColumns.filter((column) => wanted.has(column)).slice(0, MAX_COLUMNS);
  if (combined.length > 0) return combined;
  const fallback = new Set([...required, ...rules.defaultColumns.filter((column) => allowed.has(column))]);
  return rules.allowedColumns.filter((column) => fallback.has(column)).slice(0, MAX_COLUMNS);
}

function sanitizeFilters(value: unknown): Record<string, ScannerFilterValue> {
  const input = record(value);
  if (!input) return {};
  const filters: Record<string, ScannerFilterValue> = {};
  for (const [key, raw] of Object.entries(input).slice(0, MAX_FILTERS)) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
    if (typeof raw === "boolean") filters[key] = raw;
    else if (typeof raw === "string") filters[key] = raw.slice(0, MAX_FILTER_STRING_LENGTH);
    else if (typeof raw === "number" && Number.isFinite(raw)) filters[key] = Math.max(-MAX_ABSOLUTE_NUMBER, Math.min(MAX_ABSOLUTE_NUMBER, raw));
  }
  return filters;
}

function sanitizeCompareIds(value: unknown): [string, string] {
  const values = Array.isArray(value) ? value : [];
  const first = cleanText(values[0], MAX_ID_LENGTH);
  const second = cleanText(values[1], MAX_ID_LENGTH);
  return [first, second === first ? "" : second];
}

function defaultWorkspace(rules: WorkspaceRules): ScannerWorkspacePreferences {
  return {
    columns: sanitizeColumns(rules.defaultColumns, rules),
    visualization: "table",
    compareIds: ["", ""],
    presets: [],
    selectedPresetId: ""
  };
}

function parseEnvelope(raw: string | undefined): StoredEnvelope | undefined {
  const value = parseJson(raw);
  const input = record(value);
  const modes = record(input?.modes);
  if (input?.version !== 2 || !modes) return undefined;
  return { version: 2, modes };
}

function parseLegacyEnvelope(raw: string | undefined): { modes: Partial<Record<ScannerMode, unknown>> } | undefined {
  const input = record(parseJson(raw));
  if (!input || (input.version !== 1 && input.version !== undefined)) return undefined;
  const modes = record(input.modes) ?? record(input.workspaces) ?? input;
  if (!VALID_MODES.some((mode) => modes[mode] !== undefined)) return undefined;
  return { modes };
}

function parseJson(raw: string | undefined): unknown {
  if (!raw || raw.length > MAX_RAW_LENGTH) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeEnvelope(storage: StorageLike, envelope: StoredEnvelope, ownerId?: string): boolean {
  try {
    const raw = JSON.stringify(envelope);
    if (raw.length > MAX_RAW_LENGTH) return false;
    writeTenantLocalItem(storage, SCANNER_WORKSPACE_STORAGE_KEY, raw, ownerId);
    return true;
  } catch {
    // Storage can be unavailable or full. Scanner state remains usable in memory.
    return false;
  }
}

function readRaw(storage: StorageLike, key: string, ownerId?: string): string | undefined {
  try {
    return readTenantLocalItem(storage, key, ownerId) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeRemove(storage: StorageLike, key: string, ownerId?: string) {
  try {
    removeTenantLocalItem(storage, key, ownerId);
  } catch {
    // A denied storage write must not break the scanner.
  }
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const cleaned = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code >= 160);
    })
    .join("")
    .trim();
  return [...cleaned].slice(0, limit).join("");
}

function cleanId(value: unknown): string {
  const id = cleanText(value, MAX_ID_LENGTH);
  return /^[a-zA-Z0-9:_-]+$/.test(id) ? id : "";
}

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : minimum;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function createPresetId(now: number): string {
  const time = Math.max(0, Math.trunc(now)).toString(36);
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `preset-${time}-${random}`;
}
