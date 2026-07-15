declare const VENUES: readonly ["okx", "gate", "hyperliquid", "deribit", "kraken", "coinbase", "dydx", "kucoin", "mexc"];
declare const MARKET_TYPES: readonly ["spot", "perpetual", "future"];
declare const FEED_STATES: readonly ["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"];
declare const HEALTH_STATES: readonly ["healthy", "degraded", "unhealthy"];
export type ContinuousFeedHealthState = "idle" | (typeof HEALTH_STATES)[number];
export type ContinuousFeedSourceState = (typeof FEED_STATES)[number];
export type ContinuousFeedSourceHealth = (typeof HEALTH_STATES)[number];
interface ContinuityBase {
    receivedAt: number;
    ageMs: number;
    fresh: boolean;
    connectionGeneration: number;
    generationMatches: boolean;
}
export type ContinuousFeedContinuity = (ContinuityBase & {
    kind: "sequence-verified";
    protocol: "okx-seqid" | "gate-update-id" | "deribit-change-id" | "coinbase-advanced-sequence" | "kucoin-obu-range" | "mexc-spot-version" | "mexc-futures-version";
    verified: true;
    sequence: number;
}) | (ContinuityBase & {
    kind: "checksum-verified";
    protocol: "kraken-spot-crc32";
    verified: true;
    sequence: number;
    checksum: number;
}) | (ContinuityBase & {
    kind: "sequence-observed";
    protocol: "kraken-futures-seq" | "dydx-indexer-message-id";
    verified: false;
    sequence: number;
}) | (ContinuityBase & {
    kind: "atomic-snapshot";
    protocol: "hyperliquid-block-snapshot";
    verified: false;
});
export interface ContinuousFeedHealthSource {
    venue: (typeof VENUES)[number];
    instrumentId: string;
    marketType: (typeof MARKET_TYPES)[number];
    state: ContinuousFeedSourceState;
    health: ContinuousFeedSourceHealth;
    generation: number;
    reconnect: {
        scheduled: boolean;
        observedConnectionRestarts: number;
    };
    lastReceive?: {
        at: number;
        ageMs: number;
        kind: "book" | "top-book" | "funding";
        connectionGeneration: number;
        currentGeneration: boolean;
        fresh: boolean;
    };
    continuity?: ContinuousFeedContinuity;
    hasBook: boolean;
    hasTopBook: boolean;
    hasFunding: boolean;
    bookContinuityReady: boolean;
}
export interface ContinuousFeedHealthResponse {
    schemaVersion: 1;
    engine: "continuous-feed-health-v1";
    readOnly: true;
    dataScope: "public-market-data";
    credentialsRequired: false;
    secretsIncluded: false;
    executionStatus: "not-supported";
    executable: false;
    capturedAt: number;
    maxReceiveAgeMs: number;
    state: ContinuousFeedHealthState;
    counts: {
        streams: number;
        healthy: number;
        reconnecting: number;
        bookContinuityReady: number;
    };
    sources: ContinuousFeedHealthSource[];
}
/** Strict parser for the public, credential-free operator diagnostics endpoint. */
export declare function parseContinuousFeedHealthResponse(value: unknown): ContinuousFeedHealthResponse;
export {};
