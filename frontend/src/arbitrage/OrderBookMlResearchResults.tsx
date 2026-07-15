import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { localeTag, type Locale } from "../i18n";
import { orderBookMlResearchText as t } from "./orderBookMlResearchText";
import type { ResearchModelMetrics, ResearchModelSummary, ResearchPredictionResult } from "./orderBookMlResearchTypes";

export function MetricsTable({ locale, model }: { locale: Locale; model: ResearchModelSummary }) {
  return (
    <div className="obml-table-wrap">
      <table>
        <caption>{t(locale, "splitMetrics")}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, "split")}</th>
            <th scope="col">{t(locale, "rows")}</th>
            <th scope="col">{t(locale, "mae")}</th>
            <th scope="col">{t(locale, "rmse")}</th>
            <th scope="col">{t(locale, "directionalAccuracy")}</th>
            <th scope="col">{t(locale, "correlation")}</th>
          </tr>
        </thead>
        <tbody>
          <MetricRow locale={locale} label={t(locale, "train")} metrics={model.metrics.train} />
          <MetricRow locale={locale} label={t(locale, "validation")} metrics={model.metrics.validation} />
          <MetricRow locale={locale} label={t(locale, "test")} metrics={model.metrics.test} />
        </tbody>
      </table>
    </div>
  );
}

export function PredictionResult({ locale, result }: { locale: Locale; result: ResearchPredictionResult }) {
  const value = result.prediction;
  return (
    <section className="obml-card obml-prediction" aria-labelledby="obml-prediction-result" aria-live="polite">
      <h2 id="obml-prediction-result">{t(locale, "predictionResult")}</h2>
      <dl className="obml-stat-grid">
        <Stat label={t(locale, "predictedReturn")} value={`${formatNumber(locale, value.predictedReturnBps)} bps`} />
        <Stat label={t(locale, "direction")} value={t(locale, value.direction)} />
        <Stat label={t(locale, "signalToNoise")} value={formatNumber(locale, value.signalToNoise)} />
        <Stat label={t(locale, "distribution")} value={t(locale, value.distribution.status === "out-of-distribution" ? "outOfDistribution" : "withinRange")} />
      </dl>
      <dl className="obml-stat-grid obml-prediction-context">
        <Stat label={t(locale, "modelId")} value={<code>{value.modelId}</code>} />
        <Stat label={t(locale, "anchorScope")} value={`${value.symbol} · ${value.instrumentId}`} />
        <Stat label={t(locale, "anchorSequence")} value={value.anchorSequence} />
        <Stat label={t(locale, "anchorTime")} value={new Date(value.anchorExchangeTs).toLocaleString(localeTag(locale))} />
      </dl>
      <p>{t(locale, "maxZScore", { value: formatNumber(locale, value.distribution.maximumAbsoluteZScore), threshold: formatNumber(locale, value.distribution.threshold) })}</p>
      <div className="obml-table-wrap">
        <table>
          <caption>{t(locale, "contributions")}</caption>
          <thead>
            <tr>
              <th scope="col">{t(locale, "feature")}</th>
              <th scope="col">{t(locale, "standardizedValue")}</th>
              <th scope="col">{t(locale, "contribution")}</th>
            </tr>
          </thead>
          <tbody>
            {value.contributions.map((item) => (
              <tr key={item.feature}>
                <th scope="row">
                  <code>{item.feature}</code>
                </th>
                <td>{formatNumber(locale, item.standardizedValue)}</td>
                <td>{formatNumber(locale, item.contributionBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{t(locale, "inferenceProvenance")}</h3>
      <p>{t(locale, "inferenceEvidence", { count: String(result.provenance.snapshots), schema: result.provenance.featureSchemaVersion, normalizer: result.provenance.normalizerVersion, time: new Date(result.provenance.qualityEvaluatedAt).toLocaleString(localeTag(locale)) })}</p>
      <p className="obml-no-probability">
        <AlertTriangle size={15} aria-hidden="true" />
        {t(locale, "noProbability")}
      </p>
    </section>
  );
}

function MetricRow({ locale, label, metrics }: { locale: Locale; label: string; metrics: ResearchModelMetrics }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{metrics.rows}</td>
      <td>{formatNumber(locale, metrics.maeBps)}</td>
      <td>{formatNumber(locale, metrics.rmseBps)}</td>
      <td>{new Intl.NumberFormat(localeTag(locale), { style: "percent", maximumFractionDigits: 1 }).format(metrics.directionalAccuracy)}</td>
      <td>{formatNumber(locale, metrics.correlation)}</td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatNumber(locale: Locale, value: number) {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 4 }).format(value);
}
