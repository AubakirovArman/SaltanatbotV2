import {
  parseScreenerRowV1,
  parseScreenerRunResultV1,
  SCREENER_RESULT_ROW_LIMIT_V1,
  SCREENER_RUN_RESULT_SCHEMA_V1,
  type Candle,
  type ScreenerDefinitionV1,
  type ScreenerRowV1,
  type ScreenerRunResultV1,
  type ScreenerSortV1
} from "@saltanatbotv2/contracts";
import { candleHasFiniteMarketShape } from "../alerts/priceEvaluator.js";
import { evaluateScreenerFilter, type ScreenerFilterContextV1, type ScreenerMetricValuesV1 } from "./engineFilters.js";

/**
 * Pure, deterministic screener evaluation core. It consumes already-fetched
 * market data (closed candles plus a 24h ticker snapshot) and never performs
 * I/O, so tests and the worker share identical semantics. Every symbol that
 * cannot be evaluated honestly is reported as unavailable with a reason code —
 * missing data is never treated as zero.
 */

export interface ScreenerEngineUniverseRowV1 {
  symbol: string;
  /** Ticker last price, informational only; rows always report the closed-bar close. */
  lastClose?: number;
  quoteVolume24h?: number;
  change24hPercent?: number;
}

export interface ScreenerEngineInputV1 {
  definition: ScreenerDefinitionV1;
  /** sha256 of the canonical definition serialization (parseAndHashScreenerDefinition). */
  definitionHash: string;
  universe: readonly ScreenerEngineUniverseRowV1[];
  /** Closed candles only, ascending; symbols missing here count as unavailable. */
  candlesBySymbol: ReadonlyMap<string, Candle[]>;
  /** Acquisition failures recorded by market data (budget, upstream, staleness). */
  unavailableReasonBySymbol?: ReadonlyMap<string, string>;
  now: number;
}

type SymbolEvaluation =
  | { status: "unavailable"; reason: string }
  | { status: "evaluated"; closedBarTime: number; matched?: RankedRow };

interface RankedRow {
  row: ScreenerRowV1;
  sortValues: Partial<Record<"quoteVolume24h" | "change24hPercent" | "lastClose" | "rsi" | "atrPercent", number>>;
}

export function evaluateScreener(input: ScreenerEngineInputV1): ScreenerRunResultV1 {
  const reasons: Record<string, number> = {};
  const ranked: RankedRow[] = [];
  let evaluated = 0;
  let unavailable = 0;
  let closedBarTimeMin: number | undefined;
  let closedBarTimeMax: number | undefined;
  for (const universeRow of input.universe) {
    const evaluation = evaluateSymbol(input, universeRow);
    if (evaluation.status === "unavailable") {
      unavailable += 1;
      reasons[evaluation.reason] = (reasons[evaluation.reason] ?? 0) + 1;
      continue;
    }
    evaluated += 1;
    closedBarTimeMin = closedBarTimeMin === undefined ? evaluation.closedBarTime : Math.min(closedBarTimeMin, evaluation.closedBarTime);
    closedBarTimeMax = closedBarTimeMax === undefined ? evaluation.closedBarTime : Math.max(closedBarTimeMax, evaluation.closedBarTime);
    if (evaluation.matched) ranked.push(evaluation.matched);
  }
  ranked.sort(rowComparator(input.definition.sort));
  const rows = ranked.slice(0, SCREENER_RESULT_ROW_LIMIT_V1).map((entry) => entry.row);
  return parseScreenerRunResultV1({
    schemaVersion: SCREENER_RUN_RESULT_SCHEMA_V1,
    definitionHash: input.definitionHash,
    generatedAt: new Date(input.now).toISOString(),
    timeframe: input.definition.timeframe,
    closedBarTimeMin: closedBarTimeMin ?? 0,
    closedBarTimeMax: closedBarTimeMax ?? 0,
    universe: {
      requested: input.universe.length,
      evaluated,
      matched: ranked.length,
      unavailable
    },
    unavailableReasons: reasons,
    rows,
    rowsTruncated: ranked.length > rows.length,
    researchOnly: true,
    executionPermission: false
  });
}

/** toFixed(8) with trailing zeros trimmed; negative zero collapses to "0". */
export function formatScreenerDecimal(value: number): string | undefined {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return undefined;
  let text = value.toFixed(8);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

function evaluateSymbol(input: ScreenerEngineInputV1, universeRow: ScreenerEngineUniverseRowV1): SymbolEvaluation {
  const acquisitionReason = input.unavailableReasonBySymbol?.get(universeRow.symbol);
  if (acquisitionReason) return { status: "unavailable", reason: acquisitionReason };
  const candles = input.candlesBySymbol.get(universeRow.symbol);
  if (!candles || candles.length === 0) return { status: "unavailable", reason: "missing-candles" };
  const shapeReason = candleWindowShapeReason(candles);
  if (shapeReason) return { status: "unavailable", reason: shapeReason };
  const evaluationBar = candles[candles.length - 1]!;
  const context: ScreenerFilterContextV1 = {
    candles: [...candles],
    closes: candles.map((candle) => candle.close),
    lastClose: evaluationBar.close,
    ...(universeRow.quoteVolume24h === undefined ? {} : { quoteVolume24h: universeRow.quoteVolume24h }),
    ...(universeRow.change24hPercent === undefined ? {} : { change24hPercent: universeRow.change24hPercent })
  };
  // Every filter is evaluated so unavailability is independent of filter order:
  // an unavailable indicator always wins over an earlier unmatched filter.
  const metrics: ScreenerMetricValuesV1 = {};
  let allMatched = true;
  for (const filter of input.definition.filters) {
    const outcome = evaluateScreenerFilter(filter, context);
    if (outcome.status === "unavailable") return { status: "unavailable", reason: outcome.reason };
    Object.assign(metrics, outcome.metrics);
    if (outcome.status === "unmatched") allMatched = false;
  }
  if (!allMatched) return { status: "evaluated", closedBarTime: evaluationBar.time };
  const matched = buildRankedRow(input.definition, universeRow, evaluationBar, metrics);
  if (!matched) return { status: "unavailable", reason: "row-out-of-range" };
  return { status: "evaluated", closedBarTime: evaluationBar.time, matched };
}

function buildRankedRow(
  definition: ScreenerDefinitionV1,
  universeRow: ScreenerEngineUniverseRowV1,
  evaluationBar: Candle,
  metrics: ScreenerMetricValuesV1
): RankedRow | undefined {
  const rowMetrics: Record<string, string> = {};
  for (const key of ["rsi", "atrPercent", "macdHistogram", "fastMa", "slowMa"] as const) {
    const value = metrics[key];
    if (value === undefined) continue;
    const formatted = formatScreenerDecimal(value);
    if (formatted === undefined) return undefined;
    rowMetrics[key] = formatted;
  }
  const lastClose = formatScreenerDecimal(evaluationBar.close);
  if (lastClose === undefined) return undefined;
  const change24hPercent = optionalBounded(universeRow.change24hPercent, -100, 10_000);
  const quoteVolume24h = optionalBounded(universeRow.quoteVolume24h, 0, 1e15);
  try {
    const row = parseScreenerRowV1({
      symbol: universeRow.symbol,
      lastClose,
      closedBarTime: evaluationBar.time,
      ...(change24hPercent === undefined ? {} : { change24hPercent }),
      ...(quoteVolume24h === undefined ? {} : { quoteVolume24h }),
      metrics: rowMetrics,
      matchedFilters: definition.filters.length
    });
    return {
      row,
      sortValues: {
        lastClose: evaluationBar.close,
        ...(universeRow.quoteVolume24h === undefined ? {} : { quoteVolume24h: universeRow.quoteVolume24h }),
        ...(universeRow.change24hPercent === undefined ? {} : { change24hPercent: universeRow.change24hPercent }),
        ...(metrics.rsi === undefined ? {} : { rsi: metrics.rsi }),
        ...(metrics.atrPercent === undefined ? {} : { atrPercent: metrics.atrPercent })
      }
    };
  } catch {
    // A metric outside its contract bounds fails only this symbol, never the run.
    return undefined;
  }
}

function optionalBounded(value: number | undefined, minimum: number, maximum: number): string | undefined {
  if (value === undefined || value < minimum || value > maximum) return undefined;
  return formatScreenerDecimal(value);
}

function candleWindowShapeReason(candles: readonly Candle[]): string | undefined {
  let previousTime: number | undefined;
  for (const candle of candles) {
    if (!candleHasFiniteMarketShape(candle)) return "malformed-candle";
    if (candle.final !== true) return "non-final-candle";
    if (previousTime !== undefined && candle.time <= previousTime) return "malformed-candle-sequence";
    previousTime = candle.time;
  }
  return undefined;
}

function rowComparator(sort: ScreenerSortV1): (left: RankedRow, right: RankedRow) => number {
  const direction = sort.direction === "asc" ? 1 : -1;
  return (left, right) => {
    const primary = sort.key === "symbol"
      ? compareSymbols(left.row.symbol, right.row.symbol) * direction
      : compareNumeric(left.sortValues[sort.key], right.sortValues[sort.key], direction);
    if (primary !== 0) return primary;
    return compareSymbols(left.row.symbol, right.row.symbol);
  };
}

function compareNumeric(left: number | undefined, right: number | undefined, direction: number): number {
  if (left === undefined && right === undefined) return 0;
  // Symbols without the sorted value always rank after those with it.
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (left === right) return 0;
  return (left < right ? -1 : 1) * direction;
}

function compareSymbols(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
