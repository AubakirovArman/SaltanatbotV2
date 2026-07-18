import { worstCaseDcaCapitalQuote, type DcaParamsV1 } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import { localeTag, type Locale } from "../../../i18n";
import { dcaCycleStateText, dcaText, type DcaMessageKey } from "../../../i18n/dca";
import { paperPortfolioText } from "../../../i18n/paperPortfolio";
import type { PaperRobotDcaRuntime } from "../../paperPortfolioTypes";

/** Detail-drawer DCA cycle section; every field is optional and rendered leniently. */
export function PaperRobotDcaSection({ dca, locale }: { dca: PaperRobotDcaRuntime; locale: Locale }) {
  const unavailable = paperPortfolioText(locale, "unavailable");
  const amount = (value?: number) => value === undefined ? unavailable : value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 });
  const safetyOrdersTotal = dca.safetyOrdersTotal ?? dca.params?.maxSafetyOrders;
  const safetyOrders = dca.safetyOrdersFilled === undefined && safetyOrdersTotal === undefined
    ? unavailable
    : `${dca.safetyOrdersFilled ?? 0} / ${safetyOrdersTotal ?? "?"}`;
  return (
    <section className="paper-detail-section paper-dca-section">
      <h4>{dcaText(locale, "cycleTitle")}</h4>
      <dl className="paper-detail-metrics">
        <Metric label={dcaText(locale, "cycleState")} value={dca.cycleState ? dcaCycleStateText(locale, dca.cycleState) : unavailable} />
        <Metric label={dcaText(locale, "safetyOrders")} value={safetyOrders} />
        <Metric label={dcaText(locale, "averageEntry")} value={amount(dca.averageEntryPrice)} />
        <Metric label={dcaText(locale, "nextSafetyOrder")} value={amount(dca.nextSafetyOrderPrice)} />
        <Metric label={dcaText(locale, "takeProfitTarget")} value={amount(dca.takeProfitPrice)} />
        <Metric label={dcaText(locale, "cooldownUntil")} value={dca.cooldownUntil === undefined ? unavailable : new Date(dca.cooldownUntil).toLocaleString(localeTag(locale))} />
      </dl>
      {dca.params && <DcaParamsDisclosure params={dca.params} locale={locale} />}
    </section>
  );
}

function DcaParamsDisclosure({ params, locale }: { params: DcaParamsV1; locale: Locale }) {
  const amount = (value: number) => `${value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 })} USDT`;
  const percent = (value: number) => `${value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 })}%`;
  const worstCase = worstCaseDcaCapitalQuote(params, PAPER_FILL_MODEL_V1.feePct);
  const rows: Array<[DcaMessageKey, string]> = [
    ["direction", dcaText(locale, params.direction === "long" ? "directionLong" : "directionShort")],
    ["baseOrderQuote", amount(params.baseOrderQuote)],
    ["safetyOrderQuote", amount(params.safetyOrderQuote)],
    ["maxSafetyOrders", String(params.maxSafetyOrders)],
    ["priceDeviationPct", percent(params.priceDeviationPct)],
    ["stepScale", String(params.stepScale)],
    ["volumeScale", String(params.volumeScale)],
    ["takeProfitPct", percent(params.takeProfitPct)],
    ...(params.stopLossPct === undefined ? [] : [["stopLossPct", percent(params.stopLossPct)] as [DcaMessageKey, string]]),
    ...(params.trailingTakeProfitPct === undefined ? [] : [["trailingTakeProfitPct", percent(params.trailingTakeProfitPct)] as [DcaMessageKey, string]]),
    ["cooldownSeconds", String(params.cooldownSeconds)],
    ...(params.maxCycleDurationHours === undefined ? [] : [["maxCycleDurationHours", String(params.maxCycleDurationHours)] as [DcaMessageKey, string]]),
    ["worstCaseTitle", amount(worstCase)]
  ];
  return (
    <details className="paper-dca-params">
      <summary>{dcaText(locale, "paramsDisclosure")}</summary>
      <dl className="paper-detail-metrics">
        {rows.map(([key, value]) => <Metric key={key} label={dcaText(locale, key)} value={value} />)}
      </dl>
      <p className="paper-dca-note">{dcaText(locale, "researchNote")}</p>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
