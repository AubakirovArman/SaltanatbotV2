import type { BarIntents } from "@saltanatbotv2/strategy-core";
import type { BacktestConfig, Trade, TradeMarker } from "./types.js";
import { type Position } from "./broker.js";
export interface OpenPositionRequest {
    direction: "long" | "short";
    fill: number;
    index: number;
    time: number;
    stop?: BarIntents["stop"];
    target?: BarIntents["target"];
    trail?: BarIntents["trail"];
    size: NonNullable<BarIntents["size"]>;
    atr: number;
    equity: number;
    config: Required<BacktestConfig>;
}
export interface OpenPositionResult {
    position?: Position;
    marker?: TradeMarker;
    warning?: string;
}
export interface ClosePositionRequest {
    position: Position;
    index: number;
    time: number;
    price: number;
    reason: Trade["reason"];
    commissionPct: number;
}
export interface ClosePositionResult {
    trade: Trade;
    marker: TradeMarker;
    equityDelta: number;
}
export declare function openBacktestPosition(request: OpenPositionRequest): OpenPositionResult;
export declare function closeBacktestPosition(request: ClosePositionRequest): ClosePositionResult;
