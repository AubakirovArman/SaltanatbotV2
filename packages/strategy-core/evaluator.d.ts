import type { Candle } from "@saltanatbotv2/contracts";
import type { BoolExpr, NumExpr, StrategyIR } from "./index.js";
import { type SecurityDataContext } from "./securityData.js";
export interface BarIntents {
    entry?: "long" | "short";
    exit: boolean;
    stop?: {
        mode: "price" | "percent" | "atr";
        value: number;
    };
    target?: {
        mode: "price" | "percent" | "atr";
        value: number;
    };
    trail?: {
        mode: "percent" | "atr";
        value: number;
    };
    size?: {
        mode: "units" | "equity_pct" | "risk_pct";
        value: number;
    };
    alerts: {
        message: string;
    }[];
    markers: {
        dir: "up" | "down";
        label: string;
    }[];
    /** Set when the bar hit the per-bar op budget and execution was truncated. */
    budgetExceeded?: boolean;
}
/** Hard shared per-bar execution budget for backtest, preview and live. */
export declare const MAX_OPS_PER_BAR = 10000;
/** Max iterations a single `repeat` can request (also clamped by the op budget). */
export declare const MAX_REPEAT = 1000;
export interface StrategyRuntime {
    candles: Candle[];
    n: number;
    params: Map<string, number>;
    vars: Map<string, number>;
    seriesCache: Map<string, number[]>;
    /** Statements/iterations executed this bar; guarded against MAX_OPS_PER_BAR. */
    ops: number;
    budgetHit: boolean;
    /** Position/PnL runtime context supplied per bar by the caller (ctx reads). */
    ctx: Record<string, number>;
    /** Optional external candles for request.security() expressions. */
    securityData?: SecurityDataContext;
    /** Snapshot of vars at the START of the bar — reads for `varprev` (x[1] on a var). */
    varsPrev: Map<string, number>;
}
/**
 * Evaluate the strategy IR at bar `index` over `candles`, returning the raw
 * intents produced on that bar. This is the exact same evaluation the backtest
 * engine uses, so live signals match backtested ones bar-for-bar.
 *
 * `vars` is the persistent variable store: the frontend backtester keeps one
 * store for the whole run, so `setvar` state (counters, saved levels) survives
 * across bars. Live callers must pass the SAME map every bar for parity —
 * omitting it (fresh map per bar) makes stateful strategies behave differently.
 * The series cache is always per-call (candles grow each bar, so it can't persist).
 */
export declare function evaluateBar(ir: StrategyIR, candles: Candle[], index: number, vars?: Map<string, number>, ctx?: Record<string, number>, securityData?: SecurityDataContext): BarIntents;
export interface StrategyRuntimeOptions {
    vars?: Map<string, number>;
    ctx?: Record<string, number>;
    securityData?: SecurityDataContext;
}
/** Create a reusable runtime for preview/backtest. Live callers may use
 * `evaluateBar()` when their candle buffer changes on every invocation. */
export declare function createStrategyRuntime(ir: StrategyIR, candles: Candle[], options?: StrategyRuntimeOptions): StrategyRuntime;
/** Reset per-bar state while preserving variables and memoized pure series. */
export declare function beginStrategyBar(rt: StrategyRuntime, ctx?: Record<string, number>): void;
/** Execute one bar against a reusable runtime and return canonical intents. */
export declare function evaluateStrategyBar(ir: StrategyIR, index: number, rt: StrategyRuntime, ctx?: Record<string, number>): BarIntents;
/**
 * Run the strategy's one-time `init` (on-start) statements, mutating `vars`.
 * Called once when a bot first starts (not on resume, where state is restored).
 * init is setvar-only, evaluated against the first available bar.
 */
export declare function runInit(ir: StrategyIR, candles: Candle[], vars: Map<string, number>): void;
/** Run one-time setvar initialization against an existing reusable runtime. */
export declare function runStrategyInit(ir: StrategyIR, rt: StrategyRuntime): void;
/** Current ATR(period) value at a bar — used by the engine for atr-based stops. */
export declare function atrValue(candles: Candle[], period: number, index: number): number;
export declare function evaluateNumber(expr: NumExpr, i: number, rt: StrategyRuntime): number;
export declare function evaluateCondition(expr: BoolExpr, i: number, rt: StrategyRuntime): boolean;
