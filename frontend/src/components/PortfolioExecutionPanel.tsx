import type { PortfolioExecutionAnalysis } from "@saltanatbotv2/backtest-core";
import { ReceiptText } from "lucide-react";
import { useId } from "react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import { strategyText } from "../i18n/strategy";

export function PortfolioExecutionPanel({ locale, execution }: { locale: Locale; execution: PortfolioExecutionAnalysis }) {
  const id = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const number = (value: number, digits = 2) => value.toLocaleString(localeTag(locale), { maximumFractionDigits: digits });
  const totals = execution.totals;
  return (
    <section className="portfolio-execution-analysis" aria-labelledby={`${id}-title`}>
      <header><ReceiptText size={17} aria-hidden="true" /><div><h4 id={`${id}-title`}>{t("executionQuality")}</h4><p>{t("modeledTca")}</p></div></header>
      <dl className="metric-grid portfolio-execution-metrics">
        <Metric label={t("referenceGrossPnl")} value={number(totals.referenceGrossPnl)} />
        <Metric label={t("commissionPaid")} value={number(totals.commissionPaid)} />
        <Metric label={t("estimatedSlippageCost")} value={number(totals.estimatedSlippageCost)} />
        <Metric label={t("fundingPaid")} value={number(totals.fundingPaid)} />
        <Metric label={t("totalExecutionCost")} value={number(totals.totalCost)} />
        <Metric label={t("allInCost")} value={`${number(totals.allInCostBps)} bps`} />
        <Metric label={t("costDrag")} value={totals.costDragPct === null ? t("unavailable") : `${number(totals.costDragPct)}%`} />
        <Metric label={t("netProfit")} value={number(totals.netPnl)} />
      </dl>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Safari requires overflow regions to be explicitly keyboard-focusable. */}
      <div className="portfolio-execution-table" role="region" aria-label={t("executionByMarket")} tabIndex={0}>
        <table>
          <caption>{t("executionByMarket")}</caption>
          <thead><tr><th scope="col">{t("market")}</th><th scope="col">{t("trades")}</th><th scope="col">{t("configuredCosts")}</th><th scope="col">{t("turnover")}</th><th scope="col">{t("referenceGrossPnl")}</th><th scope="col">{t("commissionPaid")}</th><th scope="col">{t("estimatedSlippageCost")}</th><th scope="col">{t("fundingPaid")}</th><th scope="col">{t("netProfit")}</th><th scope="col">{t("allInCost")}</th></tr></thead>
          <tbody>{execution.byMarket.map((row) => <tr key={row.symbol}><th scope="row">{row.symbol}</th><td>{row.trades}</td><td>{number(row.commissionPct, 4)}% + {number(row.slippagePct, 4)}%</td><td>{number(row.turnover)}</td><td>{number(row.referenceGrossPnl)}</td><td>{number(row.commissionPaid)}</td><td>{number(row.estimatedSlippageCost)}</td><td>{number(row.fundingPaid)}</td><td>{number(row.netPnl)}</td><td>{number(row.allInCostBps)} bps</td></tr>)}</tbody>
        </table>
      </div>
      {execution.byExitReason.length > 0 && <details><summary>{t("exitReasonAttribution")}</summary>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Safari requires overflow regions to be explicitly keyboard-focusable. */}
        <div className="portfolio-execution-table" role="region" aria-label={t("exitReasonAttribution")} tabIndex={0}><table><caption>{t("exitReasonAttribution")}</caption><thead><tr><th scope="col">{t("reason")}</th><th scope="col">{t("trades")}</th><th scope="col">{t("referenceGrossPnl")}</th><th scope="col">{t("totalExecutionCost")}</th><th scope="col">{t("netProfit")}</th></tr></thead><tbody>{execution.byExitReason.map((row) => <tr key={row.reason}><th scope="row">{t(exitReasonKey(row.reason))}</th><td>{row.trades}</td><td>{number(row.referenceGrossPnl)}</td><td>{number(row.totalCost)}</td><td>{number(row.netPnl)}</td></tr>)}</tbody></table></div>
      </details>}
      <p>{t("executionMethodHelp")}</p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><dt>{label}</dt><dd>{value}</dd></div>;
}

function exitReasonKey(reason: PortfolioExecutionAnalysis["byExitReason"][number]["reason"]) {
  const keys = { signal: "exitSignal", stop: "exitStop", target: "exitTarget", close: "exitEndOfData", liquidation: "exitLiquidation" } as const;
  return keys[reason];
}
