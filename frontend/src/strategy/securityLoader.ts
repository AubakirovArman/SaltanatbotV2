import { getCandles } from "../api/marketClient";
import type { Candle, DataExchange, Timeframe } from "../types";
import type { StrategyIR } from "./ir";
import { securitySeriesKey, type SecurityDataContext } from "./securityData";
import { collectSecurityRequirements, type SecurityRequirement } from "./securityRequirements";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
const TIMEFRAME_SET = new Set<string>(TIMEFRAMES);
const MAX_SECURITY_BARS = 5000;

export interface SecurityLoadBase {
  symbol: string;
  timeframe: Timeframe;
  chartCandles: Candle[];
  exchange?: DataExchange;
}

export interface ResolvedSecurityRequest {
  fetchSymbol: string;
  fetchTimeframe: Timeframe;
  keys: string[];
  sameAsChart: boolean;
}

export async function loadSecurityDataForIr(ir: StrategyIR, base: SecurityLoadBase): Promise<SecurityDataContext> {
  const data: Record<string, Candle[]> = {};
  if (base.chartCandles.length === 0) return data;

  const requests = mergeRequests(
    collectSecurityRequirements(ir)
      .map((req) => resolveSecurityRequest(req, base))
      .filter((req): req is ResolvedSecurityRequest => req !== undefined)
  );

  for (const request of requests) {
    if (request.sameAsChart) continue;
    try {
      const candles = await fetchSecurityWindow(request.fetchSymbol, request.fetchTimeframe, base);
      if (!candles.length) continue;
      for (const key of request.keys) data[key] = candles;
    } catch (cause) {
      console.warn(
        `[strategy] request.security data unavailable for ${request.fetchSymbol} ${request.fetchTimeframe}`,
        cause
      );
    }
  }

  return data;
}

export function resolveSecurityRequest(
  requirement: SecurityRequirement,
  base: Pick<SecurityLoadBase, "symbol" | "timeframe">
): ResolvedSecurityRequest | undefined {
  const fetchSymbol = normalizeSecuritySymbol(requirement.symbol, base.symbol);
  const fetchTimeframe = normalizeSecurityTimeframe(requirement.timeframe, base.timeframe);
  if (!fetchSymbol || !fetchTimeframe) return undefined;

  const keys = unique([
    securitySeriesKey(requirement.symbol, requirement.timeframe),
    securitySeriesKey(requirement.symbol, fetchTimeframe),
    securitySeriesKey(fetchSymbol, requirement.timeframe),
    securitySeriesKey(fetchSymbol, fetchTimeframe)
  ]);

  return {
    fetchSymbol,
    fetchTimeframe,
    keys,
    sameAsChart: fetchSymbol === base.symbol.toUpperCase() && fetchTimeframe === base.timeframe
  };
}

export function normalizeSecuritySymbol(value: string, chartSymbol: string): string {
  const raw = value.trim();
  if (!raw || ["current", "chart", "syminfo.ticker", "syminfo.tickerid"].includes(raw.toLowerCase())) {
    return chartSymbol.toUpperCase();
  }
  const withoutExchange = raw.includes(":") ? raw.split(":").at(-1) ?? raw : raw;
  return withoutExchange.replace(/[^A-Za-z0-9._-]/g, "").toUpperCase();
}

export function normalizeSecurityTimeframe(value: string, chartTimeframe: Timeframe): Timeframe | undefined {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "chart" || raw === "timeframe.period") return chartTimeframe;
  if (TIMEFRAME_SET.has(raw)) return raw as Timeframe;

  const upper = raw.toUpperCase();
  if (upper === "D" || upper === "1D") return "1d";
  if (upper === "W" || upper === "1W") return "1w";
  if (upper === "M" || upper === "1M") return "1M";

  const minutes = Number(upper);
  if (Number.isInteger(minutes)) return minutesToTimeframe(minutes);

  const match = upper.match(/^(\d+)([MHDW])$/);
  if (!match) return undefined;
  const count = Number(match[1]);
  const unit = match[2];
  if (!Number.isInteger(count) || count <= 0) return undefined;
  if (unit === "M") return minutesToTimeframe(count);
  if (unit === "H") return minutesToTimeframe(count * 60);
  if (unit === "D" && count === 1) return "1d";
  if (unit === "W" && count === 1) return "1w";
  return undefined;
}

async function fetchSecurityWindow(symbol: string, timeframe: Timeframe, base: SecurityLoadBase): Promise<Candle[]> {
  const chartStart = base.chartCandles[0].time;
  const chartEnd = base.chartCandles.at(-1)?.time;
  const target = Math.min(Math.max(base.chartCandles.length, 1000), MAX_SECURITY_BARS);
  let candles = (await getCandles(symbol, timeframe, Math.min(target, 1000), chartEnd, base.exchange)).candles;

  while (candles.length < target && candles.length > 0 && candles[0].time > chartStart) {
    const oldest = candles[0].time;
    const older = (await getCandles(symbol, timeframe, 1000, oldest - 1, base.exchange)).candles.filter(
      (candle) => candle.time < oldest
    );
    if (older.length === 0) break;
    candles = [...older, ...candles];
  }

  return candles.slice(-target);
}

function minutesToTimeframe(minutes: number): Timeframe | undefined {
  switch (minutes) {
    case 1:
      return "1m";
    case 5:
      return "5m";
    case 15:
      return "15m";
    case 30:
      return "30m";
    case 60:
      return "1h";
    case 120:
      return "2h";
    case 240:
      return "4h";
    case 1440:
      return "1d";
    case 10080:
      return "1w";
    case 43200:
      return "1M";
    default:
      return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeRequests(requests: ResolvedSecurityRequest[]): ResolvedSecurityRequest[] {
  const merged = new Map<string, ResolvedSecurityRequest>();
  for (const request of requests) {
    const key = `${request.fetchSymbol}|${request.fetchTimeframe}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, request);
      continue;
    }
    existing.keys = unique([...existing.keys, ...request.keys]);
    existing.sameAsChart = existing.sameAsChart && request.sameAsChart;
  }
  return [...merged.values()];
}
