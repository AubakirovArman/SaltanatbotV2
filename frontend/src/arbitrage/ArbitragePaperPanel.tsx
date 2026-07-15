import { useState } from "react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import type { ArbitrageOpportunity } from "./client";
import { paperAnalytics, paperPnl, type ArbitragePaperAnalytics, type ArbitragePaperPosition } from "./paper";
import { arbitrageText } from "./text";

export interface PaperFundingInput {
  settlementTime: number;
  rate: number;
  referencePrice: number;
}

export function ArbitragePaperPanel({
  locale,
  positions,
  quotes,
  onClose,
  onFunding,
  onClearClosed
}: { locale: Locale; positions: ArbitragePaperPosition[]; quotes: ArbitrageOpportunity[]; onClose(position: ArbitragePaperPosition): void; onFunding(position: ArbitragePaperPosition, input: PaperFundingInput): void; onClearClosed(): void }) {
  if (positions.length === 0) return null;
  const analytics = paperAnalytics(positions, quotes);
  const openPnl = openPnlPresentation(analytics, locale);
  return (
    <section className="arb-paper" aria-labelledby="arb-paper-title">
      <header>
        <div>
          <h2 id="arb-paper-title">{arbitrageText(locale, "paperPositions")}</h2>
          <p>{arbitrageText(locale, "paperOnly")}</p>
        </div>
        <button type="button" onClick={onClearClosed}>
          {arbitrageText(locale, "clearClosed")}
        </button>
      </header>
      <div className="arb-paper-stats">
        <PaperStat label={arbitrageText(locale, "paperRealized")} value={money(analytics.realizedPnlUsd, locale)} />
        <PaperStat label={arbitrageText(locale, "paperUnrealized")} value={openPnl.value} hint={openPnl.hint} />
        <PaperStat label={arbitrageText(locale, "paperWinRate")} value={`${analytics.winRatePct.toFixed(0)}%`} />
        <PaperStat label={arbitrageText(locale, "paperAverage")} value={money(analytics.averageClosedPnlUsd, locale)} />
      </div>
      <div className="arb-paper-list">
        {positions.map((position) => {
          const quote = quotes.find((row) => row.id === position.routeId);
          const pnl = paperPnl(position, quote);
          return (
            <article key={position.id}>
              <div>
                <strong>{position.symbol}</strong>
                <span>
                  {position.spotExchange} → {position.futuresExchange} · ${position.notionalUsd.toLocaleString(localeTag(locale))}
                </span>
              </div>
              <mark className={(pnl ?? 0) >= 0 ? "positive" : "negative"}>{pnl === undefined ? "—" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}</mark>
              {position.fundingPnlUsd !== 0 ? <span className="arb-paper-funding">{arbitrageText(locale, "paperFundingTotal", { amount: money(position.fundingPnlUsd, locale) })}</span> : null}
              {position.closedAt ? (
                <span>{arbitrageText(locale, "closed")}</span>
              ) : (
                <div className="arb-paper-actions">
                  <FundingRecorder locale={locale} position={position} onFunding={(input) => onFunding(position, input)} />
                  <button type="button" disabled={!quote} onClick={() => onClose(position)}>
                    {arbitrageText(locale, "closePaper")}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FundingRecorder({ locale, position, onFunding }: { locale: Locale; position: ArbitragePaperPosition; onFunding(input: PaperFundingInput): void }) {
  const [ratePct, setRatePct] = useState("");
  const [referencePrice, setReferencePrice] = useState("");
  const [settlement, setSettlement] = useState("");
  return (
    <details className="arb-paper-funding-form">
      <summary>{arbitrageText(locale, "recordFunding")}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const settlementTime = new Date(settlement).getTime();
          const rate = Number(ratePct) / 100;
          const price = Number(referencePrice);
          onFunding({ settlementTime, rate, referencePrice: price });
        }}
      >
        <p>{arbitrageText(locale, "recordFundingHint")}</p>
        <label>
          {arbitrageText(locale, "fundingSettlementTime")}
          <input type="datetime-local" required min={localDateTime(position.openedAt)} max={localDateTime(Date.now())} value={settlement} onChange={(event) => setSettlement(event.target.value)} />
        </label>
        <label>
          {arbitrageText(locale, "fundingRateInput")}
          <input type="number" required min="-100" max="100" step="0.000001" value={ratePct} onChange={(event) => setRatePct(event.target.value)} />
        </label>
        <label>
          {arbitrageText(locale, "fundingReferencePrice")}
          <input type="number" required min="0.00000001" step="any" value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} />
        </label>
        <button type="submit">{arbitrageText(locale, "recordConfirmedFunding")}</button>
      </form>
    </details>
  );
}

function localDateTime(value: number) {
  const offset = new Date(value).getTimezoneOffset() * 60_000;
  return new Date(value - offset).toISOString().slice(0, 16);
}

function PaperStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

function openPnlPresentation(analytics: ArbitragePaperAnalytics, locale: Locale): { value: string; hint?: string } {
  if (analytics.unrealizedPnlUsd !== undefined) return { value: money(analytics.unrealizedPnlUsd, locale) };
  const hint = arbitrageText(locale, "paperPnlCoverage", {
    known: String(analytics.pricedOpenPositions),
    total: String(analytics.open)
  });
  if (analytics.pricedOpenPositions === 0) return { value: "—", hint };
  return {
    value: arbitrageText(locale, "paperPartialPnl", { amount: money(analytics.knownUnrealizedPnlUsd, locale) }),
    hint
  };
}

function money(value: number, locale: Locale) {
  return new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}
