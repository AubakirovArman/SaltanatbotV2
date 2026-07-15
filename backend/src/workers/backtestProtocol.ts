import { runBacktest, type BacktestResult } from "@saltanatbotv2/backtest-core";
import type { Candle } from "@saltanatbotv2/contracts";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";

export interface BacktestTask {
  strategy: StrategyIR;
  candles: Candle[];
  config: Parameters<typeof runBacktest>[2];
  context?: Parameters<typeof runBacktest>[4];
}

export function parseBacktestTask(input: unknown): BacktestTask {
  if (!isRecord(input) || !isRecord(input.strategy) || !isRecord(input.config) || !Array.isArray(input.candles)) {
    throw new Error("Invalid backtest task payload.");
  }
  if (input.candles.length < 10 || input.candles.length > 20_000) {
    throw new Error("Backtest task candle count is outside the allowed range.");
  }
  return input as unknown as BacktestTask;
}

export function compactBacktestReport(report: BacktestResult): Record<string, unknown> {
  return {
    schemaVersion: report.schemaVersion,
    kind: "saltanat-backtest-job-result",
    name: report.name,
    metrics: report.metrics,
    tested: report.tested,
    metadata: report.metadata,
    provenance: report.provenance,
    trades: report.trades.slice(0, 5_000),
    tradesTruncated: report.trades.length > 5_000,
    equityCurve: sample(report.equityCurve, 2_000),
    equityCurveSampled: report.equityCurve.length > 2_000,
    warnings: report.warnings.slice(0, 500),
    warningsTruncated: report.warnings.length > 500,
    alerts: report.alerts.slice(0, 500),
    alertsTruncated: report.alerts.length > 500,
    signals: report.signals.slice(0, 2_000),
    signalsTruncated: report.signals.length > 2_000
  };
}

function sample<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values;
  const stride = (values.length - 1) / (maximum - 1);
  return Array.from({ length: maximum }, (_, index) => values[Math.round(index * stride)]!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
