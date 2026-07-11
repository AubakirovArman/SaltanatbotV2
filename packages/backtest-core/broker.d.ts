import type { BarIntents } from "@saltanatbotv2/strategy-core";
import type { Candle } from "@saltanatbotv2/contracts";
import type { BacktestConfig } from "./types.js";
export interface Position {
    dir: "long" | "short";
    qty: number;
    entryPrice: number;
    entryIndex: number;
    entryTime: number;
    stopPrice?: number;
    targetPrice?: number;
    trail?: {
        mode: "percent" | "atr";
        value: number;
    };
    /** Worst / best unrealized PnL observed while the position is open. */
    maeAbs: number;
    mfeAbs: number;
}
export interface SizeResult {
    qty: number;
    warning?: string;
}
export declare function applySlippage(price: number, direction: "long" | "short", entering: boolean, config: BacktestConfig): number;
export declare function resolveStop(direction: "long" | "short", entry: number, stop: NonNullable<BarIntents["stop"]>, atr: number): number;
export declare function resolveTarget(direction: "long" | "short", entry: number, target: NonNullable<BarIntents["target"]>, atr: number): number;
export declare function resolveSize(sizing: NonNullable<BarIntents["size"]>, equity: number, price: number, stopPrice: number | undefined, config: Required<BacktestConfig>): SizeResult;
export declare function stopHit(position: Position, candle: Candle): boolean;
export declare function targetHit(position: Position, candle: Candle): boolean;
export declare function unrealized(position: Position | null, price: number): number;
