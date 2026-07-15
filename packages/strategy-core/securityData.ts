import type { Candle } from "@saltanatbotv2/contracts";

/** Legacy/raw external-series storage accepted by every runtime entry point. */
export type SecuritySeriesStore = Map<string, Candle[]> | Record<string, Candle[]>;

export interface SecuritySeriesRequest {
  key: string;
  symbol: string;
  timeframe: string;
}

export interface ResolvedSecuritySeries extends SecuritySeriesRequest {
  fetchSymbol: string;
  fetchTimeframe: string;
  source: "chart" | "external";
  bars: number;
  keys: string[];
}

export interface UnresolvedSecuritySeries extends SecuritySeriesRequest {
  fetchSymbol?: string;
  fetchTimeframe?: string;
  reason: "empty-chart" | "unsupported-request" | "empty-response" | "load-error";
}

/**
 * Versioned evidence produced while resolving request.security() dependencies.
 * It intentionally contains no raw errors/URLs so exported reports stay safe
 * and deterministic.
 */
export interface SecurityDataEvidence {
  version: 1;
  requested: SecuritySeriesRequest[];
  resolved: ResolvedSecuritySeries[];
  unresolved: UnresolvedSecuritySeries[];
}

/** Rich context used by research/backtests while retaining raw-map compatibility. */
export interface SecurityDataBundle {
  series: SecuritySeriesStore;
  evidence: SecurityDataEvidence;
}

export type SecurityDataContext = SecuritySeriesStore | SecurityDataBundle;

export function createSecurityDataBundle(
  series: SecuritySeriesStore,
  evidence: SecurityDataEvidence
): SecurityDataBundle {
  return { series, evidence };
}

export function isSecurityDataBundle(context: SecurityDataContext | undefined): context is SecurityDataBundle {
  if (!context || context instanceof Map || Array.isArray(context)) return false;
  const candidate = context as Partial<SecurityDataBundle>;
  return candidate.evidence?.version === 1
    && Array.isArray(candidate.evidence.requested)
    && Array.isArray(candidate.evidence.resolved)
    && Array.isArray(candidate.evidence.unresolved)
    && candidate.series !== undefined;
}

export function getSecuritySeriesStore(context: SecurityDataContext | undefined): SecuritySeriesStore | undefined {
  return isSecurityDataBundle(context) ? context.series : context;
}

export function getSecurityDataEvidence(context: SecurityDataContext | undefined): SecurityDataEvidence | undefined {
  return isSecurityDataBundle(context) ? context.evidence : undefined;
}

export function securitySeriesKey(symbol: string, timeframe: string): string {
  return `${normalizePart(symbol)}|${normalizeTimeframePart(timeframe)}`;
}

export function getSecurityCandles(context: SecurityDataContext | undefined, symbol: string, timeframe: string): Candle[] | undefined {
  const store = getSecuritySeriesStore(context);
  if (!store) return undefined;
  const keys = [
    securitySeriesKey(symbol, timeframe),
    `${symbol}:${timeframe}`,
    `${symbol}|${timeframe}`,
    `${symbol}/${timeframe}`
  ];
  for (const key of keys) {
    const value = store instanceof Map ? store.get(key) : store[key];
    if (value?.length) return value;
  }
  return undefined;
}

export function alignSecuritySeries(chartCandles: Candle[], sourceCandles: Candle[], sourceValues: number[]): number[] {
  const out = new Array<number>(chartCandles.length).fill(NaN);
  let srcIdx = -1;
  for (let i = 0; i < chartCandles.length; i += 1) {
    const t = chartCandles[i].time;
    while (srcIdx + 1 < sourceCandles.length && sourceCandles[srcIdx + 1].time <= t) srcIdx += 1;
    if (srcIdx >= 0) out[i] = sourceValues[srcIdx] ?? NaN;
  }
  return out;
}

function normalizePart(value: string): string {
  return value.trim().toUpperCase() || "CURRENT";
}

function normalizeTimeframePart(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "CURRENT";
  // The app uses lowercase `m` for minutes and uppercase `M` for months.
  // Uppercasing the entire key silently aliased e.g. 1m and 1M.
  if (/^\d+m$/.test(trimmed)) return trimmed;
  return trimmed.toUpperCase();
}
