import {
  parseScreenerDefinitionV1,
  SCREENER_DEFINITION_SCHEMA_V1,
  SCREENER_FILTER_LIMIT_V1,
  type ScreenerDefinitionV1,
  type ScreenerFilterKindV1,
  type ScreenerFilterV1,
  type ScreenerMaCrossStateV1,
  type ScreenerMacdConditionV1,
  type ScreenerMaTypeV1,
  type ScreenerSortDirectionV1,
  type ScreenerSortKeyV1,
  type ScreenerThresholdConditionV1,
  type ScreenerTimeframeV1
} from "@saltanatbotv2/contracts";

/**
 * Editable draft of one screener filter. Decimal fields stay strings so the
 * form never rounds user input; the contract parser is the single validator.
 */
export interface ScreenerFilterDraft {
  id: string;
  kind: ScreenerFilterKindV1;
  min: string;
  max: string;
  period: string;
  condition: ScreenerThresholdConditionV1;
  value: string;
  fastType: ScreenerMaTypeV1;
  fastPeriod: string;
  slowType: ScreenerMaTypeV1;
  slowPeriod: string;
  state: ScreenerMaCrossStateV1;
  fast: string;
  slow: string;
  signal: string;
  macdCondition: ScreenerMacdConditionV1;
}

export interface ScreenerFormState {
  timeframe: ScreenerTimeframeV1;
  universeLimit: number;
  sortKey: ScreenerSortKeyV1;
  sortDirection: ScreenerSortDirectionV1;
  filters: ScreenerFilterDraft[];
}

export type ScreenerDefinitionBuild = { ok: true; definition: ScreenerDefinitionV1 } | { ok: false };

const KIND_DEFAULTS: Record<ScreenerFilterKindV1, Partial<ScreenerFilterDraft>> = {
  price: {},
  "quote-volume-24h": { min: "1000000" },
  "change-24h-percent": { min: "1" },
  rsi: { period: "14", condition: "below", value: "30" },
  "ma-cross": {},
  macd: {},
  "atr-percent": { period: "14", condition: "above", value: "2" }
};

export function createFilterDraft(kind: ScreenerFilterKindV1, now = Date.now()): ScreenerFilterDraft {
  return {
    id: draftId(now),
    kind,
    min: "",
    max: "",
    period: "14",
    condition: "above",
    value: "",
    fastType: "ema",
    fastPeriod: "20",
    slowType: "sma",
    slowPeriod: "50",
    state: "crossed-up",
    fast: "12",
    slow: "26",
    signal: "9",
    macdCondition: "histogram-above-zero",
    ...KIND_DEFAULTS[kind]
  };
}

export function defaultScreenerFormState(): ScreenerFormState {
  return {
    timeframe: "1h",
    universeLimit: 100,
    sortKey: "quoteVolume24h",
    sortDirection: "desc",
    filters: [createFilterDraft("quote-volume-24h")]
  };
}

export function buildScreenerDefinition(state: ScreenerFormState, name: string): ScreenerDefinitionBuild {
  try {
    const definition = parseScreenerDefinitionV1({
      schemaVersion: SCREENER_DEFINITION_SCHEMA_V1,
      kind: "technical",
      name: name.trim(),
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      timeframe: state.timeframe,
      universeLimit: state.universeLimit,
      sort: { key: state.sortKey, direction: state.sortDirection },
      filters: state.filters.slice(0, SCREENER_FILTER_LIMIT_V1).map(draftToFilter),
      researchOnly: true,
      executionPermission: false
    });
    return { ok: true, definition };
  } catch {
    return { ok: false };
  }
}

export function formStateFromDefinition(definition: ScreenerDefinitionV1, now = Date.now()): ScreenerFormState {
  return {
    timeframe: definition.timeframe,
    universeLimit: definition.universeLimit,
    sortKey: definition.sort.key,
    sortDirection: definition.sort.direction,
    filters: definition.filters.map((filter, index) => draftFromFilter(filter, now + index))
  };
}

function draftToFilter(draft: ScreenerFilterDraft): Record<string, unknown> {
  if (draft.kind === "price") return { kind: "price", ...optionalDecimal("min", draft.min), ...optionalDecimal("max", draft.max) };
  if (draft.kind === "quote-volume-24h") return { kind: "quote-volume-24h", min: draft.min.trim() };
  if (draft.kind === "change-24h-percent") return { kind: "change-24h-percent", ...optionalDecimal("min", draft.min), ...optionalDecimal("max", draft.max) };
  if (draft.kind === "rsi") return { kind: "rsi", period: integerInput(draft.period), condition: draft.condition, value: draft.value.trim() };
  if (draft.kind === "ma-cross") {
    return {
      kind: "ma-cross",
      fastType: draft.fastType,
      fastPeriod: integerInput(draft.fastPeriod),
      slowType: draft.slowType,
      slowPeriod: integerInput(draft.slowPeriod),
      state: draft.state
    };
  }
  if (draft.kind === "macd") return { kind: "macd", fast: integerInput(draft.fast), slow: integerInput(draft.slow), signal: integerInput(draft.signal), condition: draft.macdCondition };
  return { kind: "atr-percent", period: integerInput(draft.period), condition: draft.condition, value: draft.value.trim() };
}

function draftFromFilter(filter: ScreenerFilterV1, now: number): ScreenerFilterDraft {
  const draft = createFilterDraft(filter.kind, now);
  if (filter.kind === "price" || filter.kind === "change-24h-percent") {
    draft.min = filter.min ?? "";
    draft.max = filter.max ?? "";
  } else if (filter.kind === "quote-volume-24h") {
    draft.min = filter.min;
  } else if (filter.kind === "rsi" || filter.kind === "atr-percent") {
    draft.period = String(filter.period);
    draft.condition = filter.condition;
    draft.value = filter.value;
  } else if (filter.kind === "ma-cross") {
    draft.fastType = filter.fastType;
    draft.fastPeriod = String(filter.fastPeriod);
    draft.slowType = filter.slowType;
    draft.slowPeriod = String(filter.slowPeriod);
    draft.state = filter.state;
  } else {
    draft.fast = String(filter.fast);
    draft.slow = String(filter.slow);
    draft.signal = String(filter.signal);
    draft.macdCondition = filter.condition;
  }
  return draft;
}

function optionalDecimal(key: "min" | "max", raw: string): Record<string, string> {
  const trimmed = raw.trim();
  return trimmed === "" ? {} : { [key]: trimmed };
}

function integerInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!/^-?\d{1,9}$/.test(trimmed)) return trimmed;
  return Number(trimmed);
}

function draftId(now: number): string {
  const time = Math.max(0, Math.trunc(now)).toString(36);
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `filter-${time}-${random}`;
}
