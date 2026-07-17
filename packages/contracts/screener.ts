import type { DataExchange, DataMarketType, Timeframe } from "./index.js";

/** Public, research-only technical screener contracts shared by the API and browser. */

export const SCREENER_DEFINITION_SCHEMA_V1 = "screener-definition-v1" as const;
export const SCREENER_RUN_REQUEST_SCHEMA_V1 = "screener-run-request-v1" as const;
export const SCREENER_RUN_RESULT_SCHEMA_V1 = "screener-run-result-v1" as const;
export const SCREENER_PRESET_LIST_SCHEMA_V1 = "screener-preset-list-v1" as const;

export const SCREENER_TIMEFRAMES_V1 = ["5m", "15m", "1h", "4h", "1d"] as const;
export const SCREENER_SORT_KEYS_V1 = ["quoteVolume24h", "change24hPercent", "lastClose", "symbol", "rsi", "atrPercent"] as const;
export const SCREENER_FILTER_KINDS_V1 = ["price", "quote-volume-24h", "change-24h-percent", "rsi", "ma-cross", "macd", "atr-percent"] as const;
export const SCREENER_UNIVERSE_LIMIT_MINIMUM_V1 = 10;
export const SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1 = 200;
export const SCREENER_FILTER_LIMIT_V1 = 12;
export const SCREENER_RESULT_ROW_LIMIT_V1 = 100;

export type ScreenerDecimalV1 = string;
export type ScreenerTimeframeV1 = Extract<Timeframe, (typeof SCREENER_TIMEFRAMES_V1)[number]>;
/** MVP universe is Binance-only; the field keeps the shared venue taxonomy for later exchanges. */
export type ScreenerExchangeV1 = Extract<DataExchange, "binance">;
export type ScreenerMarketTypeV1 = Extract<DataMarketType, "spot">;
export type ScreenerSortKeyV1 = (typeof SCREENER_SORT_KEYS_V1)[number];
export type ScreenerSortDirectionV1 = "asc" | "desc";
export type ScreenerFilterKindV1 = (typeof SCREENER_FILTER_KINDS_V1)[number];
export type ScreenerMaTypeV1 = "ema" | "sma";
export type ScreenerMaCrossStateV1 = "fast-above" | "fast-below" | "crossed-up" | "crossed-down";
export type ScreenerMacdConditionV1 = "histogram-above-zero" | "histogram-below-zero" | "crossed-up" | "crossed-down";
export type ScreenerThresholdConditionV1 = "above" | "below";

export interface ScreenerPriceFilterV1 {
  kind: "price";
  min?: ScreenerDecimalV1;
  max?: ScreenerDecimalV1;
}

export interface ScreenerQuoteVolumeFilterV1 {
  kind: "quote-volume-24h";
  /** Minimum 24h quote-asset (USDT) turnover. */
  min: ScreenerDecimalV1;
}

export interface ScreenerChangePercentFilterV1 {
  kind: "change-24h-percent";
  min?: ScreenerDecimalV1;
  max?: ScreenerDecimalV1;
}

export interface ScreenerRsiFilterV1 {
  kind: "rsi";
  period: number;
  condition: ScreenerThresholdConditionV1;
  value: ScreenerDecimalV1;
}

export interface ScreenerMaCrossFilterV1 {
  kind: "ma-cross";
  fastType: ScreenerMaTypeV1;
  fastPeriod: number;
  slowType: ScreenerMaTypeV1;
  slowPeriod: number;
  state: ScreenerMaCrossStateV1;
}

export interface ScreenerMacdFilterV1 {
  kind: "macd";
  fast: number;
  slow: number;
  signal: number;
  condition: ScreenerMacdConditionV1;
}

export interface ScreenerAtrPercentFilterV1 {
  kind: "atr-percent";
  period: number;
  condition: ScreenerThresholdConditionV1;
  value: ScreenerDecimalV1;
}

export type ScreenerFilterV1 =
  | ScreenerPriceFilterV1
  | ScreenerQuoteVolumeFilterV1
  | ScreenerChangePercentFilterV1
  | ScreenerRsiFilterV1
  | ScreenerMaCrossFilterV1
  | ScreenerMacdFilterV1
  | ScreenerAtrPercentFilterV1;

export interface ScreenerSortV1 {
  key: ScreenerSortKeyV1;
  direction: ScreenerSortDirectionV1;
}

export interface ScreenerDefinitionV1 {
  schemaVersion: typeof SCREENER_DEFINITION_SCHEMA_V1;
  kind: "technical";
  name: string;
  exchange: ScreenerExchangeV1;
  marketType: ScreenerMarketTypeV1;
  priceType: "last";
  timeframe: ScreenerTimeframeV1;
  universeLimit: number;
  sort: ScreenerSortV1;
  filters: ScreenerFilterV1[];
  researchOnly: true;
  executionPermission: false;
}

/** Exactly one of definition or presetId; the worker resolves presets at execution time. */
export interface ScreenerRunRequestV1 {
  schemaVersion: typeof SCREENER_RUN_REQUEST_SCHEMA_V1;
  definition?: ScreenerDefinitionV1;
  presetId?: string;
  researchOnly: true;
  executionPermission: false;
}

export interface ScreenerUniverseSummaryV1 {
  requested: number;
  evaluated: number;
  matched: number;
  unavailable: number;
}

/** Indicator outputs on the last closed bar. Missing values mean unavailable, never zero. */
export interface ScreenerRowMetricsV1 {
  rsi?: ScreenerDecimalV1;
  atrPercent?: ScreenerDecimalV1;
  macdHistogram?: ScreenerDecimalV1;
  fastMa?: ScreenerDecimalV1;
  slowMa?: ScreenerDecimalV1;
}

export interface ScreenerRowV1 {
  symbol: string;
  lastClose: ScreenerDecimalV1;
  closedBarTime: number;
  change24hPercent?: ScreenerDecimalV1;
  quoteVolume24h?: ScreenerDecimalV1;
  metrics: ScreenerRowMetricsV1;
  matchedFilters: number;
}

export interface ScreenerRunResultV1 {
  schemaVersion: typeof SCREENER_RUN_RESULT_SCHEMA_V1;
  definitionHash: string;
  generatedAt: string;
  timeframe: ScreenerTimeframeV1;
  closedBarTimeMin: number;
  closedBarTimeMax: number;
  universe: ScreenerUniverseSummaryV1;
  unavailableReasons: Record<string, number>;
  rows: ScreenerRowV1[];
  rowsTruncated: boolean;
  researchOnly: true;
  executionPermission: false;
}

/** Owner-scoped public projection. Hash and authorization internals are never exposed. */
export interface ScreenerPresetV1 {
  id: string;
  clientId: string;
  revision: number;
  definition: ScreenerDefinitionV1;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  researchOnly: true;
  executionPermission: false;
}

export interface ScreenerPresetListV1 {
  schemaVersion: typeof SCREENER_PRESET_LIST_SCHEMA_V1;
  presets: ScreenerPresetV1[];
  generatedAt: string;
  researchOnly: true;
  executionPermission: false;
}

const SCREENER_TIMEFRAMES = new Set<string>(SCREENER_TIMEFRAMES_V1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._-]{1,29}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,18})?$/;

export function parseScreenerDefinitionV1(value: unknown): ScreenerDefinitionV1 {
  const input = object(value, "screener definition");
  exact(
    input,
    ["schemaVersion", "kind", "name", "exchange", "marketType", "priceType", "timeframe", "universeLimit", "sort", "filters", "researchOnly", "executionPermission"],
    [],
    "screener definition",
  );
  safety(input, SCREENER_DEFINITION_SCHEMA_V1, "screener definition");
  if (!Array.isArray(input.filters) || input.filters.length < 1 || input.filters.length > SCREENER_FILTER_LIMIT_V1) {
    throw new Error(`screener definition.filters must contain 1 to ${SCREENER_FILTER_LIMIT_V1} filters`);
  }
  return {
    schemaVersion: SCREENER_DEFINITION_SCHEMA_V1,
    kind: literal(input.kind, "technical", "screener definition.kind"),
    name: text(input.name, "screener definition.name", 1, 120),
    exchange: literal(input.exchange, "binance", "screener definition.exchange"),
    marketType: literal(input.marketType, "spot", "screener definition.marketType"),
    priceType: literal(input.priceType, "last", "screener definition.priceType"),
    timeframe: timeframe(input.timeframe, "screener definition.timeframe"),
    universeLimit: integer(input.universeLimit, "screener definition.universeLimit", SCREENER_UNIVERSE_LIMIT_MINIMUM_V1, SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1),
    sort: parseSort(input.sort, "screener definition.sort"),
    filters: input.filters.map((item, index) => parseScreenerFilterV1(item, `screener definition.filters[${index}]`)),
    researchOnly: true,
    executionPermission: false,
  };
}

export function parseScreenerFilterV1(value: unknown, label = "screener filter"): ScreenerFilterV1 {
  const input = object(value, label);
  const kind = input.kind;
  if (kind === "price") return parsePriceFilter(input, label);
  if (kind === "quote-volume-24h") return parseQuoteVolumeFilter(input, label);
  if (kind === "change-24h-percent") return parseChangePercentFilter(input, label);
  if (kind === "rsi") return parseRsiFilter(input, label);
  if (kind === "ma-cross") return parseMaCrossFilter(input, label);
  if (kind === "macd") return parseMacdFilter(input, label);
  if (kind === "atr-percent") return parseAtrPercentFilter(input, label);
  throw new Error(`${label}.kind is unsupported`);
}

export function parseScreenerRunRequestV1(value: unknown): ScreenerRunRequestV1 {
  const input = object(value, "screener run request");
  exact(input, ["schemaVersion", "researchOnly", "executionPermission"], ["definition", "presetId"], "screener run request");
  safety(input, SCREENER_RUN_REQUEST_SCHEMA_V1, "screener run request");
  if ((input.definition === undefined) === (input.presetId === undefined)) {
    throw new Error("screener run request requires exactly one of definition or presetId");
  }
  const result: ScreenerRunRequestV1 = {
    schemaVersion: SCREENER_RUN_REQUEST_SCHEMA_V1,
    researchOnly: true,
    executionPermission: false,
  };
  if (input.definition !== undefined) result.definition = parseScreenerDefinitionV1(input.definition);
  if (input.presetId !== undefined) result.presetId = uuid(input.presetId, "screener run request.presetId");
  return result;
}

export function parseScreenerRunResultV1(value: unknown): ScreenerRunResultV1 {
  const input = object(value, "screener run result");
  exact(
    input,
    ["schemaVersion", "definitionHash", "generatedAt", "timeframe", "closedBarTimeMin", "closedBarTimeMax", "universe", "unavailableReasons", "rows", "rowsTruncated", "researchOnly", "executionPermission"],
    [],
    "screener run result",
  );
  safety(input, SCREENER_RUN_RESULT_SCHEMA_V1, "screener run result");
  if (!Array.isArray(input.rows) || input.rows.length > SCREENER_RESULT_ROW_LIMIT_V1) {
    throw new Error(`screener run result.rows must contain at most ${SCREENER_RESULT_ROW_LIMIT_V1} rows`);
  }
  const closedBarTimeMin = integer(input.closedBarTimeMin, "screener run result.closedBarTimeMin", 0, Number.MAX_SAFE_INTEGER);
  const closedBarTimeMax = integer(input.closedBarTimeMax, "screener run result.closedBarTimeMax", 0, Number.MAX_SAFE_INTEGER);
  if (closedBarTimeMax < closedBarTimeMin) throw new Error("screener run result.closedBarTimeMax precedes closedBarTimeMin");
  return {
    schemaVersion: SCREENER_RUN_RESULT_SCHEMA_V1,
    definitionHash: pattern(input.definitionHash, "screener run result.definitionHash", HEX_64, 64, 64),
    generatedAt: timestamp(input.generatedAt, "screener run result.generatedAt"),
    timeframe: timeframe(input.timeframe, "screener run result.timeframe"),
    closedBarTimeMin,
    closedBarTimeMax,
    universe: parseUniverseSummary(input.universe, "screener run result.universe"),
    unavailableReasons: parseUnavailableReasons(input.unavailableReasons, "screener run result.unavailableReasons"),
    rows: input.rows.map((item, index) => parseScreenerRowV1(item, `screener run result.rows[${index}]`)),
    rowsTruncated: boolean(input.rowsTruncated, "screener run result.rowsTruncated"),
    researchOnly: true,
    executionPermission: false,
  };
}

export function parseScreenerRowV1(value: unknown, label = "screener row"): ScreenerRowV1 {
  const input = object(value, label);
  exact(input, ["symbol", "lastClose", "closedBarTime", "metrics", "matchedFilters"], ["change24hPercent", "quoteVolume24h"], label);
  const result: ScreenerRowV1 = {
    symbol: pattern(input.symbol, `${label}.symbol`, SYMBOL, 2, 30),
    lastClose: decimal(input.lastClose, `${label}.lastClose`, { positive: true }),
    closedBarTime: integer(input.closedBarTime, `${label}.closedBarTime`, 0, Number.MAX_SAFE_INTEGER),
    metrics: parseRowMetrics(input.metrics, `${label}.metrics`),
    matchedFilters: integer(input.matchedFilters, `${label}.matchedFilters`, 1, SCREENER_FILTER_LIMIT_V1),
  };
  if (input.change24hPercent !== undefined) result.change24hPercent = boundedDecimal(input.change24hPercent, `${label}.change24hPercent`, -100, 10_000);
  if (input.quoteVolume24h !== undefined) result.quoteVolume24h = boundedDecimal(input.quoteVolume24h, `${label}.quoteVolume24h`, 0, 1e15);
  return result;
}

export function parseScreenerPresetV1(value: unknown, label = "screener preset"): ScreenerPresetV1 {
  const input = object(value, label);
  exact(input, ["id", "clientId", "revision", "definition", "createdAt", "updatedAt", "researchOnly", "executionPermission"], ["archivedAt"], label);
  safetyFlags(input, label);
  const createdAt = timestamp(input.createdAt, `${label}.createdAt`);
  const updatedAt = timestamp(input.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error(`${label}.updatedAt precedes createdAt`);
  const result: ScreenerPresetV1 = {
    id: uuid(input.id, `${label}.id`),
    clientId: pattern(input.clientId, `${label}.clientId`, CLIENT_ID, 1, 160),
    revision: integer(input.revision, `${label}.revision`, 1, Number.MAX_SAFE_INTEGER),
    definition: parseScreenerDefinitionV1(input.definition),
    createdAt,
    updatedAt,
    researchOnly: true,
    executionPermission: false,
  };
  if (input.archivedAt !== undefined) {
    result.archivedAt = timestamp(input.archivedAt, `${label}.archivedAt`);
    if (Date.parse(result.archivedAt) < Date.parse(createdAt)) throw new Error(`${label}.archivedAt precedes createdAt`);
  }
  return result;
}

export function parseScreenerPresetListV1(value: unknown): ScreenerPresetListV1 {
  const input = object(value, "screener preset list");
  exact(input, ["schemaVersion", "presets", "generatedAt", "researchOnly", "executionPermission"], [], "screener preset list");
  safety(input, SCREENER_PRESET_LIST_SCHEMA_V1, "screener preset list");
  if (!Array.isArray(input.presets) || input.presets.length > 100) throw new Error("screener preset list.presets must contain at most 100 presets");
  return {
    schemaVersion: SCREENER_PRESET_LIST_SCHEMA_V1,
    presets: input.presets.map((item, index) => parseScreenerPresetV1(item, `screener preset list.presets[${index}]`)),
    generatedAt: timestamp(input.generatedAt, "screener preset list.generatedAt"),
    researchOnly: true,
    executionPermission: false,
  };
}

function parsePriceFilter(input: Record<string, unknown>, label: string): ScreenerPriceFilterV1 {
  exact(input, ["kind"], ["min", "max"], label);
  const result: ScreenerPriceFilterV1 = { kind: "price" };
  if (input.min !== undefined) result.min = boundedDecimal(input.min, `${label}.min`, 0, 1e15);
  if (input.max !== undefined) result.max = boundedDecimal(input.max, `${label}.max`, 0, 1e15);
  if (result.min === undefined && result.max === undefined) throw new Error(`${label} requires min or max`);
  if (result.min !== undefined && result.max !== undefined && Number(result.min) > Number(result.max)) throw new Error(`${label}.min exceeds max`);
  return result;
}

function parseQuoteVolumeFilter(input: Record<string, unknown>, label: string): ScreenerQuoteVolumeFilterV1 {
  exact(input, ["kind", "min"], [], label);
  return { kind: "quote-volume-24h", min: boundedDecimal(input.min, `${label}.min`, 0, 1e15) };
}

function parseChangePercentFilter(input: Record<string, unknown>, label: string): ScreenerChangePercentFilterV1 {
  exact(input, ["kind"], ["min", "max"], label);
  const result: ScreenerChangePercentFilterV1 = { kind: "change-24h-percent" };
  if (input.min !== undefined) result.min = boundedDecimal(input.min, `${label}.min`, -100, 10_000);
  if (input.max !== undefined) result.max = boundedDecimal(input.max, `${label}.max`, -100, 10_000);
  if (result.min === undefined && result.max === undefined) throw new Error(`${label} requires min or max`);
  if (result.min !== undefined && result.max !== undefined && Number(result.min) > Number(result.max)) throw new Error(`${label}.min exceeds max`);
  return result;
}

function parseRsiFilter(input: Record<string, unknown>, label: string): ScreenerRsiFilterV1 {
  exact(input, ["kind", "period", "condition", "value"], [], label);
  return {
    kind: "rsi",
    period: integer(input.period, `${label}.period`, 2, 200),
    condition: oneOf(input.condition, ["above", "below"] as const, `${label}.condition`),
    value: boundedDecimal(input.value, `${label}.value`, 0, 100),
  };
}

function parseMaCrossFilter(input: Record<string, unknown>, label: string): ScreenerMaCrossFilterV1 {
  exact(input, ["kind", "fastType", "fastPeriod", "slowType", "slowPeriod", "state"], [], label);
  const fastPeriod = integer(input.fastPeriod, `${label}.fastPeriod`, 1, 500);
  const slowPeriod = integer(input.slowPeriod, `${label}.slowPeriod`, 1, 500);
  if (fastPeriod >= slowPeriod) throw new Error(`${label}.fastPeriod must be below slowPeriod`);
  return {
    kind: "ma-cross",
    fastType: oneOf(input.fastType, ["ema", "sma"] as const, `${label}.fastType`),
    fastPeriod,
    slowType: oneOf(input.slowType, ["ema", "sma"] as const, `${label}.slowType`),
    slowPeriod,
    state: oneOf(input.state, ["fast-above", "fast-below", "crossed-up", "crossed-down"] as const, `${label}.state`),
  };
}

function parseMacdFilter(input: Record<string, unknown>, label: string): ScreenerMacdFilterV1 {
  exact(input, ["kind", "fast", "slow", "signal", "condition"], [], label);
  const fast = integer(input.fast, `${label}.fast`, 1, 200);
  const slow = integer(input.slow, `${label}.slow`, 2, 500);
  if (fast >= slow) throw new Error(`${label}.fast must be below slow`);
  return {
    kind: "macd",
    fast,
    slow,
    signal: integer(input.signal, `${label}.signal`, 1, 200),
    condition: oneOf(input.condition, ["histogram-above-zero", "histogram-below-zero", "crossed-up", "crossed-down"] as const, `${label}.condition`),
  };
}

function parseAtrPercentFilter(input: Record<string, unknown>, label: string): ScreenerAtrPercentFilterV1 {
  exact(input, ["kind", "period", "condition", "value"], [], label);
  return {
    kind: "atr-percent",
    period: integer(input.period, `${label}.period`, 2, 200),
    condition: oneOf(input.condition, ["above", "below"] as const, `${label}.condition`),
    value: boundedDecimal(input.value, `${label}.value`, 0, 1_000),
  };
}

function parseSort(value: unknown, label: string): ScreenerSortV1 {
  const input = object(value, label);
  exact(input, ["key", "direction"], [], label);
  return {
    key: oneOf(input.key, SCREENER_SORT_KEYS_V1, `${label}.key`),
    direction: oneOf(input.direction, ["asc", "desc"] as const, `${label}.direction`),
  };
}

function parseUniverseSummary(value: unknown, label: string): ScreenerUniverseSummaryV1 {
  const input = object(value, label);
  exact(input, ["requested", "evaluated", "matched", "unavailable"], [], label);
  const requested = integer(input.requested, `${label}.requested`, 0, 1_000_000);
  const evaluated = integer(input.evaluated, `${label}.evaluated`, 0, 1_000_000);
  const matched = integer(input.matched, `${label}.matched`, 0, 1_000_000);
  const unavailable = integer(input.unavailable, `${label}.unavailable`, 0, 1_000_000);
  if (evaluated > requested || matched > evaluated || unavailable > requested) throw new Error(`${label} counters are inconsistent`);
  return { requested, evaluated, matched, unavailable };
}

function parseUnavailableReasons(value: unknown, label: string): Record<string, number> {
  const input = object(value, label);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error(`${label} must contain at most 32 reasons`);
  const result: Record<string, number> = {};
  for (const [reason, count] of entries) {
    pattern(reason, `${label} reason code`, REASON_CODE, 1, 64);
    result[reason] = integer(count, `${label}.${reason}`, 1, 1_000_000);
  }
  return result;
}

function parseRowMetrics(value: unknown, label: string): ScreenerRowMetricsV1 {
  const input = object(value, label);
  exact(input, [], ["rsi", "atrPercent", "macdHistogram", "fastMa", "slowMa"], label);
  const result: ScreenerRowMetricsV1 = {};
  if (input.rsi !== undefined) result.rsi = boundedDecimal(input.rsi, `${label}.rsi`, 0, 100);
  if (input.atrPercent !== undefined) result.atrPercent = boundedDecimal(input.atrPercent, `${label}.atrPercent`, 0, 1_000_000);
  if (input.macdHistogram !== undefined) result.macdHistogram = boundedDecimal(input.macdHistogram, `${label}.macdHistogram`, -1e15, 1e15);
  if (input.fastMa !== undefined) result.fastMa = boundedDecimal(input.fastMa, `${label}.fastMa`, 0, 1e15);
  if (input.slowMa !== undefined) result.slowMa = boundedDecimal(input.slowMa, `${label}.slowMa`, 0, 1e15);
  return result;
}

function safety(input: Record<string, unknown>, schemaVersion: string, label: string): void {
  if (input.schemaVersion !== schemaVersion || input.researchOnly !== true || input.executionPermission !== false) {
    throw new Error(`${label} violates its versioned research-only safety envelope`);
  }
}

function safetyFlags(input: Record<string, unknown>, label: string): void {
  if (input.researchOnly !== true || input.executionPermission !== false) {
    throw new Error(`${label} violates its research-only safety envelope`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in input));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has missing or unknown fields`);
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must be a trimmed string from ${minimum} to ${maximum} characters`);
  }
  if (hasControlCharacters(value)) throw new Error(`${label} contains control characters`);
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || code <= 31) return true;
  }
  return false;
}

function pattern(value: unknown, label: string, expression: RegExp, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !expression.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function uuid(value: unknown, label: string): string {
  return pattern(value, label, UUID, 36, 36);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is out of bounds`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function decimal(value: unknown, label: string, options: { positive?: boolean } = {}): ScreenerDecimalV1 {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical base-10 decimal string`);
  if (value.startsWith("-") && decimalIsZero(value)) throw new Error(`${label} must not be negative zero`);
  if (options.positive && (value.startsWith("-") || decimalIsZero(value))) throw new Error(`${label} must be positive`);
  return value;
}

function boundedDecimal(value: unknown, label: string, minimum: number, maximum: number): ScreenerDecimalV1 {
  const parsed = decimal(value, label);
  const numeric = Number(parsed);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) throw new Error(`${label} is out of bounds`);
  return parsed;
}

function decimalIsZero(value: string): boolean {
  return value.replace("-", "").replace(".", "").split("").every((digit) => digit === "0");
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must equal ${expected}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function timeframe(value: unknown, label: string): ScreenerTimeframeV1 {
  if (typeof value !== "string" || !SCREENER_TIMEFRAMES.has(value)) throw new Error(`${label} is unsupported`);
  return value as ScreenerTimeframeV1;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be a valid UTC timestamp`);
  return value;
}
