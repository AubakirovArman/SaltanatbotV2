import type { ContinuousMarketEvaluation } from "@saltanatbotv2/arbitrage-sdk";
import { ShieldAlert } from "lucide-react";
import { localeTag, type Locale } from "../i18n";
import { continuousBlockReasonText, continuousRoutesText } from "./continuousRoutesText";
import { OpportunityHandoffButton } from "./OpportunityHandoffButton";
import { adaptContinuousMarketOpportunity, isContinuousMarketOpportunityFresh } from "./marketOpportunityAdapters";
import { opportunityHandoffText } from "./opportunityHandoffText";

interface Props {
  locale: Locale;
  evaluations: readonly ContinuousMarketEvaluation[];
  total: number;
  now: number;
  sourceCurrent: boolean;
}

export function ContinuousMarketEconomicsTable({ locale, evaluations, total, now, sourceCurrent }: Props) {
  return (
    <section className="arb-live-economics" aria-labelledby="arb-live-economics-title">
      <header>
        <div>
          <h4 id="arb-live-economics-title">{continuousRoutesText(locale, "economicsTitle")}</h4>
          <p>{continuousRoutesText(locale, "economicsHint")}</p>
          <p>{continuousRoutesText(locale, "economicsCount", { shown: String(evaluations.length), total: String(total) })}</p>
        </div>
      </header>
      <p className="arb-live-economics-boundary">
        <ShieldAlert size={17} aria-hidden="true" />
        <span>
          <strong>{continuousRoutesText(locale, "permissionDenied")}</strong> · {continuousRoutesText(locale, "entryOnlyBoundary")}
        </span>
      </p>
      {evaluations.length === 0 ? (
        <p>{continuousRoutesText(locale, "noEconomics")}</p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets keyboard users scroll the wide table at 200% text zoom
        <div className="arb-table-scroll" role="region" aria-label={continuousRoutesText(locale, "economicsTable")} tabIndex={0}>
          <table className="arb-live-table arb-live-economics-table">
            <caption className="sr-only">{continuousRoutesText(locale, "economicsTable")}</caption>
            <thead>
              <tr>
                <th scope="col">{continuousRoutesText(locale, "outcome")}</th>
                <th scope="col">{continuousRoutesText(locale, "route")}</th>
                <th scope="col">{continuousRoutesText(locale, "capacity")}</th>
                <th scope="col">{continuousRoutesText(locale, "grossEdge")}</th>
                <th scope="col">{continuousRoutesText(locale, "entryFees")}</th>
                <th scope="col">{continuousRoutesText(locale, "netEntryEdge")}</th>
                <th scope="col">{continuousRoutesText(locale, "freshness")}</th>
                <th scope="col">{continuousRoutesText(locale, "blockedBy")}</th>
                <th scope="col">{opportunityHandoffText(locale, "send")}</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((evaluation) => (
                <EvaluationRow key={evaluation.routeId} locale={locale} evaluation={evaluation} now={now} sourceCurrent={sourceCurrent} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EvaluationRow({ locale, evaluation, now, sourceCurrent }: { locale: Locale; evaluation: ContinuousMarketEvaluation; now: number; sourceCurrent: boolean }) {
  const number = (value: number, maximumFractionDigits = 8) => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits }).format(value);
  const signed = (value: number, maximumFractionDigits = 2) => {
    const normalized = Object.is(value, -0) ? 0 : value;
    return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits, signDisplay: "always" }).format(normalized);
  };
  const reasons = (
    <ul className="arb-live-blockers">
      {evaluation.blockedReasons.map((reason, index) => (
        <li key={`${reason.stage}:${reason.code}:${reason.subject ?? "route"}:${index}`}>
          <code>{reason.code}</code> — {continuousBlockReasonText(locale, reason.code)}
        </li>
      ))}
    </ul>
  );

  if (evaluation.status === "blocked") {
    return (
      <tr>
        <td>
          <span className="arb-economics-status is-blocked">{continuousRoutesText(locale, "blockedStatus")}</span>
          <small>
            {continuousRoutesText(locale, "projectedOutcome")} · {continuousRoutesText(locale, "permissionDenied")}
          </small>
        </td>
        <RouteIdentity locale={locale} evaluation={evaluation} />
        <td colSpan={5}>—</td>
        <td>{reasons}</td>
        <td>—</td>
      </tr>
    );
  }

  const currentQuoteAgeMs = evaluation.freshness.quoteAgeMs + Math.max(0, now - evaluation.evaluatedAt);
  const fresh = isContinuousMarketOpportunityFresh(evaluation, now, sourceCurrent);
  const netClass = evaluation.edges.netEntryBasisAfterEstimatedFeesBps > 0 ? "is-positive" : evaluation.edges.netEntryBasisAfterEstimatedFeesBps < 0 ? "is-negative" : "";
  return (
    <tr>
      <td>
        <span className="arb-economics-status is-market-only">{continuousRoutesText(locale, "marketOnlyStatus")}</span>
        <small>
          {continuousRoutesText(locale, "projectedOutcome")} · {continuousRoutesText(locale, "permissionDenied")}
        </small>
      </td>
      <RouteIdentity locale={locale} evaluation={evaluation} />
      <td>
        <strong>
          {number(evaluation.capacity.commonBaseQuantity)} {evaluation.baseAsset}
        </strong>
        <small>{continuousRoutesText(locale, "maximumVisibleCapacity")}</small>
        <small>{continuousRoutesText(locale, "referenceNotional", { value: number(evaluation.capacity.referenceNotionalQuote, 2), asset: evaluation.quoteAsset })}</small>
      </td>
      <td>
        <strong>{signed(evaluation.edges.grossEntryBasisBps)} bps</strong>
        <small>
          {signed(evaluation.edges.grossEntryValueDifferenceQuote)} {evaluation.quoteAsset}
        </small>
      </td>
      <td>
        <strong>
          {number(evaluation.edges.publicEntryFeesQuoteEquivalentEstimate)} {evaluation.quoteAsset}
        </strong>
        <small>{continuousRoutesText(locale, "publicTakerEntryOnly")}</small>
        <small>{continuousRoutesText(locale, "feeEstimateBoundary")}</small>
      </td>
      <td>
        <strong className={netClass}>{signed(evaluation.edges.netEntryBasisAfterEstimatedFeesBps)} bps</strong>
        <small>
          {signed(evaluation.edges.netEntryValueDifferenceAfterEstimatedFeesQuote)} {evaluation.quoteAsset}
        </small>
      </td>
      <td>
        <strong>{continuousRoutesText(locale, "quoteAge", { value: number(currentQuoteAgeMs, 0) })}</strong>
        <small>{continuousRoutesText(locale, "legSkew", { value: number(evaluation.freshness.legSkewMs, 0) })}</small>
        <small>{continuousRoutesText(locale, evaluation.freshness.clockBasis === "calibrated-venue-interval" ? "calibratedClock" : "receiptClock")}</small>
      </td>
      <td>{reasons}</td>
      <td>
        <OpportunityHandoffButton
          locale={locale}
          name={`${evaluation.family} · ${evaluation.routeId}`}
          disabled={!fresh}
          disabledReason={continuousRoutesText(locale, "staleHandoff")}
          createOpportunity={() => adaptContinuousMarketOpportunity(evaluation, { now, sourceCurrent })}
        />
      </td>
    </tr>
  );
}

function RouteIdentity({ locale, evaluation }: { locale: Locale; evaluation: ContinuousMarketEvaluation }) {
  if (evaluation.status === "blocked") {
    return (
      <td>
        <strong>{evaluation.family}</strong>
        <small>
          <code>{evaluation.longInstrumentId}</code> → <code>{evaluation.shortInstrumentId}</code>
        </small>
      </td>
    );
  }
  const [long, short] = evaluation.legs;
  const formatTime = (value: number) => new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "short" }).format(value);
  return (
    <td>
      <strong>{evaluation.family}</strong>
      <small>
        <code>
          {long.venue}:{long.symbol}
        </code>{" "}
        · {continuousRoutesText(locale, "buyLeg")} @ {long.price}
      </small>
      <small>
        <code>
          {short.venue}:{short.symbol}
        </code>{" "}
        · {continuousRoutesText(locale, "sellLeg")} @ {short.price}
      </small>
      {evaluation.evidence.economicIdentities.map((identity) => (
        <small key={identity.instrumentId}>{continuousRoutesText(locale, "identityValidUntil", { source: identity.source, version: identity.version, time: formatTime(identity.validUntil) })}</small>
      ))}
    </td>
  );
}
