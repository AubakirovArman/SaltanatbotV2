import { Download, LineChart, Target } from "lucide-react";
import { useMemo, useState } from "react";
import type { BacktestConfig, BacktestResult, Trade } from "../strategy/backtest";
import { monteCarlo, type MonteCarloStats } from "../strategy/montecarlo";
import { localeTag, type Locale } from "../i18n";
import { strategyText } from "../i18n/strategy";
import { serializeBacktestResearchFile } from "@saltanatbotv2/backtest-core";
import { BacktestReplayPanel } from "../strategy/components/BacktestReplayPanel";

interface BacktestReportProps {
  locale: Locale;
  result: BacktestResult;
  decimals: number;
  config?: BacktestConfig;
  onShowOnChart?: () => void;
}

type SortKey = "entryTime" | "pnl" | "pnlPct" | "barsHeld" | "maePct" | "mfePct";

export function BacktestReport({ locale, result, decimals, config, onShowOnChart }: BacktestReportProps) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const { metrics, tested } = result;
  const positive = metrics.netProfit >= 0;
  const reportConfig = result.metadata.config ?? config;

  // Monte Carlo is cheap enough to derive from the realised trades on render.
  const mc = useMemo(
    () => monteCarlo(result.trades, { initialCapital: reportConfig?.initialCapital ?? 10_000 }, 1000),
    [result.trades, reportConfig?.initialCapital]
  );

  return (
    <div className="backtest-report">
      <div className="panel-header">
        <strong>
          <Target size={15} aria-hidden="true" />
          {t("backtest")} · {result.name}
        </strong>
        {onShowOnChart && (result.trades.length > 0 || result.signals.length > 0) && (
          <button type="button" className="link-button" onClick={onShowOnChart}>
            <LineChart size={13} aria-hidden="true" /> {t("showOnChart")}
          </button>
        )}
        <button type="button" className="link-button" onClick={() => downloadResearchReport(result)}>
          <Download size={13} aria-hidden="true" /> {t("exportReport")}
        </button>
      </div>

      {metrics.liquidated && (
        <div className="strategy-warnings" role="alert">
          <span>{t("liquidated")}</span>
        </div>
      )}

      {!result.provenance.performanceClaimsValid && (
        <div className="strategy-warnings provenance-warning" role="alert">
          <span>{provenanceWarning(locale, result.provenance.status)}</span>
        </div>
      )}

      <div className="metric-grid">
        <Metric label={t("netProfit")} value={`${positive ? "+" : ""}${metrics.netProfit.toFixed(2)}`} tone={positive ? "up" : "down"} sub={`${metrics.netProfitPct.toFixed(2)}%`} />
        <Metric label={t("winRate")} value={`${metrics.winRate.toFixed(1)}%`} sub={`${metrics.wins}/${metrics.totalTrades}`} />
        <Metric label={t("profitFactor")} value={fmt(metrics.profitFactor)} />
        <Metric label={t("maxDrawdown")} value={`${metrics.maxDrawdownPct.toFixed(1)}%`} tone="down" sub={`-${metrics.maxDrawdown.toFixed(2)}`} />
        <Metric label={t("sharpe")} value={metrics.sharpe.toFixed(2)} />
        <Metric label={t("trades")} value={String(metrics.totalTrades)} />
        <Metric label={t("avgTrade")} value={metrics.avgTrade.toFixed(2)} tone={metrics.avgTrade >= 0 ? "up" : "down"} />
        <Metric label={t("timeInMarket")} value={`${metrics.timeInMarketPct.toFixed(0)}%`} />
        <Metric label={t("avgMae")} value={`${metrics.avgMaePct.toFixed(2)}%`} tone="down" />
        <Metric label={t("avgMfe")} value={`${metrics.avgMfePct.toFixed(2)}%`} tone="up" />
        {(reportConfig?.fundingRatePctPer8h ?? 0) !== 0 && (
          <Metric label={t("fundingPaid")} value={`-${metrics.fundingPaid.toFixed(2)}`} tone="down" sub={`${reportConfig?.fundingRatePctPer8h}%/8h`} />
        )}
      </div>

      <AssumptionsBar locale={locale} result={result} tested={tested} config={reportConfig} />

      {(result.metadata.dataQuality.partiallyLoaded || result.metadata.dataQuality.missingBars > 0) && (
        <div className="strategy-warnings" role="alert">
          <span>
            {result.metadata.dataQuality.partiallyLoaded
              ? `${t("partialHistory")}: ${result.metadata.dataQuality.loadedBars}/${result.metadata.dataQuality.requestedBars}. `
              : ""}
            {result.metadata.dataQuality.missingBars > 0
              ? `${t("dataGaps")}: ${result.metadata.dataQuality.missingBars}.`
              : ""}
          </span>
        </div>
      )}

      <EquityCurve locale={locale} result={result} mc={mc} />
      <UnderwaterCurve locale={locale} result={result} />

      <BacktestReplayPanel locale={locale} result={result} />

      {mc && <MonteCarloPanel locale={locale} mc={mc} initial={reportConfig?.initialCapital ?? 10_000} />}

      <TradeTable locale={locale} trades={result.trades} decimals={decimals} />
      <StatePanel locale={locale} result={result} />
    </div>
  );
}

function downloadResearchReport(result: BacktestResult): void {
  const blob = new Blob([serializeBacktestResearchFile(result)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${result.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "backtest"}.saltanat-report.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Final values of the strategy's variables (only shown when the strategy uses state). */
function StatePanel({ locale, result }: { locale: Locale; result: BacktestResult }) {
  const last = result.varTrace?.at(-1);
  if (!last || Object.keys(last.vars).length === 0) return null;
  return (
    <div className="strategy-state">
      <div className="panel-header small">
        <h4>{strategyText(locale, "variablesFinal")}</h4>
      </div>
      <div className="metric-grid">
        {Object.entries(last.vars).map(([name, value]) => (
          <Metric key={name} label={name} value={Number.isFinite(value) ? String(Math.round(value * 1e4) / 1e4) : "—"} />
        ))}
      </div>
    </div>
  );
}

function AssumptionsBar({ locale, result, tested, config }: { locale: Locale; result: BacktestResult; tested: BacktestResult["tested"]; config?: BacktestConfig }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const fee = config?.commissionPct ?? 0.05;
  const slip = config?.slippagePct ?? 0.02;
  const lev = config?.maxLeverage ?? 5;
  const timing = config?.fillTiming ?? "next_open";
  const funding = config?.fundingRatePctPer8h ?? 0;
  return (
    <div className="assumptions">
      <span title={t("testedHelp")}>
        {t("tested")} {fmt0(tested.bars, locale)} {t("bars").toLowerCase()} · {t("warmup")} {fmt0(tested.warmupBars, locale)}
      </span>
      <span>{fmtRange(tested.fromTime, tested.toTime, locale)}</span>
      <span>{t("feeShort")} {fee}% · {t("slipShort")} {slip}% · {lev}x {t("maxShort")} · {timing === "next_open" ? t("nextOpenFills") : t("closeFills")}{funding !== 0 ? ` · ${t("funding")} ${funding}%` : ""}</span>
      <span title={provenanceDetails(locale, result)}>
        {t("data")} {result.provenance.status} · {fmt0(result.provenance.chartBars, locale)} {t("chartBars")}{result.provenance.securityBars > 0 ? ` · ${fmt0(result.provenance.securityBars, locale)} ${t("securityBars")}` : ""}
      </span>
      {result.warnings.length > 0 && (
        <span className="warn-count" title={result.warnings.slice(-6).map((w) => w.message).join("\n")}>
          {result.warnings.length} {t(result.warnings.length === 1 ? "warning" : "warnings")}
        </span>
      )}
    </div>
  );
}

function provenanceWarning(locale: Locale, status: BacktestResult["provenance"]["status"]): string {
  if (status === "fallback") {
    return strategyText(locale, "provenanceFallback");
  }
  if (status === "mixed") {
    return strategyText(locale, "provenanceMixed");
  }
  return strategyText(locale, "provenanceUnknown");
}

function provenanceDetails(locale: Locale, result: BacktestResult): string {
  if (result.provenance.sources.length === 0) return strategyText(locale, "noCandleSources");
  return result.provenance.sources
    .map((source) => `${source.scope}: ${source.source} (${fmt0(source.bars, locale)} ${strategyText(locale, "bars").toLowerCase()}, ${source.kind})`)
    .join("\n");
}

function MonteCarloPanel({ locale, mc, initial }: { locale: Locale; mc: MonteCarloStats; initial: number }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const ruin = mc.riskOfRuin * 100;
  const half = mc.riskOfHalf * 100;
  return (
    <div className="montecarlo">
      <div className="panel-header small">
        <strong>{t("monteCarlo")}</strong>
        <span>{fmt0(mc.runs, locale)} {t("paths")}</span>
      </div>
      <div className="mc-grid">
        <McCell label="Net p5" value={mc.netProfit.p5.toFixed(0)} tone={mc.netProfit.p5 >= 0 ? "up" : "down"} />
        <McCell label="Net p50" value={mc.netProfit.p50.toFixed(0)} tone={mc.netProfit.p50 >= 0 ? "up" : "down"} />
        <McCell label="Net p95" value={mc.netProfit.p95.toFixed(0)} tone={mc.netProfit.p95 >= 0 ? "up" : "down"} />
        <McCell label="DD p50" value={`${mc.maxDrawdownPct.p50.toFixed(1)}%`} tone="down" />
        <McCell label="DD p95" value={`${mc.maxDrawdownPct.p95.toFixed(1)}%`} tone="down" />
        <McCell label={t("riskOfRuin")} value={`${ruin.toFixed(1)}%`} tone={ruin > 5 ? "down" : undefined} />
        <McCell label={t("riskOfHalf")} value={`${half.toFixed(1)}%`} tone={half > 10 ? "down" : undefined} />
        <McCell label={t("start")} value={fmt0(initial, locale)} />
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

function TradeTable({ locale, trades, decimals }: { locale: Locale; trades: Trade[]; decimals: number }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
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
        <strong>{t("trades")}</strong>
        <span>{trades.length}</span>
      </div>
      {trades.length === 0 ? (
        <p className="empty-note">{t("noTrades")}</p>
      ) : (
        <div className="trade-table wide" role="table">
          <div className="trade-row head" role="row">
            <span>{t("direction")}</span>
            <button type="button" className="th" onClick={() => setSort("entryTime")}>{t("entry")}{arrow("entryTime")}</button>
            <span>{t("exit")}</span>
            <button type="button" className="th" onClick={() => setSort("pnl")}>PnL{arrow("pnl")}</button>
            <button type="button" className="th" onClick={() => setSort("pnlPct")}>%{arrow("pnlPct")}</button>
            <button type="button" className="th" onClick={() => setSort("barsHeld")}>{t("bars")}{arrow("barsHeld")}</button>
            <button type="button" className="th" onClick={() => setSort("maePct")}>MAE{arrow("maePct")}</button>
            <button type="button" className="th" onClick={() => setSort("mfePct")}>MFE{arrow("mfePct")}</button>
            <span>{t("reason")}</span>
          </div>
          {sorted.map((trade, index) => (
            <div className="trade-row" role="row" key={`${trade.entryIndex}-${trade.exitIndex}-${index}`}>
              <span className={trade.direction === "long" ? "up" : "down"}>{t(trade.direction === "long" ? "long" : "short")}</span>
              <span title={fmtTime(trade.entryTime, locale)}>{trade.entryPrice.toFixed(decimals)}</span>
              <span title={fmtTime(trade.exitTime, locale)}>{trade.exitPrice.toFixed(decimals)}</span>
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

function EquityCurve({ locale, result, mc }: { locale: Locale; result: BacktestResult; mc: MonteCarloStats | null }) {
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
        <strong>{strategyText(locale, "equity")}</strong>
        <span>{result.equityCurve.at(-1)!.equity.toFixed(0)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={strategyText(locale, "equityCurve")}>
        {band && <path d={band} fill="rgba(141,155,179,0.16)" stroke="none" />}
        <line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke="rgba(141,155,179,0.4)" strokeDasharray="4 4" strokeWidth={1} />
        <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity={0.12} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
      </svg>
    </div>
  );
}

/** Underwater plot: percent below the running equity peak over time. */
function UnderwaterCurve({ locale, result }: { locale: Locale; result: BacktestResult }) {
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
        <strong>{strategyText(locale, "drawdown")}</strong>
        <span>{worst.toFixed(1)}%</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={strategyText(locale, "underwaterDrawdown")}>
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

function fmt0(value: number, locale: Locale = "en"): string {
  return Math.round(value).toLocaleString(localeTag(locale));
}

function fmtTime(ms: number, locale: Locale): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(localeTag(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtRange(from: number, to: number, locale: Locale): string {
  if (!from || !to) return "—";
  const d = (ms: number) => new Date(ms).toLocaleDateString(localeTag(locale), { month: "short", day: "numeric", year: "2-digit" });
  return `${d(from)} → ${d(to)}`;
}
