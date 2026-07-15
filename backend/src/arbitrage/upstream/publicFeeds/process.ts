import { UpstreamResourceGovernor } from "../resourceGovernor/governor.js";
import type { UpstreamSourceBudget } from "../resourceGovernor/types.js";
import type { ContinuousPublicVenue } from "./types.js";

export const PUBLIC_STREAM_SOURCES: Readonly<Record<ContinuousPublicVenue, string>> = Object.freeze({
  okx: "okx.public-websocket",
  gate: "gate.public-websocket",
  hyperliquid: "hyperliquid.public-websocket",
  deribit: "deribit.public-websocket",
  kraken: "kraken.public-websocket",
  coinbase: "coinbase.public-websocket",
  dydx: "dydx.public-websocket",
  kucoin: "kucoin.public-websocket",
  mexc: "mexc.public-websocket"
});

const CONNECTION_ATTEMPT_BUDGET: UpstreamSourceBudget = {
  maxConcurrent: 8,
  failureThreshold: 4,
  cooldownMs: 5_000
};

/**
 * Process-wide admission/circuit boundary for public WS connection attempts.
 * The hub separately caps live subscriptions. A governor lease is released after
 * the first accepted market-data publication, so it measures connection pressure without holding
 * an operation-style REST lease for the lifetime of a socket.
 */
export const processPublicStreamGovernor = new UpstreamResourceGovernor(Object.fromEntries(Object.values(PUBLIC_STREAM_SOURCES).map((source) => [source, CONNECTION_ATTEMPT_BUDGET])));
