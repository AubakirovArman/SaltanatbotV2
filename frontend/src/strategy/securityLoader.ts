import type { Candle, DataExchange, Timeframe } from "../types";
import { loadCandleHistory } from "./candleHistory";
import type { StrategyIR } from "./ir";
import {
  createSecurityDataBundle,
  securitySeriesKey,
  type ResolvedSecuritySeries,
  type SecurityDataContext,
  type SecurityDataEvidence,
  type SecuritySeriesRequest,
  type UnresolvedSecuritySeries
} from "./securityData";
import { collectSecurityRequirements, type SecurityRequirement } from "./securityRequirements";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
const TIMEFRAME_SET = new Set<string>(TIMEFRAMES);
const MAX_SECURITY_BARS = 5000;

export interface SecurityLoadBase {
  symbol: string;
  timeframe: Timeframe;
  chartCandles: Candle[];
  exchange?: DataExchange;
  signal?: AbortSignal;
  /** Strict by default. `return-evidence` is intended for an explicitly approximate preview only. */
  unresolvedPolicy?: "error" | "return-evidence";
}

export interface ResolvedSecurityRequest {
  fetchSymbol: string;
  fetchTimeframe: Timeframe;
  keys: string[];
  sameAsChart: boolean;
}

export class SecurityDataLoadError extends Error {
  readonly code = "UNRESOLVED_SECURITY_DATA";

  constructor(readonly evidence: SecurityDataEvidence) {
    const summary = evidence.unresolved
      .map((request) => `${request.symbol} ${request.timeframe} (${request.reason})`)
      .join(", ");
    super(`request.security data unresolved: ${summary}`);
    this.name = "SecurityDataLoadError";
  }
}

export async function loadSecurityDataForIr(ir: StrategyIR, base: SecurityLoadBase): Promise<SecurityDataContext> {
  const requirements = collectSecurityRequirements(ir);
  const data: Record<string, Candle[]> = {};
  if (requirements.length === 0) return data;

  const requested = requirements.map(toEvidenceRequest);
  const resolvedEvidence: ResolvedSecuritySeries[] = [];
  const unresolved: UnresolvedSecuritySeries[] = [];

  if (base.chartCandles.length === 0) {
    for (const request of requested) unresolved.push({ ...request, reason: "empty-chart" });
    return finishSecurityLoad(data, { version: 1, requested, resolved: resolvedEvidence, unresolved }, base.unresolvedPolicy);
  }

  const requests = new Map<string, { request: ResolvedSecurityRequest; members: Array<{
    evidence: SecuritySeriesRequest;
    resolved: ResolvedSecurityRequest;
  }> }>();

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const evidence = requested[index];
    const resolved = resolveSecurityRequest(requirement, base);
    if (!resolved) {
      unresolved.push({ ...evidence, reason: "unsupported-request" });
      continue;
    }
    if (resolved.sameAsChart) {
      for (const key of resolved.keys) data[key] = base.chartCandles;
      resolvedEvidence.push({
        ...evidence,
        fetchSymbol: resolved.fetchSymbol,
        fetchTimeframe: resolved.fetchTimeframe,
        source: "chart",
        bars: base.chartCandles.length,
        keys: resolved.keys
      });
      continue;
    }

    const groupKey = `${resolved.fetchSymbol}|${resolved.fetchTimeframe}`;
    const existing = requests.get(groupKey);
    if (existing) {
      existing.request.keys = unique([...existing.request.keys, ...resolved.keys]);
      existing.members.push({ evidence, resolved });
    } else {
      requests.set(groupKey, { request: { ...resolved }, members: [{ evidence, resolved }] });
    }
  }

  for (const group of requests.values()) {
    const request = group.request;
    let candles: Candle[];
    try {
      candles = await fetchSecurityWindow(request.fetchSymbol, request.fetchTimeframe, base);
    } catch (cause) {
      if (isAbort(cause) || base.signal?.aborted) throw cause;
      for (const member of group.members) {
        unresolved.push({
          ...member.evidence,
          fetchSymbol: request.fetchSymbol,
          fetchTimeframe: request.fetchTimeframe,
          reason: "load-error"
        });
      }
      continue;
    }

    if (!candles.length) {
      for (const member of group.members) {
        unresolved.push({
          ...member.evidence,
          fetchSymbol: request.fetchSymbol,
          fetchTimeframe: request.fetchTimeframe,
          reason: "empty-response"
        });
      }
      continue;
    }

    for (const key of request.keys) data[key] = candles;
    for (const member of group.members) {
      resolvedEvidence.push({
        ...member.evidence,
        fetchSymbol: request.fetchSymbol,
        fetchTimeframe: request.fetchTimeframe,
        source: "external",
        bars: candles.length,
        keys: member.resolved.keys
      });
    }
  }

  return finishSecurityLoad(
    data,
    { version: 1, requested, resolved: resolvedEvidence, unresolved },
    base.unresolvedPolicy
  );
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
  return loadCandleHistory({ symbol, timeframe, bars: target, endTime: chartEnd, exchange: base.exchange, stopAt: chartStart, signal: base.signal });
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

function toEvidenceRequest(requirement: SecurityRequirement): SecuritySeriesRequest {
  return {
    key: securitySeriesKey(requirement.symbol, requirement.timeframe),
    symbol: requirement.symbol,
    timeframe: requirement.timeframe
  };
}

function finishSecurityLoad(
  data: Record<string, Candle[]>,
  evidence: SecurityDataEvidence,
  policy: SecurityLoadBase["unresolvedPolicy"]
): SecurityDataContext {
  if (evidence.unresolved.length > 0 && policy !== "return-evidence") {
    throw new SecurityDataLoadError(evidence);
  }
  return createSecurityDataBundle(data, evidence);
}

function isAbort(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError";
}
