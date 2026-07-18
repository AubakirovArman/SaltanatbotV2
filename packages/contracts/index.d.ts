/** Canonical transport-neutral market contracts shared by browser and server. */
export * from "./alerts.js";
export * from "./alertRecords.js";
export * from "./chartGeometry.js";
export * from "./screener.js";
export type AssetClass = "crypto" | "forex" | "stock" | "index";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1M";
export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "step" | "area" | "baseline" | "renko" | "linebreak" | "kagi" | "pnf";
export type DataExchange = "binance" | "bybit";
export type DataMarketType = "spot" | "linear" | "inverse";
export type PriceType = "last" | "mark" | "index";
/** Route used by chart candle transports. Kept separate from generic venue taxonomy. */
export interface ChartDataRoute {
    exchange: DataExchange;
    marketType: DataMarketType;
    priceType: PriceType;
}
/** Extensible venue/instrument contract used by scanners and future adapters. */
export type VenueId = string;
export type VenueMarketType = "spot" | "margin" | "perpetual" | "future" | "option" | "native-spread";
/** Market scope with a periodic funding-settlement contract in the public facade. */
export type VenueFundingMarketType = "perpetual";
export type VenuePriceType = "last" | "mark" | "index";
export type ContractDirection = "linear" | "inverse" | "quanto";
export type VenueQuantityUnit = "base" | "quote" | "contract";
export interface VenueDynamicPriceRules {
    staticTickSize: false;
    maxSignificantFigures: number;
    maxDecimals: number;
    integerPricesAlwaysAllowed: boolean;
}
export interface MarketRouteRef {
    venue: VenueId;
    marketType: VenueMarketType;
    symbol: string;
    priceType: VenuePriceType;
}
export interface RegistryInstrument {
    /** Stable internal identifier: venue:market:native-symbol. */
    id: string;
    /** Venue-native asset identifier. This value alone is not cross-venue identity proof. */
    assetId: string;
    /**
     * Reviewed canonical economic identity shared across venues. Omitted unless an explicit
     * identity mapping exists; consumers must fail closed when cross-venue identity matters.
     */
    economicAssetId?: string;
    venue: VenueId;
    venueSymbol: string;
    baseAsset: string;
    quoteAsset: string;
    settleAsset: string;
    marketType: VenueMarketType;
    contractDirection?: ContractDirection;
    /** Effective base/value units represented by one derivative contract. */
    contractMultiplier: number;
    /** Native venue contract value before any additional multiplier. */
    contractValue?: number;
    contractValueCurrency?: string;
    /** Unit used by venue quantityStep/minimumQuantity and public depth sizes. */
    quantityUnit?: VenueQuantityUnit;
    underlying?: string;
    instrumentFamily?: string;
    /** Positive static increment, or zero only when dynamic priceRules are supplied. */
    tickSize: number;
    priceRules?: VenueDynamicPriceRules;
    quantityStep: number;
    minimumQuantity: number;
    minimumNotional: number;
    status: "trading" | "prelaunch" | "settling" | "closed";
    fundingIntervalMinutes?: number;
    expiryTime?: number;
    strikePrice?: number;
    optionType?: "call" | "put";
}
export interface VenueCapabilityManifest {
    venue: VenueId;
    publicData: boolean;
    spot: boolean;
    margin: boolean;
    perpetual: boolean;
    datedFuture: boolean;
    option: boolean;
    nativeSpread: boolean;
    topBook: boolean;
    depth: boolean;
    publicTrades: boolean;
    funding: boolean;
    borrow: boolean;
    depositWithdrawal: boolean;
    privateExecution: boolean;
    demoEnvironment: boolean;
    /**
     * Product/operation-specific application scope. Missing combinations are unsupported.
     * The legacy booleans above are conservative discovery summaries and must never be
     * used to authorize account mutations.
     */
    scopes?: VenueCapabilityScope[];
}
export type VenueCapabilityProduct = VenueMarketType | "account";
export type VenueCapabilityOperation = "public-data" | "private-execution" | "borrow" | "deposit-withdrawal";
export type VenueCapabilityStatus = "implemented" | "experimental" | "manual-only";
export interface VenueCapabilityScope {
    product: VenueCapabilityProduct;
    operation: VenueCapabilityOperation;
    status: VenueCapabilityStatus;
}
export interface Instrument {
    symbol: string;
    displayName: string;
    assetClass: AssetClass;
    exchange: string;
    currency: string;
    provider: "binance" | "synthetic";
    /** Positive reference quote used only for a clearly labelled synthetic fallback. */
    basePrice: number;
    decimals: number;
}
export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    final?: boolean;
    source?: string;
}
export interface CatalogResponse {
    instruments: Instrument[];
    timeframes: Timeframe[];
    chartTypes: ChartType[];
}
export interface CandlesResponse {
    instrument: Instrument;
    candles: Candle[];
    provider: string;
    hasMore?: boolean;
}
export interface SparklineSeries {
    last: number | null;
    changePct: number;
    points: number[];
}
export interface SparklinesResponse {
    timeframe: Timeframe;
    series: Record<string, SparklineSeries | null>;
}
export interface QuotesSnapshotMessage {
    type: "quotes_snapshot";
    timeframe: Timeframe;
    series: Record<string, SparklineSeries | null>;
    provider: string;
    ts: number;
}
export interface QuoteMessage {
    type: "quote";
    symbol: string;
    timeframe: Timeframe;
    series: SparklineSeries;
    provider: string;
    ts: number;
}
export type QuoteStreamMessage = QuotesSnapshotMessage | QuoteMessage | ErrorMessage;
export type MarketStatus = "connected" | "fallback" | "error";
export interface StreamStatus {
    type: "status";
    status: MarketStatus;
    provider: string;
    message: string;
    ts: number;
}
export interface SnapshotMessage {
    type: "snapshot";
    symbol: string;
    timeframe: Timeframe;
    candles: Candle[];
    provider: string;
    ts: number;
}
export interface CandleMessage {
    type: "candle";
    symbol: string;
    timeframe: Timeframe;
    candle: Candle;
    provider: string;
    ts: number;
}
export type OrderBookLevel = [price: number, size: number];
export type OrderBookStatus = "connecting" | "connected" | "reconnecting" | "stale" | "error";
export interface OrderBookSnapshotMessage {
    type: "orderbook";
    symbol: string;
    exchange: DataExchange;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    sequence: number;
    exchangeTs: number;
    ts: number;
}
export interface OrderBookStatusMessage {
    type: "orderbook_status";
    symbol: string;
    exchange: DataExchange;
    status: OrderBookStatus;
    message: string;
    ts: number;
}
export type OrderBookStreamMessage = OrderBookSnapshotMessage | OrderBookStatusMessage | ErrorMessage;
export type TradeFlowSide = "buy" | "sell";
export type TradeFlowStatus = "connecting" | "connected" | "reconnecting" | "stale" | "error";
export interface TradeFlowTrade {
    id: string;
    price: number;
    size: number;
    side: TradeFlowSide;
    exchangeTs: number;
}
export interface TradeFlowBatchMessage {
    type: "trade_flow";
    symbol: string;
    exchange: DataExchange;
    trades: TradeFlowTrade[];
    ts: number;
}
export interface TradeFlowStatusMessage {
    type: "trade_flow_status";
    symbol: string;
    exchange: DataExchange;
    status: TradeFlowStatus;
    message: string;
    ts: number;
}
export type TradeFlowStreamMessage = TradeFlowBatchMessage | TradeFlowStatusMessage | ErrorMessage;
export interface ErrorMessage {
    type: "error";
    message: string;
    ts: number;
}
export type StreamMessage = StreamStatus | SnapshotMessage | CandleMessage | ErrorMessage;
export declare function parseCandle(value: unknown, label?: string): Candle;
export declare function parseInstrument(value: unknown, label?: string): Instrument;
export declare function parseCatalogResponse(value: unknown): CatalogResponse;
export declare function parseCandlesResponse(value: unknown): CandlesResponse;
export declare function parseSparklinesResponse(value: unknown): SparklinesResponse;
export declare function parseQuoteStreamMessage(value: unknown): QuoteStreamMessage;
export declare function parseStreamMessage(value: unknown): StreamMessage;
export declare function parseOrderBookStreamMessage(value: unknown): OrderBookStreamMessage;
export declare function parseTradeFlowStreamMessage(value: unknown): TradeFlowStreamMessage;
