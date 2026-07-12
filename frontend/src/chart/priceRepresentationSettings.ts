import type { ChartType } from "../types";
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

export const PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY = "mf:price-representation-settings:v1";
export const PRICE_REPRESENTATION_SETTINGS_EVENT = "mf:price-representation-settings-change";

export function sanitizePriceRepresentationSettings(value: unknown): PriceRepresentationSettings {
  const candidate = value && typeof value === "object" ? value as Partial<PriceRepresentationSettings> : {};
  return {
    renkoBrickPercent: clampNumber(candidate.renkoBrickPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.renkoBrickPercent, 2),
    lineBreakDepth: clampNumber(candidate.lineBreakDepth, 1, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.lineBreakDepth, 0),
    kagiReversalPercent: clampNumber(candidate.kagiReversalPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.kagiReversalPercent, 2),
    pnfBoxPercent: clampNumber(candidate.pnfBoxPercent, 0.01, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.pnfBoxPercent, 2),
    pnfReversalBoxes: clampNumber(candidate.pnfReversalBoxes, 1, 10, DEFAULT_PRICE_REPRESENTATION_SETTINGS.pnfReversalBoxes, 0)
  };
}

export function loadPriceRepresentationSettings(): PriceRepresentationSettings {
  try {
    return sanitizePriceRepresentationSettings(JSON.parse(localStorage.getItem(PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_PRICE_REPRESENTATION_SETTINGS };
  }
}

export function storePriceRepresentationSettings(settings: PriceRepresentationSettings) {
  const safe = sanitizePriceRepresentationSettings(settings);
  try {
    localStorage.setItem(PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY, JSON.stringify(safe));
  } catch { /* storage can be unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PRICE_REPRESENTATION_SETTINGS_EVENT, { detail: safe }));
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
