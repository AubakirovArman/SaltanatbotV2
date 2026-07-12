import type { PortfolioRiskAnalysis } from "@saltanatbotv2/backtest-core";
import { ShieldCheck } from "lucide-react";
import { useId } from "react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import { strategyText } from "../i18n/strategy";

export function PortfolioRiskPanel({ locale, risk }: { locale: Locale; risk: PortfolioRiskAnalysis }) {
  const id = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const number = (value: number, digits = 2) => value.toLocaleString(localeTag(locale), { maximumFractionDigits: digits });
  const historical = risk.historical;
  const simulation = risk.monteCarlo;
  return (
    <section className="portfolio-risk-lab" aria-labelledby={`${id}-title`}>
      <header><ShieldCheck size={17} aria-hidden="true" /><div><h4 id={`${id}-title`}>{t("riskLab")}</h4><p>{t("notForecast")}</p></div></header>
      <h5>{t("historicalTailRisk")}</h5>
      <dl className="metric-grid portfolio-risk-metrics">
        <RiskMetric label={t("valueAtRisk95")} value={`${number(historical.valueAtRisk95Pct)}%`} />
        <RiskMetric label={t("expectedShortfall95")} value={`${number(historical.expectedShortfall95Pct)}%`} />
        <RiskMetric label={t("valueAtRisk99")} value={`${number(historical.valueAtRisk99Pct)}%`} />
        <RiskMetric label={t("expectedShortfall99")} value={`${number(historical.expectedShortfall99Pct)}%`} />
        <RiskMetric label={t("worstPeriod")} value={`${number(historical.worstPeriodPct)}%`} />
        <RiskMetric label={t("ulcerIndex")} value={number(historical.ulcerIndex)} />
        <RiskMetric label={t("lossProbability")} value={`${number(historical.lossProbabilityPct)}%`} />
        <RiskMetric label={t("recoveryPeriods")} value={number(historical.longestRecoveryPeriods, 0)} />
      </dl>
      <div className="portfolio-risk-columns">
        <div>
          <h5>{t("concentrationRisk")}</h5>
          <p>{t("largestAllocation")}: <strong>{risk.concentration.largestSymbol ?? "—"} · {number(risk.concentration.largestAllocationPct)}%</strong></p>
          <p>{t("effectiveMarkets")}: <strong>{number(risk.concentration.effectiveSymbols)}</strong></p>
          {risk.concentration.allocations.length > 0 && (
            <table><caption>{t("allocationShare")}</caption><thead><tr><th scope="col">{t("market")}</th><th scope="col">{t("allocated")}</th><th scope="col">%</th></tr></thead><tbody>{risk.concentration.allocations.map((row) => <tr key={row.symbol}><th scope="row">{row.symbol}</th><td>{number(row.allocatedNotional)}</td><td>{number(row.sharePct)}%</td></tr>)}</tbody></table>
          )}
        </div>
        <div>
          <h5>{t("robustnessSimulation")}</h5>
          {simulation ? (
            <>
              <p>{number(simulation.runs, 0)} {t("paths")} · {t("blockSize")} {number(simulation.blockSize, 0)} · {number(simulation.observations, 0)} {t("periods")}</p>
              <table><caption>{t("movingBlockBootstrap")}</caption><thead><tr><th scope="col">{t("metric")}</th><th scope="col">P5</th><th scope="col">P50</th><th scope="col">P95</th></tr></thead><tbody><tr><th scope="row">{t("netProfit")}</th><td>{number(simulation.netProfit.p5)}</td><td>{number(simulation.netProfit.p50)}</td><td>{number(simulation.netProfit.p95)}</td></tr><tr><th scope="row">{t("maxDrawdown")}</th><td>{number(simulation.maxDrawdownPct.p5)}%</td><td>{number(simulation.maxDrawdownPct.p50)}%</td><td>{number(simulation.maxDrawdownPct.p95)}%</td></tr></tbody></table>
              <dl className="portfolio-risk-probabilities"><RiskMetric label={t("lossProbability")} value={`${number(simulation.probabilityOfLossPct)}%`} /><RiskMetric label={t("riskOfHalf")} value={`${number(simulation.riskOfHalfPct)}%`} /><RiskMetric label={t("riskOfRuin")} value={`${number(simulation.riskOfRuinPct)}%`} /></dl>
            </>
          ) : <p>{t("insufficientRiskHistory")}</p>}
        </div>
      </div>
      <details><summary>{t("riskMethodology")}</summary><p>{t("riskMethodHelp")}</p></details>
    </section>
  );
}

function RiskMetric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><dt>{label}</dt><dd>{value}</dd></div>;
}
