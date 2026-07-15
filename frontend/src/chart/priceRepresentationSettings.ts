import type { ChartType } from "../types";
import { readTenantLocalItem, removeTenantLocalItem, tenantLocalStorageKey, writeTenantLocalItem } from "../app/tenantLocalStorage";
import { DEFAULT_KAGI_REVERSAL_PERCENT } from "./kagi";
import { DEFAULT_RENKO_BRICK_PERCENT } from "./renko";
import { DEFAULT_PNF_BOX_PERCENT, DEFAULT_PNF_REVERSAL_BOXES } from "./pointAndFigure";

export interface PriceRepresentationSettings {
  renkoBrickPercent: number;
  lineBreakDepth: number;
  kagiReversalPercent: number;
  pnfBoxPercent: number;
  pnfReversalBoxes: number;
}

export const DEFAULT_PRICE_REPRESENTATION_SETTINGS: PriceRepresentationSettings = {
  renkoBrickPercent: DEFAULT_RENKO_BRICK_PERCENT,
  lineBreakDepth: 3,
  kagiReversalPercent: DEFAULT_KAGI_REVERSAL_PERCENT,
  pnfBoxPercent: DEFAULT_PNF_BOX_PERCENT,
  pnfReversalBoxes: DEFAULT_PNF_REVERSAL_BOXES
};

export const LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY = "mf:price-representation-settings:v1";
export const PRICE_REPRESENTATION_SETTINGS_EVENT = "mf:price-representation-settings-change";
const STORAGE_PREFIX = "sbv2:price-representation-settings:v2:";
const MAX_STORAGE_BYTES = 4096;

export interface PriceRepresentationSettingsEventDetail {
  key: string;
  settings: PriceRepresentationSettings;
}

export function priceRepresentationSettingsStorageKey(symbol: string, chartId = "chart-1"): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(validSegment(chartId, "chart-1"))}:${encodeURIComponent(validSegment(symbol, "unknown"))}`;
}

export function sanitizePriceRepresentationSettings(value: unknown): PriceRepresentationSettings {
  const candidate = value && typeof value === "object" ? (value as Partial<PriceRepresentationSettings>) : {};
  return {
    renkoBrickPercent: clampNumber(candidate.renkoBrickPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.renkoBrickPercent, 2),
    lineBreakDepth: clampNumber(candidate.lineBreakDepth, 1, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.lineBreakDepth, 0),
    kagiReversalPercent: clampNumber(candidate.kagiReversalPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.kagiReversalPercent, 2),
    pnfBoxPercent: clampNumber(candidate.pnfBoxPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.pnfBoxPercent, 2),
    pnfReversalBoxes: clampNumber(candidate.pnfReversalBoxes, 1, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.pnfReversalBoxes, 0)
  };
}

export function loadPriceRepresentationSettings(symbol = "global", chartId = "chart-1", ownerId?: string): PriceRepresentationSettings {
  try {
    const key = priceRepresentationSettingsStorageKey(symbol, chartId);
    if (!tenantLocalStorageKey(key, ownerId)) return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
    const current = readTenantLocalItem(localStorage, key, ownerId);
    if (current) return parseSettings(current);
    if (chartId !== "chart-1") return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
    const legacy = readTenantLocalItem(localStorage, LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY, ownerId);
    if (!legacy) return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
    const migrated = parseSettings(legacy);
    try {
      writeTenantLocalItem(localStorage, key, JSON.stringify(migrated), ownerId);
      removeTenantLocalItem(localStorage, LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY, ownerId);
    } catch {
      /* keep the validated runtime snapshot */
    }
    return migrated;
  } catch {
    return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
  }
}

export function storePriceRepresentationSettings(settings: PriceRepresentationSettings, symbol = "global", chartId = "chart-1", ownerId?: string) {
  const safe = sanitizePriceRepresentationSettings(settings);
  const baseKey = priceRepresentationSettingsStorageKey(symbol, chartId);
  const key = tenantLocalStorageKey(baseKey, ownerId);
  try {
    writeTenantLocalItem(localStorage, baseKey, JSON.stringify(safe), ownerId);
  } catch {
    /* storage can be unavailable */
  }
  if (typeof window !== "undefined" && key) window.dispatchEvent(new CustomEvent<PriceRepresentationSettingsEventDetail>(PRICE_REPRESENTATION_SETTINGS_EVENT, { detail: { key, settings: safe } }));
}

export function priceRepresentationBadge(chartType: ChartType, settings = DEFAULT_PRICE_REPRESENTATION_SETTINGS) {
  if (chartType === "renko") return `RENKO ${settings.renkoBrickPercent.toFixed(2)}%`;
  if (chartType === "linebreak") return `${settings.lineBreakDepth}LB`;
  if (chartType === "kagi") return `KAGI ${settings.kagiReversalPercent.toFixed(2)}%`;
  if (chartType === "pnf") return `P&F ${settings.pnfBoxPercent.toFixed(2)}% ×${settings.pnfReversalBoxes}`;
  return "";
}

export function isConfigurablePriceRepresentation(chartType: ChartType) {
  return chartType === "renko" || chartType === "linebreak" || chartType === "kagi" || chartType === "pnf";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, decimals: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Number(Math.max(min, Math.min(max, number)).toFixed(decimals));
}

function parseSettings(raw: string): PriceRepresentationSettings {
  if (raw.length > MAX_STORAGE_BYTES) return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
  try {
    return sanitizePriceRepresentationSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
  }
}

function validSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && !Array.from(trimmed).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? trimmed : fallback;
}
