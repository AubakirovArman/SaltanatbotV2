import type { ArbitrageOpportunity } from "./types.js";
import type { ArbitrageTickerUpdate } from "./upstream/types.js";

/** Two references per route make ticker recomputation proportional to route degree, not universe size. */
export class ArbitrageRouteDependencyIndex {
  private readonly dependencies = new Map<string, Set<string>>();
  private routeCount = 0;
  private referenceCount = 0;

  replace(routes: Iterable<ArbitrageOpportunity>) {
    this.dependencies.clear();
    this.routeCount = 0;
    this.referenceCount = 0;
    for (const route of routes) {
      this.routeCount += 1;
      for (const key of routeDependencyKeys(route)) {
        const ids = this.dependencies.get(key) ?? new Set<string>();
        if (!ids.has(route.id)) {
          ids.add(route.id);
          this.referenceCount += 1;
        }
        this.dependencies.set(key, ids);
      }
    }
  }

  idsFor(update: Pick<ArbitrageTickerUpdate, "exchange" | "market" | "symbol">): readonly string[] {
    return [...(this.dependencies.get(updateKey(update)) ?? [])];
  }

  stats() {
    return { routes: this.routeCount, keys: this.dependencies.size, references: this.referenceCount };
  }
}

export function routeDependencyKeys(route: ArbitrageOpportunity): [string, string] {
  return [
    key(route.spotExchange, "spot", route.symbol),
    key(route.futuresExchange, "perpetual", route.symbol)
  ];
}

function updateKey(update: Pick<ArbitrageTickerUpdate, "exchange" | "market" | "symbol">) {
  return key(update.exchange, update.market, update.symbol);
}

function key(exchange: string, market: string, symbol: string) {
  return `${exchange}:${market}:${symbol}`;
}
