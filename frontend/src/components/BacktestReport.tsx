import { LineChart, Target } from "lucide-react";
import type { BacktestResult } from "../strategy/backtest";

interface BacktestReportProps {
  result: BacktestResult;
  decimals: number;
  onShowOnChart?: () => void;
}

export function BacktestReport({ result, decimals, onShowOnChart }: BacktestReportProps) {
  const { metrics } = result;
  const positive = metrics.netProfit >= 0;

  return (
    <div className="backtest-report">
      <div className="panel-header">
        <strong>
          <Target size={15} aria-hidden="true" />
          Backtest · {result.name}
        </strong>
        {onShowOnChart && (result.trades.length > 0 || result.signals.length > 0) && (
          <button type="button" className="link-button" onClick={onShowOnChart}>
            <LineChart size={13} aria-hidden="true" /> Show on chart
          </button>
        )}
      </div>

      <div className="metric-grid">
        <Metric label="Net profit" value={`${positive ? "+" : ""}${metrics.netProfit.toFixed(2)}`} tone={positive ? "up" : "down"} sub={`${metrics.netProfitPct.toFixed(2)}%`} />
        <Metric label="Win rate" value={`${metrics.winRate.toFixed(1)}%`} sub={`${metrics.wins}/${metrics.totalTrades}`} />
        <Metric label="Profit factor" value={fmt(metrics.profitFactor)} />
        <Metric label="Max drawdown" value={`${metrics.maxDrawdownPct.toFixed(1)}%`} tone="down" sub={`-${metrics.maxDrawdown.toFixed(2)}`} />
        <Metric label="Sharpe" value={metrics.sharpe.toFixed(2)} />
        <Metric label="Trades" value={String(metrics.totalTrades)} />
        <Metric label="Avg trade" value={metrics.avgTrade.toFixed(2)} tone={metrics.avgTrade >= 0 ? "up" : "down"} />
        <Metric label="Time in market" value={`${metrics.timeInMarketPct.toFixed(0)}%`} />
      </div>

      <EquityCurve result={result} />

      <div className="trade-list">
        <div className="panel-header small">
          <strong>Trades</strong>
          <span>{result.trades.length}</span>
        </div>
        {result.trades.length === 0 ? (
          <p className="empty-note">No trades were triggered on this history. Check your entry condition.</p>
        ) : (
          <div className="trade-table" role="table">
            <div className="trade-row head" role="row">
              <span>Dir</span><span>Entry</span><span>Exit</span><span>PnL</span><span>Reason</span>
            </div>
            {result.trades.slice(-40).reverse().map((trade, index) => (
              <div className="trade-row" role="row" key={`${trade.entryIndex}-${index}`}>
                <span className={trade.direction === "long" ? "up" : "down"}>{trade.direction}</span>
                <span>{trade.entryPrice.toFixed(decimals)}</span>
                <span>{trade.exitPrice.toFixed(decimals)}</span>
                <span className={trade.pnl >= 0 ? "up" : "down"}>{trade.pnl >= 0 ? "+" : ""}{trade.pnl.toFixed(2)}</span>
                <span className="reason">{trade.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className={tone ? `metric-value ${tone}` : "metric-value"}>{value}</strong>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}

function EquityCurve({ result }: { result: BacktestResult }) {
  const points = result.equityCurve;
  if (points.length < 2) return null;
  const width = 520;
  const height = 120;
  const equities = points.map((point) => point.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const span = max - min || 1;
  const start = equities[0];
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (value: number) => height - ((value - min) / span) * height;
  const path = points.map((point, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(point.equity).toFixed(1)}`).join(" ");
  const baselineY = y(start);
  const up = equities.at(-1)! >= start;
  const color = up ? "#23c97a" : "#ef5350";

  return (
    <div className="equity-curve">
      <div className="panel-header small">
        <strong>Equity</strong>
        <span>{result.equityCurve.at(-1)!.equity.toFixed(0)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
        <line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke="rgba(141,155,179,0.4)" strokeDasharray="4 4" strokeWidth={1} />
        <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
      </svg>
    </div>
  );
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(2);
}
