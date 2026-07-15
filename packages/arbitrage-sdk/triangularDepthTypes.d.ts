export type TriangularDepthVenue = "binance" | "bybit";
export interface TriangularDepthVerificationRequest {
    venue: TriangularDepthVenue;
    startAsset: string;
    startQuantity: number;
    takerFeeBps: number;
    minimumNetReturnBps?: number;
    symbols: readonly [string, string, string];
}
export interface TriangularDepthEvidence {
    symbol: string;
    sequence: number;
    connectionGeneration: number;
    exchangeTs: number;
    receivedAt: number;
    retainedDepth: number;
    source: "websocket-reconstructed";
    sequenceVerified: true;
}
export interface VerifiedTriangularLeg {
    index: 0 | 1 | 2;
    marketId: string;
    symbol: string;
    side: "buy" | "sell";
    fromAsset: string;
    toAsset: string;
    inputQuantity: number;
    inputConsumedQuantity: number;
    inputDustQuantity: number;
    orderBaseQuantity: number;
    averagePrice: number;
    worstPrice: number;
    quoteNotional: number;
    grossOutputQuantity: number;
    feeBps: number;
    feeQuantity: number;
    feeAsset: string;
    outputQuantity: number;
    levelsUsed: number;
    exchangeTs: number;
    exchangeTimestampVerified: true;
    receivedAt: number;
}
export interface VerifiedTriangularOpportunity {
    id: string;
    strategyKind: "triangular";
    edgeKind: "executable-sequential";
    executionStatus: "executable";
    marketDataMode: "sequence-verified-depth";
    sequenceVerified: true;
    venue: TriangularDepthVenue;
    cycleId: string;
    startAsset: string;
    endAsset: string;
    requestedStartQuantity: number;
    startQuantity: number;
    grossEndQuantity: number;
    endQuantity: number;
    grossReturnBps: number;
    netReturnBps: number;
    limitingCapacity: {
        requestedStartQuantity: number;
        executableStartQuantity: number;
        utilizationPct: number;
        limitingLegIndex?: 0 | 1 | 2;
        limitingMarketId?: string;
    };
    legs: readonly [VerifiedTriangularLeg, VerifiedTriangularLeg, VerifiedTriangularLeg];
    dustByAsset: Readonly<Record<string, number>>;
    timestamps: {
        evaluatedAt: number;
        oldestExchangeTs: number;
        newestExchangeTs: number;
        oldestReceivedAt: number;
        newestReceivedAt: number;
        quoteAgeMs: number;
        legSkewMs: number;
        exchangeTimestampsVerified: true;
    };
    riskFlags: readonly string[];
}
export interface TriangularDepthRejection {
    cycleId?: string;
    code: "unknown-market" | "invalid-book" | "incomplete-book" | "missing-book" | "stale-book" | "skewed-books" | "minimum-quantity" | "minimum-notional" | "insufficient-depth" | "non-profitable";
    message: string;
    legIndex?: 0 | 1 | 2;
    marketId?: string;
}
export interface TriangularDepthVerificationResponse {
    schemaVersion: 1;
    readOnly: true;
    researchOnly: true;
    executable: false;
    execution: "none";
    verificationStatus: "sequence-verified-paper-candidate";
    marketDataMode: "sequence-verified-depth";
    venue: TriangularDepthVenue;
    startAsset: string;
    requestedStartQuantity: number;
    symbols: readonly [string, string, string];
    evaluatedAt: number;
    books: readonly [TriangularDepthEvidence, TriangularDepthEvidence, TriangularDepthEvidence];
    totalOpportunities: number;
    opportunities: readonly VerifiedTriangularOpportunity[];
    rejections: readonly TriangularDepthRejection[];
}
