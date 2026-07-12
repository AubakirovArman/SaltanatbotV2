/** Canonical transport-neutral market contracts shared by browser and server. */
export type AssetClass = "crypto" | "forex" | "stock" | "index";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w" | "1M";
export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "step" | "area" | "baseline" | "renko" | "linebreak" | "kagi";
export type DataExchange = "binance" | "bybit";
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
