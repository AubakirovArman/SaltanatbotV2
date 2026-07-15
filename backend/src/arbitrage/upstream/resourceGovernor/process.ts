import { UpstreamResourceGovernor } from "./governor.js";
import type { UpstreamSourceBudget } from "./types.js";

export const PUBLIC_UPSTREAM_SOURCES = {
  binance: "binance.public-rest",
  bybit: "bybit.public-rest",
  coinbase: "coinbase.public-rest",
  deribit: "deribit.public-rest",
  dydx: "dydx.public-rest",
  gate: "gate.public-rest",
  hyperliquid: "hyperliquid.public-rest",
  kraken: "kraken.public-rest",
  kucoin: "kucoin.public-rest",
  mexc: "mexc.public-rest",
  okx: "okx.public-rest"
} as const;

const PUBLIC_REST_BUDGET: UpstreamSourceBudget = {
  maxConcurrent: 6,
  failureThreshold: 4,
  cooldownMs: 5_000
};

/** One process-wide governor shared by scanner REST and public venue facades. */
export const processPublicUpstreamGovernor = new UpstreamResourceGovernor(Object.fromEntries(Object.values(PUBLIC_UPSTREAM_SOURCES).map((source) => [source, PUBLIC_REST_BUDGET])));

export function publicUpstreamSource(venue: string): string | undefined {
  return PUBLIC_UPSTREAM_SOURCES[venue as keyof typeof PUBLIC_UPSTREAM_SOURCES];
}
