import {
  GRID_GEOMETRIC_MAX_RATIO_V1,
  GRID_LEVELS_MAXIMUM_V1,
  GRID_LEVELS_MINIMUM_V1,
  GRID_MAX_COOLDOWN_SECONDS_V1,
  GRID_MAX_CYCLES_MAXIMUM_V1,
  GRID_PARAMS_SCHEMA_V1,
  GRID_PRICE_MAXIMUM_V1,
  GRID_QUOTE_MAXIMUM_V1,
  gridLevelPrices,
  parseGridParamsV1,
  worstCaseGridCapitalQuote,
  type GridParamsV1
} from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { GridMessageKey } from "../i18n/grid";
import type { PaperMoney } from "./paperPortfolioTypes";

/** Text-input draft of grid-params-v1; empty optional fields mean "omitted". */
export interface GridDraft {
  mode: "neutral" | "long" | "short";
  spacing: "arithmetic" | "geometric";
  lowerBound: string;
  upperBound: string;
  gridLevels: string;
  orderQuote: string;
  outsideRangeAction: "pause" | "stop";
  stopLossPrice: string;
  maxCycles: string;
  cooldownSeconds: string;
}

export type GridDraftField = keyof GridDraft;

export interface GridDraftIssue {
  key: GridMessageKey;
  values?: Record<string, string>;
}

export interface GridLevelPreview {
  price: number;
  side: "buy" | "sell";
}

export interface GridDraftEvaluation {
  params?: GridParamsV1;
  /** Worst-case committed capital (quote USDT) for valid params. */
  worstCaseQuote?: number;
  /** Deterministic level ladder for the form preview, lowest price first. */
  levels?: GridLevelPreview[];
  errors: Partial<Record<GridDraftField, GridDraftIssue>>;
}

export const DEFAULT_GRID_DRAFT: GridDraft = {
  mode: "neutral",
  spacing: "arithmetic",
  lowerBound: "100",
  upperBound: "200",
  gridLevels: "10",
  orderQuote: "100",
  outsideRangeAction: "pause",
  stopLossPrice: "",
  maxCycles: "",
  cooldownSeconds: "300"
};

/** Validates every field against the shared contract bounds and parses canonically. */
export function evaluateGridDraft(draft: GridDraft): GridDraftEvaluation {
  const errors: Partial<Record<GridDraftField, GridDraftIssue>> = {};
  const lowerBound = positive(draft.lowerBound, "lowerBound", GRID_PRICE_MAXIMUM_V1, errors);
  const upperBound = positive(draft.upperBound, "upperBound", GRID_PRICE_MAXIMUM_V1, errors);
  const gridLevels = integer(draft.gridLevels, "gridLevels", GRID_LEVELS_MINIMUM_V1, GRID_LEVELS_MAXIMUM_V1, errors);
  const orderQuote = positive(draft.orderQuote, "orderQuote", GRID_QUOTE_MAXIMUM_V1, errors);
  const stopLossPrice = draft.stopLossPrice.trim() === "" ? undefined : positive(draft.stopLossPrice, "stopLossPrice", GRID_PRICE_MAXIMUM_V1, errors);
  const maxCycles = draft.maxCycles.trim() === "" ? undefined : integer(draft.maxCycles, "maxCycles", 1, GRID_MAX_CYCLES_MAXIMUM_V1, errors);
  const cooldownSeconds = integer(draft.cooldownSeconds, "cooldownSeconds", 0, GRID_MAX_COOLDOWN_SECONDS_V1, errors);
  if (lowerBound !== undefined && upperBound !== undefined) {
    if (lowerBound >= upperBound) {
      errors.upperBound = { key: "errBoundOrder" };
    } else if (draft.spacing === "geometric" && upperBound / lowerBound > GRID_GEOMETRIC_MAX_RATIO_V1) {
      errors.upperBound = { key: "errGeometricRatio" };
    }
  }
  if (stopLossPrice !== undefined && lowerBound !== undefined && upperBound !== undefined && !errors.upperBound
    && (draft.mode === "short" ? stopLossPrice <= upperBound : stopLossPrice >= lowerBound)) {
    errors.stopLossPrice = { key: draft.mode === "short" ? "errStopLossAboveUpper" : "errStopLossBelowLower" };
  }
  if (Object.keys(errors).length > 0) return { errors };
  try {
    const params = parseGridParamsV1({
      schemaVersion: GRID_PARAMS_SCHEMA_V1,
      mode: draft.mode,
      spacing: draft.spacing,
      lowerBound,
      upperBound,
      gridLevels,
      orderQuote,
      outsideRangeAction: draft.outsideRangeAction,
      ...(stopLossPrice === undefined ? {} : { stopLossPrice }),
      ...(maxCycles === undefined ? {} : { maxCycles }),
      cooldownSeconds,
      researchOnly: true,
      executionPermission: false
    });
    return {
      params,
      worstCaseQuote: worstCaseGridCapitalQuote(params, PAPER_FILL_MODEL_V1.feePct),
      levels: previewGridLevels(params),
      errors
    };
  } catch {
    return { errors: { lowerBound: { key: "fixParams" } } };
  }
}

/**
 * Indicative preview ladder for the create form: long grids buy every level,
 * short grids sell every level, and neutral grids split at the range midpoint
 * (arithmetic mean for arithmetic spacing, geometric mean for geometric). The
 * actual sides at start depend on the market price when the robot begins.
 */
export function previewGridLevels(params: GridParamsV1): GridLevelPreview[] {
  const midpoint = params.spacing === "arithmetic"
    ? (params.lowerBound + params.upperBound) / 2
    : Math.sqrt(params.lowerBound * params.upperBound);
  return gridLevelPrices(params).map((price) => ({
    price,
    side: params.mode === "long" ? "buy" : params.mode === "short" ? "sell" : price < midpoint ? "buy" : "sell"
  }));
}

/** Mirrors the server acceptance rule: round the worst case to micros and compare. */
export function gridWorstCaseExceeds(worstCaseQuote: number, capital: PaperMoney): boolean {
  return Math.round(worstCaseQuote * 1_000_000) > paperMoneyMicrosNumber(capital);
}

function paperMoneyMicrosNumber(value: PaperMoney): number {
  const match = /^(-?)(0|[1-9]\d*)\.(\d{6})$/.exec(value);
  if (!match) return Number.NaN;
  const micros = Number(match[2]) * 1_000_000 + Number(match[3]);
  return match[1] === "-" ? -micros : micros;
}

function parseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positive(
  value: string,
  field: GridDraftField,
  maximum: number,
  errors: Partial<Record<GridDraftField, GridDraftIssue>>
): number | undefined {
  const parsed = parseNumber(value);
  if (parsed === undefined || parsed <= 0 || parsed > maximum) {
    errors[field] = { key: "errAboveZeroMax", values: { max: String(maximum) } };
    return undefined;
  }
  return parsed;
}

function integer(
  value: string,
  field: GridDraftField,
  minimum: number,
  maximum: number,
  errors: Partial<Record<GridDraftField, GridDraftIssue>>
): number | undefined {
  const parsed = parseNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors[field] = { key: "errIntegerRange", values: { min: String(minimum), max: String(maximum) } };
    return undefined;
  }
  return parsed;
}
