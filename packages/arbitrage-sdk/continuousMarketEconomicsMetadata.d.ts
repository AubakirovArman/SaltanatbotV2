import type { ContinuousRouteCandidate } from "./continuousRoutes.js";
declare const MARKET_TYPES: readonly ["spot", "perpetual", "future"];
declare const QUANTITY_UNITS: readonly ["base", "quote", "contract"];
type MarketType = (typeof MARKET_TYPES)[number];
type QuantityUnit = (typeof QUANTITY_UNITS)[number];
export interface ContinuousMarketInstrumentContext {
    instrumentId: string;
    venue: string;
    symbol: string;
    marketType: MarketType;
    baseAsset: string;
    economicAssetId: string;
    economicIdentitySource: string;
    economicIdentityVersion: string;
    economicIdentityAsOf: number;
    economicIdentityValidUntil: number;
    quoteAsset: string;
    settleAsset: string;
    quantityModel: {
        unit: "base";
    } | {
        unit: "quote";
    } | {
        unit: "contract";
        contractMultiplier: number;
        multiplierAsset: "base" | "quote";
    };
    quantityStep: number;
    minimumQuantity: number;
    minimumNotional: number;
    takerFeeBps: number;
}
export interface ContinuousMarketBookContext {
    venue: string;
    instrumentId: string;
    marketType: MarketType;
    quantityUnit: QuantityUnit;
    bid: number;
    bidSize: number;
    ask: number;
    askSize: number;
    exchangeTs: number;
    receivedAt: number;
    connectionGeneration: number;
    continuity: {
        kind: "sequence-verified";
        sequence: number;
        protocol: "okx-seqid" | "gate-update-id" | "deribit-change-id" | "coinbase-advanced-sequence" | "kucoin-obu-range" | "mexc-spot-version" | "mexc-futures-version";
    } | {
        kind: "checksum-verified";
        sequence: number;
        checksum: number;
        protocol: "kraken-spot-crc32";
    } | {
        kind: "sequence-observed";
        sequence: number;
        protocol: "kraken-futures-seq" | "dydx-indexer-message-id";
    } | {
        kind: "atomic-snapshot";
        protocol: "hyperliquid-block-snapshot";
    };
}
export interface ContinuousMarketSourceContext {
    venue: string;
    symbol: string;
    marketType: MarketType;
    quantityUnit: QuantityUnit;
    state: "connecting" | "syncing" | "live" | "gap" | "reconnecting" | "stopped" | "overloaded" | "error";
    generation: number;
    topBook?: ContinuousMarketBookContext;
}
export declare function parseContinuousMarketInstruments(value: unknown): Map<string, ContinuousMarketInstrumentContext>;
export declare function validateContinuousMarketCandidateContext(candidates: readonly ContinuousRouteCandidate[], instruments: ReadonlyMap<string, ContinuousMarketInstrumentContext>): void;
export declare function parseContinuousMarketBooks(value: unknown, label: string): Map<string, ContinuousMarketBookContext>;
export declare function parseContinuousMarketSources(value: unknown): Map<string, ContinuousMarketSourceContext>;
export declare function assertContinuousSameBook(actual: ContinuousMarketBookContext, expected: ContinuousMarketBookContext, label: string): void;
export {};
