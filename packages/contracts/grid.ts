/** Public, research-only grid robot parameter contracts shared by the API and browser. */

export const GRID_PARAMS_SCHEMA_V1 = "grid-params-v1" as const;

export const GRID_LEVELS_MINIMUM_V1 = 2;
export const GRID_LEVELS_MAXIMUM_V1 = 50;
export const GRID_MAX_CYCLES_MAXIMUM_V1 = 10_000;
export const GRID_MAX_COOLDOWN_SECONDS_V1 = 86_400;
/** Matches the fixed-micros paper money range: 1e15 micros = 1e9 USDT. */
export const GRID_QUOTE_MAXIMUM_V1 = 1_000_000_000;
/** Price bounds share the same conservative absolute cap as quote sizes. */
export const GRID_PRICE_MAXIMUM_V1 = 1_000_000_000;
/** Sanity cap on upperBound/lowerBound for geometric spacing. */
export const GRID_GEOMETRIC_MAX_RATIO_V1 = 1_000_000;

export type GridModeV1 = "neutral" | "long" | "short";
export type GridSpacingV1 = "arithmetic" | "geometric";
/** "manual" is reserved for a later release; the v1 parser accepts only "off". */
export type GridRecenterV1 = "off" | "manual";
export type GridOutsideRangeActionV1 = "pause" | "stop";

export interface GridParamsV1 {
  schemaVersion: typeof GRID_PARAMS_SCHEMA_V1;
  mode: GridModeV1;
  /** Level spacing law inside [lowerBound, upperBound]. */
  spacing: GridSpacingV1;
  /** Inclusive range floor; level prices sit strictly inside the range. */
  lowerBound: number;
  /** Inclusive range ceiling; must be strictly above lowerBound. */
  upperBound: number;
  /** Number of BUY/SELL level lines placed strictly inside the range. */
  gridLevels: number;
  /** Order size per level in quote currency. */
  orderQuote: number;
  /** Recenter policy; the MVP has no auto-recenter, so only "off" parses. */
  recenter: GridRecenterV1;
  /** Price escaping the range pauses the grid (resume on re-entry) or stops it. */
  outsideRangeAction: GridOutsideRangeActionV1;
  /** Optional flatten-and-stop trigger; neutral/long below lowerBound, short above upperBound. */
  stopLossPrice?: number;
  /** Optional cap of completed buy-to-sell round trips; reaching it stops the grid. */
  maxCycles?: number;
  /** Delay before a level re-arms after its paired order fills, seconds. */
  cooldownSeconds: number;
  researchOnly: true;
  executionPermission: false;
}

export function parseGridParamsV1(value: unknown, label = "grid params"): GridParamsV1 {
  const input = object(value, label);
  exact(
    input,
    ["schemaVersion", "mode", "spacing", "lowerBound", "upperBound", "gridLevels", "orderQuote", "outsideRangeAction", "cooldownSeconds", "researchOnly", "executionPermission"],
    ["recenter", "stopLossPrice", "maxCycles"],
    label,
  );
  safety(input, label);
  if (input.recenter !== undefined && input.recenter !== "off") {
    throw new Error(`${label}.recenter only supports "off" in grid-params-v1`);
  }
  const mode = oneOf(input.mode, ["neutral", "long", "short"] as const, `${label}.mode`);
  const spacing = oneOf(input.spacing, ["arithmetic", "geometric"] as const, `${label}.spacing`);
  const lowerBound = bounded(input.lowerBound, `${label}.lowerBound`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
  const upperBound = bounded(input.upperBound, `${label}.upperBound`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
  if (lowerBound >= upperBound) throw new Error(`${label}.lowerBound must be strictly below upperBound`);
  if (spacing === "geometric" && upperBound / lowerBound > GRID_GEOMETRIC_MAX_RATIO_V1) {
    throw new Error(`${label} geometric bounds ratio is out of bounds`);
  }
  const result: GridParamsV1 = {
    schemaVersion: GRID_PARAMS_SCHEMA_V1,
    mode,
    spacing,
    lowerBound,
    upperBound,
    gridLevels: integer(input.gridLevels, `${label}.gridLevels`, GRID_LEVELS_MINIMUM_V1, GRID_LEVELS_MAXIMUM_V1),
    orderQuote: bounded(input.orderQuote, `${label}.orderQuote`, 0, GRID_QUOTE_MAXIMUM_V1, { exclusiveMinimum: true }),
    recenter: "off",
    outsideRangeAction: oneOf(input.outsideRangeAction, ["pause", "stop"] as const, `${label}.outsideRangeAction`),
    cooldownSeconds: integer(input.cooldownSeconds, `${label}.cooldownSeconds`, 0, GRID_MAX_COOLDOWN_SECONDS_V1),
    researchOnly: true,
    executionPermission: false,
  };
  if (input.stopLossPrice !== undefined) {
    const stopLossPrice = bounded(input.stopLossPrice, `${label}.stopLossPrice`, 0, GRID_PRICE_MAXIMUM_V1, { exclusiveMinimum: true });
    if (mode === "short" ? stopLossPrice <= upperBound : stopLossPrice >= lowerBound) {
      throw new Error(`${label}.stopLossPrice must sit beyond the ${mode === "short" ? "upper" : "lower"} bound for ${mode} grids`);
    }
    result.stopLossPrice = stopLossPrice;
  }
  if (input.maxCycles !== undefined) {
    result.maxCycles = integer(input.maxCycles, `${label}.maxCycles`, 1, GRID_MAX_CYCLES_MAXIMUM_V1);
  }
  return result;
}

/**
 * Deterministic level price ladder shared by the UI preview and the state
 * machine: `gridLevels` prices strictly inside (lowerBound, upperBound), for
 * i = 1..gridLevels with step denominator gridLevels + 1 —
 * arithmetic: lower + i * (upper - lower) / (levels + 1);
 * geometric: lower * (upper / lower) ^ (i / (levels + 1)).
 * Every price is canonically rounded to 6 decimals so replays are byte-stable.
 */
export function gridLevelPrices(params: GridParamsV1): number[] {
  const { lowerBound, upperBound, gridLevels, spacing } = params;
  const step = gridLevels + 1;
  const prices: number[] = [];
  for (let index = 1; index <= gridLevels; index += 1) {
    const price = spacing === "arithmetic"
      ? lowerBound + (index * (upperBound - lowerBound)) / step
      : lowerBound * (upperBound / lowerBound) ** (index / step);
    prices.push(Math.round(price * 1_000_000) / 1_000_000);
  }
  return prices;
}

/**
 * Worst-case committed capital in quote currency: every level simultaneously
 * holding a filled buy with no paired sell (neutral/long), times a fee reserve,
 * rounded UP to 6 decimals so the reservation is always conservative. Short
 * grids reserve the symmetric quote-denominated amount — the identical MVP
 * model — and resting-order margin is 0 under paper spot semantics, so the
 * bound is levels * orderQuote for every mode. `feePct` is the versioned paper
 * fill-model commission (percent); server and browser must pass the same value.
 */
export function worstCaseGridCapitalQuote(params: GridParamsV1, feePct: number): number {
  if (typeof feePct !== "number" || !Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
    throw new Error("worst-case feePct must be a finite percentage from 0 to 100");
  }
  const committed = params.gridLevels * params.orderQuote;
  return Math.ceil(committed * (1 + feePct / 100) * 1_000_000) / 1_000_000;
}

function safety(input: Record<string, unknown>, label: string): void {
  if (input.schemaVersion !== GRID_PARAMS_SCHEMA_V1 || input.researchOnly !== true || input.executionPermission !== false) {
    throw new Error(`${label} violates its versioned research-only safety envelope`);
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

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is out of bounds`);
  return value;
}

function bounded(value: unknown, label: string, minimum: number, maximum: number, options: { exclusiveMinimum?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  if (value > maximum || value < minimum || (options.exclusiveMinimum && value === minimum)) throw new Error(`${label} is out of bounds`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}
