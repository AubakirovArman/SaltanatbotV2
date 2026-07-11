export interface ExecutionSizeSpec {
    mode: "units" | "equity_pct" | "risk_pct";
    value: number;
}
export interface ExecutionSizeConstraints {
    /** Multiplier applied only to equity-percent sizing. */
    leverage?: number;
    /** Absolute notional cap expressed as a multiple of equity. */
    maxLeverage?: number;
    qtyStep?: number;
}
export interface ExecutionSizeResult {
    qty: number;
    warning?: string;
}
export declare function resolveExecutionSize(sizing: ExecutionSizeSpec, equity: number, price: number, stopPrice: number | undefined, constraints?: ExecutionSizeConstraints): ExecutionSizeResult;
