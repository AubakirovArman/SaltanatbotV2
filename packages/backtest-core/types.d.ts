/** Runtime-neutral backtest result and configuration contracts. */
export interface BacktestConfig {
    initialCapital: number;
    commissionPct: number;
    slippagePct: number;
    allowShort: boolean;
    /** `next_open` matches the live engine; `same_close` is the legacy mode. */
    fillTiming?: "next_open" | "same_close";
    maxLeverage?: number;
    qtyStep?: number;
    fundingRatePctPer8h?: number;
}
export interface Trade {
    direction: "long" | "short";
    entryIndex: number;
    exitIndex: number;
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnl: number;
    pnlPct: number;
    reason: "signal" | "stop" | "target" | "close" | "liquidation";
    barsHeld: number;
    maePct: number;
    mfePct: number;
}
export interface EquityPoint {
    time: number;
    equity: number;
}
export interface TradeMarker {
    time: number;
    price: number;
    kind: "buy" | "sell" | "exit";
    label?: string;
}
export interface BacktestMetrics {
    netProfit: number;
    netProfitPct: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpe: number;
    avgTrade: number;
    expectancy: number;
    timeInMarketPct: number;
    finalEquity: number;
    avgMaePct: number;
    avgMfePct: number;
    fundingPaid: number;
    liquidated: boolean;
}
export interface TestedRange {
    fromTime: number;
    toTime: number;
    bars: number;
    warmupBars: number;
}
export interface BacktestResult {
    name: string;
    trades: Trade[];
    equityCurve: EquityPoint[];
    markers: TradeMarker[];
    signals: TradeMarker[];
    alerts: {
        time: number;
        message: string;
    }[];
    warnings: {
        time: number;
        message: string;
    }[];
    metrics: BacktestMetrics;
    tested: TestedRange;
    varTrace?: {
        time: number;
        vars: Record<string, number>;
    }[];
}
