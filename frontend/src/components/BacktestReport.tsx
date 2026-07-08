import { LineChart, Target } from "lucide-react";
import { useMemo, useState } from "react";
import type { BacktestConfig, BacktestResult, Trade } from "../strategy/backtest";
import { monteCarlo, type MonteCarloStats } from "../strategy/montecarlo";

interface BacktestReportProps {
  result: BacktestResult;
  decimals: number;
  config?: BacktestConfig;
  onShowOnChart?: () => void;
}

type SortKey = "entryTime" | "pnl" | "pnlPct" | "barsHeld" | "maePct" | "mfePct";

export function BacktestReport({ result, decimals, config, onShowOnChart }: BacktestReportProps) {
  const { metrics, tested } = result;
  const positive = metrics.netProfit >= 0;

  // Monte Carlo is cheap enough to derive from the realised trades on render.
  const mc = useMemo(
    () => monteCarlo(result.trades, { initialCapital: config?.initialCapital ?? 10_000 }, 1000),
    [result.trades, config?.initialCapital]
  );

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

      {metrics.liquidated && (
        <div className="strategy-warnings" role="alert">
          <span>Account was liquidated — the run stopped early. Results below are truncated.</span>
        </div>
      )}

      <div className="metric-grid">
        <Metric label="Net profit" value={`${positive ? "+" : ""}${metrics.netProfit.toFixed(2)}`} tone={positive ? "up" : "down"} sub={`${metrics.netProfitPct.toFixed(2)}%`} />
        <Metric label="Win rate" value={`${metrics.winRate.toFixed(1)}%`} sub={`${metrics.wins}/${metrics.totalTrades}`} />
        <Metric label="Profit factor" value={fmt(metrics.profitFactor)} />
        <Metric label="Max drawdown" value={`${metrics.maxDrawdownPct.toFixed(1)}%`} tone="down" sub={`-${metrics.maxDrawdown.toFixed(2)}`} />
        <Metric label="Sharpe" value={metrics.sharpe.toFixed(2)} />
        <Metric label="Trades" value={String(metrics.totalTrades)} />
        <Metric label="Avg trade" value={metrics.avgTrade.toFixed(2)} tone={metrics.avgTrade >= 0 ? "up" : "down"} />
        <Metric label="Time in market" value={`${metrics.timeInMarketPct.toFixed(0)}%`} />
        <Metric label="Avg MAE" value={`${metrics.avgMaePct.toFixed(2)}%`} tone="down" />
        <Metric label="Avg MFE" value={`${metrics.avgMfePct.toFixed(2)}%`} tone="up" />
      </div>

      <AssumptionsBar result={result} tested={tested} config={config} />

      <EquityCurve result={result} mc={mc} />
      <UnderwaterCurve result={result} />

      {mc && <MonteCarloPanel mc={mc} initial={config?.initialCapital ?? 10_000} />}

      <TradeTable trades={result.trades} decimals={decimals} />
    </div>
  );
}

function AssumptionsBar({ result, tested, config }: { result: BacktestResult; tested: BacktestResult["tested"]; config?: BacktestConfig }) {
  const fee = config?.commissionPct ?? 0.05;
  const slip = config?.slippagePct ?? 0.02;
  const lev = config?.maxLeverage ?? 5;
  const timing = config?.fillTiming ?? "next_open";
  return (
    <div className="assumptions">
      <span title="Bars measured after indicator warm-up">
        Tested {fmt0(tested.bars)} bars · warm-up {fmt0(tested.warmupBars)}
      </span>
      <span>{fmtRange(tested.fromTime, tested.toTime)}</span>
      <span>Fee {fee}% · slip {slip}% · {lev}x max · {timing === "next_open" ? "next-open fills" : "close fills"}</span>
      {result.warnings.length > 0 && (
        <span className="warn-count" title={result.warnings.slice(-6).map((w) => w.message).join("\n")}>
          {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

function MonteCarloPanel({ mc, initial }: { mc: MonteCarloStats; initial: number }) {
  const ruin = mc.riskOfRuin * 100;
  const half = mc.riskOfHalf * 100;
  return (
    <div className="montecarlo">
      <div className="panel-header small">
        <strong>Monte Carlo</strong>
        <span>{fmt0(mc.runs)} paths</span>
      </div>
      <div className="mc-grid">
        <McCell label="Net p5" value={mc.netProfit.p5.toFixed(0)} tone={mc.netProfit.p5 >= 0 ? "up" : "down"} />
        <McCell label="Net p50" value={mc.netProfit.p50.toFixed(0)} tone={mc.netProfit.p50 >= 0 ? "up" : "down"} />
        <McCell label="Net p95" value={mc.netProfit.p95.toFixed(0)} tone={mc.netProfit.p95 >= 0 ? "up" : "down"} />
        <McCell label="DD p50" value={`${mc.maxDrawdownPct.p50.toFixed(1)}%`} tone="down" />
        <McCell label="DD p95" value={`${mc.maxDrawdownPct.p95.toFixed(1)}%`} tone="down" />
        <McCell label="Risk of ruin" value={`${ruin.toFixed(1)}%`} tone={ruin > 5 ? "down" : undefined} />
        <McCell label="Risk of -50%" value={`${half.toFixed(1)}%`} tone={half > 10 ? "down" : undefined} />
        <McCell label="Start" value={fmt0(initial)} />
      </div>
    </div>
  );
}

function McCell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="mc-cell">
      <span className="metric-label">{label}</span>
      <strong className={tone ? `mc-value ${tone}` : "mc-value"}>{value}</strong>
    </div>
  );
}

function TradeTable({ trades, decimals }: { trades: Trade[]; decimals: number }) {
  const [sortKey, setSortKey] = useState<SortKey>("entryTime");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const rows = [...trades];
    rows.sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return asc ? diff : -diff;
    });
    return rows.slice(0, 60);
  }, [trades, sortKey, asc]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) setAsc((v) => !v);
    else { setSortKey(key); setAsc(false); }
  };
  const arrow = (key: SortKey) => (key === sortKey ? (asc ? " ▲" : " ▼") : "");

  return (
    <div className="trade-list">
      <div className="panel-header small">
        <strong>Trades</strong>
        <span>{trades.length}</span>
      </div>
      {trades.length === 0 ? (
        <p className="empty-note">No trades were triggered on this history. Check your entry condition.</p>
      ) : (
        <div className="trade-table wide" role="table">
          <div className="trade-row head" role="row">
            <span>Dir</span>
            <button type="button" className="th" onClick={() => setSort("entryTime")}>Entry{arrow("entryTime")}</button>
            <span>Exit</span>
            <button type="button" className="th" onClick={() => setSort("pnl")}>PnL{arrow("pnl")}</button>
            <button type="button" className="th" onClick={() => setSort("pnlPct")}>%{arrow("pnlPct")}</button>
            <button type="button" className="th" onClick={() => setSort("barsHeld")}>Bars{arrow("barsHeld")}</button>
            <button type="button" className="th" onClick={() => setSort("maePct")}>MAE{arrow("maePct")}</button>
            <button type="button" className="th" onClick={() => setSort("mfePct")}>MFE{arrow("mfePct")}</button>
            <span>Reason</span>
          </div>
          {sorted.map((trade, index) => (
            <div className="trade-row" role="row" key={`${trade.entryIndex}-${trade.exitIndex}-${index}`}>
              <span className={trade.direction === "long" ? "up" : "down"}>{trade.direction}</span>
              <span title={fmtTime(trade.entryTime)}>{trade.entryPrice.toFixed(decimals)}</span>
              <span title={fmtTime(trade.exitTime)}>{trade.exitPrice.toFixed(decimals)}</span>
              <span className={trade.pnl >= 0 ? "up" : "down"}>{trade.pnl >= 0 ? "+" : ""}{trade.pnl.toFixed(2)}</span>
              <span className={trade.pnlPct >= 0 ? "up" : "down"}>{trade.pnlPct.toFixed(1)}</span>
              <span>{trade.barsHeld}</span>
              <span className="down">{trade.maePct.toFixed(1)}</span>
              <span className="up">{trade.mfePct.toFixed(1)}</span>
              <span className="reason">{trade.reason}</span>
            </div>
          ))}
        </div>
      )}
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

function EquityCurve({ result, mc }: { result: BacktestResult; mc: MonteCarloStats | null }) {
  const points = result.equityCurve;
  if (points.length < 2) return null;
  const width = 520;
  const height = 120;
  const equities = points.map((point) => point.equity);

  // Fold optional Monte Carlo percentile bands into the min/max so bands fit.
  const bandValues = mc?.bands ? [...mc.bands.p5, ...mc.bands.p95] : [];
  const min = Math.min(...equities, ...(bandValues.length ? bandValues : equities));
  const max = Math.max(...equities, ...(bandValues.length ? bandValues : equities));
  const span = max - min || 1;
  const start = equities[0];
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (value: number) => height - ((value - min) / span) * height;
  const path = points.map((point, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(point.equity).toFixed(1)}`).join(" ");
  const baselineY = y(start);
  const up = equities.at(-1)! >= start;
  const color = up ? "#23c97a" : "#ef5350";

  // Map the MC per-trade bands (0..tradesPerRun) across the full curve width.
  const band = mc?.bands
    ? (() => {
        const n = mc.bands.p5.length;
        if (n < 2) return null;
        const bx = (i: number) => (i / (n - 1)) * width;
        const top = mc.bands.p95.map((v, i) => `${i === 0 ? "M" : "L"}${bx(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        const bottomRev = [...mc.bands.p5].map((v, i) => ({ v, i })).reverse()
          .map(({ v, i }) => `L${bx(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        return `${top} ${bottomRev} Z`;
      })()
    : null;

  return (
    <div className="equity-curve">
      <div className="panel-header small">
        <strong>Equity</strong>
        <span>{result.equityCurve.at(-1)!.equity.toFixed(0)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
        {band && <path d={band} fill="rgba(141,155,179,0.16)" stroke="none" />}
        <line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke="rgba(141,155,179,0.4)" strokeDasharray="4 4" strokeWidth={1} />
        <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
      </svg>
    </div>
  );
}

/** Underwater plot: percent below the running equity peak over time. */
function UnderwaterCurve({ result }: { result: BacktestResult }) {
  const points = result.equityCurve;
  if (points.length < 2) return null;
  const width = 520;
  const height = 60;
  let peak = points[0].equity;
  const dd = points.map((point) => {
    peak = Math.max(peak, point.equity);
    return peak > 0 ? ((point.equity - peak) / peak) * 100 : 0; // <= 0
  });
  const worst = Math.min(...dd, 0);
  const span = Math.abs(worst) || 1;
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (value: number) => (-value / span) * height; // 0 at top, worst at bottom
  const path = dd.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");

  return (
    <div className="equity-curve underwater">
      <div className="panel-header small">
        <strong>Drawdown</strong>
        <span>{worst.toFixed(1)}%</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Underwater drawdown">
        <path d={`${path} L${width},0 L0,0 Z`} fill="#ef5350" opacity={0.14} />
        <path d={path} fill="none" stroke="#ef5350" strokeWidth={1.4} />
      </svg>
    </div>
  );
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(2);
}

function fmt0(value: number): string {
  return Math.round(value).toLocaleString();
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtRange(from: number, to: number): string {
  if (!from || !to) return "—";
  const d = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
  return `${d(from)} → ${d(to)}`;
}
