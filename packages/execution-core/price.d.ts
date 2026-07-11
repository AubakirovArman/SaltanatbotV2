export type ExecutionDirection = "long" | "short";
export interface ProtectionLevel {
    mode: "price" | "percent" | "atr";
    value: number;
}
export declare function applyExecutionSlippage(price: number, direction: ExecutionDirection, entering: boolean, slippagePct: number): number;
export declare function resolveProtectionPrice(kind: "stop" | "target", direction: ExecutionDirection, entry: number, level: ProtectionLevel | undefined, atr: number): number | undefined;
