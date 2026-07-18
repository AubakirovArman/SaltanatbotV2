import {
  DCA_MAX_COOLDOWN_SECONDS_V1,
  DCA_MAX_CYCLE_DURATION_HOURS_V1,
  DCA_MAX_PRICE_DEVIATION_PCT_V1,
  DCA_MAX_SAFETY_ORDERS_V1,
  DCA_PARAMS_SCHEMA_V1,
  DCA_QUOTE_MAXIMUM_V1,
  DCA_SCALE_MAXIMUM_V1,
  DCA_SCALE_MINIMUM_V1,
  parseDcaParamsV1,
  worstCaseDcaCapitalQuote,
  type DcaParamsV1
} from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { DcaMessageKey } from "../i18n/dca";
import type { PaperMoney } from "./paperPortfolioTypes";

/** Text-input draft of dca-params-v1; empty optional fields mean "omitted". */
export interface DcaDraft {
  direction: "long" | "short";
  baseOrderQuote: string;
  safetyOrderQuote: string;
  maxSafetyOrders: string;
  priceDeviationPct: string;
  stepScale: string;
  volumeScale: string;
  takeProfitPct: string;
  stopLossPct: string;
  trailingTakeProfitPct: string;
  cooldownSeconds: string;
  maxCycleDurationHours: string;
}

export type DcaDraftField = keyof DcaDraft;

export interface DcaDraftIssue {
  key: DcaMessageKey;
  values?: Record<string, string>;
}

export interface DcaDraftEvaluation {
  params?: DcaParamsV1;
  /** Worst-case committed capital (quote USDT) for valid params. */
  worstCaseQuote?: number;
  errors: Partial<Record<DcaDraftField, DcaDraftIssue>>;
}

export const DEFAULT_DCA_DRAFT: DcaDraft = {
  direction: "long",
  baseOrderQuote: "100",
  safetyOrderQuote: "100",
  maxSafetyOrders: "5",
  priceDeviationPct: "1",
  stepScale: "1.4",
  volumeScale: "1.5",
  takeProfitPct: "1.5",
  stopLossPct: "",
  trailingTakeProfitPct: "",
  cooldownSeconds: "300",
  maxCycleDurationHours: ""
};

/** Validates every field against the shared contract bounds and parses canonically. */
export function evaluateDcaDraft(draft: DcaDraft): DcaDraftEvaluation {
  const errors: Partial<Record<DcaDraftField, DcaDraftIssue>> = {};
  const baseOrderQuote = positive(draft.baseOrderQuote, "baseOrderQuote", DCA_QUOTE_MAXIMUM_V1, errors);
  const safetyOrderQuote = positive(draft.safetyOrderQuote, "safetyOrderQuote", DCA_QUOTE_MAXIMUM_V1, errors);
  const maxSafetyOrders = integer(draft.maxSafetyOrders, "maxSafetyOrders", 0, DCA_MAX_SAFETY_ORDERS_V1, errors);
  const priceDeviationPct = positive(draft.priceDeviationPct, "priceDeviationPct", DCA_MAX_PRICE_DEVIATION_PCT_V1, errors);
  const stepScale = ranged(draft.stepScale, "stepScale", DCA_SCALE_MINIMUM_V1, DCA_SCALE_MAXIMUM_V1, errors);
  const volumeScale = ranged(draft.volumeScale, "volumeScale", DCA_SCALE_MINIMUM_V1, DCA_SCALE_MAXIMUM_V1, errors);
  const takeProfitPct = positive(draft.takeProfitPct, "takeProfitPct", 100, errors);
  const stopLossPct = draft.stopLossPct.trim() === "" ? undefined : positive(draft.stopLossPct, "stopLossPct", 100, errors);
  const trailingTakeProfitPct = draft.trailingTakeProfitPct.trim() === "" ? undefined : positive(draft.trailingTakeProfitPct, "trailingTakeProfitPct", 100, errors);
  const cooldownSeconds = integer(draft.cooldownSeconds, "cooldownSeconds", 0, DCA_MAX_COOLDOWN_SECONDS_V1, errors);
  const maxCycleDurationHours = draft.maxCycleDurationHours.trim() === ""
    ? undefined
    : integer(draft.maxCycleDurationHours, "maxCycleDurationHours", 1, DCA_MAX_CYCLE_DURATION_HOURS_V1, errors);
  if (trailingTakeProfitPct !== undefined && takeProfitPct !== undefined && trailingTakeProfitPct > takeProfitPct) {
    errors.trailingTakeProfitPct = { key: "errTrailingAboveTakeProfit" };
  }
  if (Object.keys(errors).length > 0) return { errors };
  try {
    const params = parseDcaParamsV1({
      schemaVersion: DCA_PARAMS_SCHEMA_V1,
      direction: draft.direction,
      baseOrderQuote,
      safetyOrderQuote,
      maxSafetyOrders,
      priceDeviationPct,
      stepScale,
      volumeScale,
      takeProfitPct,
      ...(stopLossPct === undefined ? {} : { stopLossPct }),
      ...(trailingTakeProfitPct === undefined ? {} : { trailingTakeProfitPct }),
      cooldownSeconds,
      ...(maxCycleDurationHours === undefined ? {} : { maxCycleDurationHours }),
      researchOnly: true,
      executionPermission: false
    });
    return { params, worstCaseQuote: worstCaseDcaCapitalQuote(params, PAPER_FILL_MODEL_V1.feePct), errors };
  } catch {
    return { errors: { baseOrderQuote: { key: "fixParams" } } };
  }
}

/** Mirrors the server acceptance rule: round the worst case to micros and compare. */
export function dcaWorstCaseExceeds(worstCaseQuote: number, capital: PaperMoney): boolean {
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
  field: DcaDraftField,
  maximum: number,
  errors: Partial<Record<DcaDraftField, DcaDraftIssue>>
): number | undefined {
  const parsed = parseNumber(value);
  if (parsed === undefined || parsed <= 0 || parsed > maximum) {
    errors[field] = { key: "errAboveZeroMax", values: { max: String(maximum) } };
    return undefined;
  }
  return parsed;
}

function ranged(
  value: string,
  field: DcaDraftField,
  minimum: number,
  maximum: number,
  errors: Partial<Record<DcaDraftField, DcaDraftIssue>>
): number | undefined {
  const parsed = parseNumber(value);
  if (parsed === undefined || parsed < minimum || parsed > maximum) {
    errors[field] = { key: "errNumberRange", values: { min: String(minimum), max: String(maximum) } };
    return undefined;
  }
  return parsed;
}

function integer(
  value: string,
  field: DcaDraftField,
  minimum: number,
  maximum: number,
  errors: Partial<Record<DcaDraftField, DcaDraftIssue>>
): number | undefined {
  const parsed = parseNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors[field] = { key: "errIntegerRange", values: { min: String(minimum), max: String(maximum) } };
    return undefined;
  }
  return parsed;
}
