import type { Candle } from "@saltanatbotv2/contracts";
import type { StrategyIR } from "./index.js";
import {
  getSecurityCandles,
  getSecurityDataEvidence,
  securitySeriesKey,
  type SecurityDataContext,
  type UnresolvedSecuritySeries
} from "./securityData.js";

export type UnresolvedSecurityPolicy = "error" | "chart";

/** Raised before a missing request.security() value can affect a decision. */
export class UnresolvedSecuritySeriesError extends Error {
  readonly code = "UNRESOLVED_SECURITY_SERIES";

  constructor(
    readonly symbol: string,
    readonly timeframe: string,
    readonly reason: UnresolvedSecuritySeries["reason"] | "missing-series" = "missing-series"
  ) {
    super(`request.security data unresolved for ${symbol} ${timeframe} (${reason})`);
    this.name = "UnresolvedSecuritySeriesError";
  }
}

/** Validate every dependency, including expressions in branches that never execute. */
export function assertSecurityDependenciesResolved(
  ir: StrategyIR,
  securityData: SecurityDataContext | undefined,
  policy: UnresolvedSecurityPolicy
): void {
  if (policy !== "error") return;
  for (const request of collectSecurityDependencies(ir)) {
    if (!getSecurityCandles(securityData, request.symbol, request.timeframe)?.length) {
      throw unresolvedSecurityError(securityData, request.symbol, request.timeframe);
    }
  }
}

/** Resolve one series or enforce the selected fail-closed/preview-only policy. */
export function resolveSecurityCandles(
  securityData: SecurityDataContext | undefined,
  symbol: string,
  timeframe: string,
  policy: UnresolvedSecurityPolicy
): Candle[] | undefined {
  const external = getSecurityCandles(securityData, symbol, timeframe);
  if (external?.length) return external;
  if (policy === "chart") return undefined;
  throw unresolvedSecurityError(securityData, symbol, timeframe);
}

function collectSecurityDependencies(ir: StrategyIR): Array<{ symbol: string; timeframe: string }> {
  const dependencies = new Map<string, { symbol: string; timeframe: string }>();
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.k === "security" && typeof candidate.symbol === "string" && typeof candidate.timeframe === "string") {
      dependencies.set(securitySeriesKey(candidate.symbol, candidate.timeframe), {
        symbol: candidate.symbol,
        timeframe: candidate.timeframe
      });
    }
    Object.values(candidate).forEach(visit);
  };
  visit(ir);
  return [...dependencies.values()];
}

function unresolvedSecurityError(
  securityData: SecurityDataContext | undefined,
  symbol: string,
  timeframe: string
): UnresolvedSecuritySeriesError {
  const key = securitySeriesKey(symbol, timeframe);
  const issue = getSecurityDataEvidence(securityData)?.unresolved.find((item) => item.key === key);
  return new UnresolvedSecuritySeriesError(symbol, timeframe, issue?.reason);
}
