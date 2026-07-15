import type { ArbitrageOpportunity, ArbitrageScanResponse } from "./client";

export interface BrowserAlertState {
  initialized: boolean;
  eligibleRouteIds: ReadonlySet<string>;
}

export interface BrowserAlertEvaluation {
  state: BrowserAlertState;
  fired: ArbitrageOpportunity[];
}

/**
 * Advances browser-only crossing state from route-local trustworthy evidence.
 * A failed unrelated source must not suppress a healthy route, while a route
 * whose own spot/perpetual dependency is missing or unhealthy fails closed.
 */
export function evaluateBrowserAlertSnapshot(scan: ArbitrageScanResponse, previous: BrowserAlertState, isEligible: (row: ArbitrageOpportunity) => boolean): BrowserAlertEvaluation {
  const trusted = scan.opportunities.filter((row) => row.dataQuality === "fresh" && routeDependenciesHealthy(scan, row));
  const trustedRouteIds = new Set(trusted.map((row) => row.id));
  const presentRouteIds = new Set(scan.opportunities.map((row) => row.id));
  const freshEligible = trusted.filter(isEligible);
  const eligibleRouteIds = new Set(freshEligible.map((row) => row.id));
  const completeUniverse = !scan.stale && !scan.truncated && completeSourceUniverse(scan);
  for (const routeId of previous.eligibleRouteIds) {
    const presentButUntrusted = presentRouteIds.has(routeId) && !trustedRouteIds.has(routeId);
    const absentFromIncompleteSnapshot = !presentRouteIds.has(routeId) && !completeUniverse;
    if (presentButUntrusted || absentFromIncompleteSnapshot) eligibleRouteIds.add(routeId);
  }
  const hasTrustworthyEvidence = trusted.length > 0 || completeUniverse;
  if (!hasTrustworthyEvidence) return { state: previous, fired: [] };
  const state = { initialized: true, eligibleRouteIds };
  if (!previous.initialized) return { state, fired: [] };
  return {
    state,
    fired: freshEligible.filter((row) => !previous.eligibleRouteIds.has(row.id))
  };
}

/** Exact source dependency gate used by browser alert evaluation. */
export function routeDependenciesHealthy(scan: Pick<ArbitrageScanResponse, "sources">, row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange">): boolean {
  return sourceHealthy(scan, row.spotExchange, "spot") && sourceHealthy(scan, row.futuresExchange, "perpetual");
}

function completeSourceUniverse(scan: Pick<ArbitrageScanResponse, "sources">) {
  return (["binance", "bybit"] as const).every((exchange) => (["spot", "perpetual"] as const).every((market) => sourceHealthy(scan, exchange, market)));
}

function sourceHealthy(scan: Pick<ArbitrageScanResponse, "sources">, exchange: ArbitrageOpportunity["spotExchange"], market: "spot" | "perpetual") {
  const matching = scan.sources.filter((source) => source.exchange === exchange && source.market === market);
  return matching.length === 1 && matching[0]?.ok === true;
}
