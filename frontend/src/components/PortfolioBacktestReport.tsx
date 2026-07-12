import type { PortfolioBacktestResult, PortfolioRejectionReason } from "@saltanatbotv2/backtest-core";
import { Download, ShieldAlert } from "lucide-react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import { strategyText } from "../i18n/strategy";
import { PortfolioExecutionPanel } from "./PortfolioExecutionPanel";
import { PortfolioRiskPanel } from "./PortfolioRiskPanel";

interface PortfolioBacktestReportProps {
  locale: Locale;
  result: PortfolioBacktestResult;
}

export function PortfolioBacktestReport({ locale, result }: PortfolioBacktestReportProps) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const number = (value: number, digits = 2) => value.toLocaleString(localeTag(locale), { maximumFractionDigits: digits });
  const money = (value: number) => number(value, 2);
  const date = (value: number) => new Date(value).toLocaleDateString(localeTag(locale));
  const metrics = result.metrics;
  const path = equityPath(result.equityCurve.map((point) => point.equity));
  return (
    <section className="backtest-report portfolio-report" aria-labelledby="portfolio-report-title">
      <header className="report-title-row">
        <div><h3 id="portfolio-report-title">{t("portfolioBacktest")}</h3><p>{result.name} · {result.symbols.join(" · ")}</p></div>
        <button type="button" onClick={() => exportReport(result)}><Download size={14} aria-hidden="true" />{t("exportPortfolioReport")}</button>
      </header>
      <div className="portfolio-assumption" role="note"><ShieldAlert size={17} aria-hidden="true" /><span>{t("portfolioCandidateNotice")}</span></div>
      <dl className="metric-grid portfolio-metrics">
        <Metric label={t("netProfit")} value={`${money(metrics.netProfit)} (${number(metrics.netProfitPct)}%)`} tone={metrics.netProfit >= 0 ? "positive" : "negative"} />
        <Metric label={t("finalEquity")} value={money(metrics.finalEquity)} />
        <Metric label={t("maxDrawdown")} value={`${money(metrics.maxDrawdown)} (${number(metrics.maxDrawdownPct)}%)`} />
        <Metric label={t("profitFactor")} value={Number.isFinite(metrics.profitFactor) ? number(metrics.profitFactor) : "∞"} />
        <Metric label={t("sharpe")} value={number(metrics.sharpe)} />
        <Metric label={t("winRate")} value={`${number(metrics.winRate)}%`} />
        <Metric label={t("candidateTrades")} value={String(metrics.totalCandidates)} />
        <Metric label={t("acceptedTrades")} value={String(metrics.acceptedTrades)} />
        <Metric label={t("rejectedTrades")} value={String(metrics.rejectedTrades)} />
        <Metric label={t("excludedCandidates")} value={String(metrics.excludedCandidates)} />
        <Metric label={t("peakExposure")} value={`${number(metrics.peakGrossExposurePct)}%`} />
        <Metric label={t("maxConcurrentUsed")} value={String(metrics.maxConcurrentPositions)} />
      </dl>
      <p className="portfolio-range"><strong>{t("commonRange")}:</strong> {date(result.commonRange.fromTime)} – {date(result.commonRange.toTime)} · {number(result.commonRange.points, 0)} {t("bars").toLowerCase()}</p>
      <figure className="portfolio-equity-chart">
        <figcaption>{t("portfolioEquityCurve")}</figcaption>
        <svg viewBox="0 0 640 180" role="img" aria-label={t("portfolioEquityCurve")} preserveAspectRatio="none">
          <path className="portfolio-equity-fill" d={`${path} L640 180 L0 180 Z`} />
          <path className="portfolio-equity-line" d={path} />
        </svg>
      </figure>
      <PortfolioExecutionPanel locale={locale} execution={result.execution} />
      <PortfolioRiskPanel locale={locale} risk={result.risk} />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Safari requires overflow regions to be explicitly keyboard-focusable. */}
      <div className="portfolio-table-grid" role="region" aria-label={`${t("contributionByMarket")} · ${t("correlationMatrix")}`} tabIndex={0}>
        <table>
          <caption>{t("contributionByMarket")}</caption>
          <thead><tr><th scope="col">{t("market")}</th><th scope="col">{t("candidateTrades")}</th><th scope="col">{t("acceptedTrades")}</th><th scope="col">{t("rejectedTrades")}</th><th scope="col">{t("netProfit")}</th><th scope="col">{t("contribution")}</th></tr></thead>
          <tbody>{result.contributions.map((row) => <tr key={row.symbol}><th scope="row">{row.symbol}</th><td>{row.candidateTrades}</td><td>{row.acceptedTrades}</td><td>{row.rejectedTrades}</td><td>{money(row.netProfit)}</td><td>{number(row.contributionPct)}%</td></tr>)}</tbody>
        </table>
        <table>
          <caption>{t("correlationMatrix")} · {t("averageCorrelation")}: {result.correlation.averagePairwise === null ? t("unavailable") : number(result.correlation.averagePairwise, 3)}</caption>
          <thead><tr><th scope="col">{t("market")}</th>{result.correlation.symbols.map((symbol) => <th scope="col" key={symbol}>{symbol}</th>)}</tr></thead>
          <tbody>{result.correlation.symbols.map((symbol, row) => <tr key={symbol}><th scope="row">{symbol}</th>{result.correlation.values[row].map((value, column) => <td key={result.correlation.symbols[column]}>{value === null ? "—" : number(value, 3)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {result.trades.length === 0 ? <p>{t("noPortfolioTrades")}</p> : (
        <>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Safari requires overflow regions to be explicitly keyboard-focusable. */}
        <div className="report-table-scroll" role="region" aria-label={t("acceptedTrades")} tabIndex={0}>
          <table>
            <caption>{t("acceptedTrades")}</caption>
            <thead><tr><th scope="col">{t("market")}</th><th scope="col">{t("direction")}</th><th scope="col">{t("entry")}</th><th scope="col">{t("exit")}</th><th scope="col">{t("allocated")}</th><th scope="col">{t("netProfit")}</th></tr></thead>
            <tbody>{result.trades.map((trade, index) => <tr key={`${trade.symbol}-${trade.entryTime}-${index}`}><th scope="row">{trade.symbol}</th><td>{t(trade.direction)}</td><td>{date(trade.entryTime)}</td><td>{date(trade.exitTime)}</td><td>{money(trade.allocatedNotional)}</td><td>{money(trade.pnl - trade.fundingPaid)}</td></tr>)}</tbody>
          </table>
        </div></>
      )}
      {result.rejectedEntries.length > 0 && (
        <details><summary>{t("rejectedTrades")} · {result.rejectedEntries.length}</summary>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Safari requires overflow regions to be explicitly keyboard-focusable. */}
          <div className="report-table-scroll" role="region" aria-label={t("rejectedTrades")} tabIndex={0}><table><thead><tr><th scope="col">{t("market")}</th><th scope="col">{t("entry")}</th><th scope="col">{t("reason")}</th><th scope="col">{t("requested")}</th><th scope="col">{t("available")}</th></tr></thead><tbody>{result.rejectedEntries.map((entry, index) => <tr key={`${entry.symbol}-${entry.time}-${index}`}><th scope="row">{entry.symbol}</th><td>{date(entry.time)}</td><td>{t(rejectionKey(entry.reason))}</td><td>{money(entry.requestedNotional)}</td><td>{money(entry.availableNotional)}</td></tr>)}</tbody></table></div>
        </details>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={tone ? `metric ${tone}` : "metric"}><dt>{label}</dt><dd>{value}</dd></div>;
}

function equityPath(values: number[]): string {
  if (values.length === 0) return "M0 90 L640 90";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => `${index ? "L" : "M"}${index / Math.max(1, values.length - 1) * 640} ${170 - (value - min) / range * 160}`).join(" ");
}

function rejectionKey(reason: PortfolioRejectionReason) {
  const keys = { max_concurrent: "rejectionMaxConcurrent", gross_exposure: "rejectionGrossExposure", allocation_too_small: "rejectionAllocationTooSmall", invalid_candidate: "rejectionInvalidCandidate" } as const;
  return keys[reason];
}

function exportReport(result: PortfolioBacktestResult) {
  const payload = JSON.stringify({ schemaVersion: 1, kind: "saltanat-portfolio-backtest-report", exportedAt: new Date().toISOString(), report: result }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `portfolio-backtest-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
