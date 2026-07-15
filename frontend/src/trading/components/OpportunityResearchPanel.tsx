import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { ArrowRight, FlaskConical, ShieldX, Trash2 } from "lucide-react";
import { localeTag, type Locale } from "../../i18n";
import { opportunityResearchText as text } from "../opportunityResearchText";
import "../../styles/opportunity-research.css";

interface Props {
  opportunity: MarketOpportunityEnvelope;
  expiresAt: number;
  now: number;
  locale: Locale;
  canOpenPaperJournal: boolean;
  onOpenPaperJournal(): void;
  onClear(): void;
}

export function OpportunityResearchPanel({ opportunity, expiresAt, now, locale, canOpenPaperJournal, onOpenPaperJournal, onClear }: Props) {
  const expired = now >= expiresAt;
  const paperReady = opportunity.execution.paperPlan === "ready" && !expired;
  const blockers = unique([
    ...opportunity.blockers.map((blocker) => blocker.message),
    ...opportunity.execution.paperBlockers,
    ...opportunity.execution.liveBlockers,
    ...(expired ? [text(locale, "expiredBlocker")] : [])
  ]);
  const twoSidedQuote = opportunity.economics.outcome === "two-sided-quote";

  return (
    <article className="opportunity-research" aria-labelledby="opportunity-research-title">
      <header className="opportunity-research-head">
        <div>
          <h1 id="opportunity-research-title">
            <FlaskConical size={21} aria-hidden="true" /> {text(locale, "title")}
          </h1>
          <p>{text(locale, "description")}</p>
        </div>
        <div className="opportunity-research-boundaries" aria-label={text(locale, "execution")}>
          <span>
            <FlaskConical size={14} aria-hidden="true" /> {text(locale, "researchOnly")}
          </span>
          <span className="blocked">
            <ShieldX size={14} aria-hidden="true" /> {text(locale, "liveBlocked")}
          </span>
          {expired && <span className="blocked"><ShieldX size={14} aria-hidden="true" /> {text(locale, "expired")}</span>}
        </div>
      </header>

      <dl className="opportunity-research-summary">
        <Metric label={text(locale, "source")} value={`${opportunity.source.engine} · ${opportunity.source.opportunityId}`} />
        <Metric label={text(locale, "family")} value={opportunity.family} />
        <Metric label={text(locale, "evaluated")} value={date(opportunity.source.evaluatedAt, locale)} />
        <Metric label={text(locale, "expires")} value={`${date(expiresAt, locale)} · ${text(locale, expired ? "expired" : "active")}`} />
      </dl>

      <section aria-labelledby="opportunity-economics-title">
        <h2 id="opportunity-economics-title">{text(locale, "economics")}</h2>
        <dl className="opportunity-research-metrics">
          <Metric label={text(locale, "outcome")} value={text(locale, outcomeKey(opportunity.economics.outcome))} />
          <Metric label={text(locale, twoSidedQuote ? "quoteWidth" : "grossEdge")} value={bps(opportunity.economics.grossEdgeBps, locale, text(locale, "unknown"))} />
          <Metric label={text(locale, "netEdge")} value={bps(opportunity.economics.netEdgeBps, locale, text(locale, "unknown"))} />
          <Metric label={text(locale, "expectedProfit")} value={money(opportunity.economics.expectedNetProfit, locale, text(locale, "unknown"))} />
          <Metric label={text(locale, "entryFees")} value={money(opportunity.economics.entryFees, locale, text(locale, "unknown"))} />
          <Metric label={text(locale, "aggregateCosts")} value={bps(opportunity.economics.aggregateEstimatedCostBps, locale, text(locale, "unknown"))} />
          {opportunity.economics.twoSidedQuote ? (
            <>
              <Metric label={text(locale, "nativeBid")} value={`${number(opportunity.economics.twoSidedQuote.bidPrice, locale)} ${opportunity.economics.twoSidedQuote.priceUnit}`} />
              <Metric label={text(locale, "nativeAsk")} value={`${number(opportunity.economics.twoSidedQuote.askPrice, locale)} ${opportunity.economics.twoSidedQuote.priceUnit}`} />
              <Metric label={text(locale, "absoluteWidth")} value={`${number(opportunity.economics.twoSidedQuote.absoluteWidth, locale)} ${opportunity.economics.twoSidedQuote.priceUnit}`} />
            </>
          ) : null}
          <Metric label={text(locale, "capacity")} value={capacity(opportunity, locale, text(locale, "unknown"))} />
          <Metric label={text(locale, "costCoverage")} value={opportunity.economics.costCoverage} />
          <Metric label={text(locale, "funding")} value={opportunity.economics.funding} />
          <Metric label={text(locale, "borrowing")} value={opportunity.economics.borrow} />
          <Metric label={text(locale, "slippage")} value={opportunity.economics.slippage} />
        </dl>
        {twoSidedQuote && <p className="opportunity-research-hint">{text(locale, "twoSidedQuoteHint")}</p>}
        {opportunity.economics.basisScenario ? <BasisScenario locale={locale} scenario={opportunity.economics.basisScenario} /> : null}
      </section>

      <section aria-labelledby="opportunity-evidence-title">
        <h2 id="opportunity-evidence-title">{text(locale, "evidence")}</h2>
        <dl className="opportunity-research-metrics compact">
          <Metric label={text(locale, "quoteAge")} value={`${number(currentQuoteAge(opportunity, now), locale)} ms`} />
          <Metric label={text(locale, "legSkew")} value={`${number(opportunity.evidence.legSkewMs, locale)} ms`} />
          <Metric label={text(locale, "sequence")} value={opportunity.evidence.sequenceContinuity} />
          <Metric label={text(locale, "timestamps")} value={opportunity.evidence.exchangeTimestamps} />
          <Metric label={text(locale, "quality")} value={opportunity.evidence.dataQuality} />
        </dl>
      </section>

      <section aria-labelledby="opportunity-legs-title">
        <h2 id="opportunity-legs-title">{text(locale, "legs")}</h2>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The table needs a keyboard-scrollable region on narrow screens. */}
        <div className="opportunity-research-table" role="region" aria-label={text(locale, "legs")} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{text(locale, "leg")}</th>
                <th scope="col">{text(locale, "venue")}</th>
                <th scope="col">{text(locale, "instrument")}</th>
                <th scope="col">{text(locale, "market")}</th>
                <th scope="col">{text(locale, "side")}</th>
                <th scope="col">{text(locale, "quantity")}</th>
                <th scope="col">{text(locale, "referencePrice")}</th>
              </tr>
            </thead>
            <tbody>
              {opportunity.legs.map((leg, index) => (
                <tr key={leg.id}>
                  <th scope="row">{index + 1}</th>
                  <td>{leg.venue}</td>
                  <td>
                    <code>{leg.symbol}</code>
                  </td>
                  <td>{leg.marketType}</td>
                  <td title={leg.side === "derived" ? text(locale, "derived") : undefined}>{leg.side}</td>
                  <td>{leg.quantity === undefined ? text(locale, "unknown") : `${number(leg.quantity, locale)} ${leg.quantityAsset ?? leg.quantityUnit}`}</td>
                  <td>{leg.referencePrice === undefined ? text(locale, "unknown") : number(leg.referencePrice, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="opportunity-execution-title">
        <h2 id="opportunity-execution-title">{text(locale, "execution")}</h2>
        <dl className="opportunity-research-execution">
          <Metric label={text(locale, "research")} value={text(locale, "available")} />
          <Metric label={text(locale, "paper")} value={text(locale, expired ? "expired" : opportunity.execution.paperPlan)} />
          <Metric label={text(locale, "live")} value={text(locale, "blocked")} />
        </dl>
        <p className="opportunity-research-hint">{text(locale, expired ? "paperHintExpired" : paperReady ? "paperHintReady" : "paperHintBlocked")}</p>
      </section>

      <section aria-labelledby="opportunity-blockers-title">
        <h2 id="opportunity-blockers-title">{text(locale, "blockers")}</h2>
        {blockers.length > 0 ? (
          <ul className="opportunity-research-blockers">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        ) : (
          <p>{text(locale, "noBlockers")}</p>
        )}
      </section>

      <footer className="opportunity-research-actions">
        {paperReady && canOpenPaperJournal && (
          <button type="button" className="run-button" onClick={onOpenPaperJournal}>
            {text(locale, "openPaper")} <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
        <button type="button" onClick={onClear}>
          <Trash2 size={15} aria-hidden="true" /> {text(locale, "clear")}
        </button>
      </footer>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function BasisScenario({ locale, scenario }: { locale: Locale; scenario: NonNullable<MarketOpportunityEnvelope["economics"]["basisScenario"]> }) {
  const assumptions = scenario.assumptions;
  const costs = scenario.costBreakdownBps;
  return (
    <div className="opportunity-research-scenario">
      <h3>{text(locale, "basisScenario")}</h3>
      <dl className="opportunity-research-metrics compact">
        <Metric label={text(locale, "scenarioModel")} value={scenario.model} />
        <Metric label={text(locale, "scenarioComputed")} value={date(scenario.computedAt, locale)} />
        <Metric label={text(locale, "requestedNotional")} value={`${number(scenario.requestedNotionalUsd, locale)} USD`} />
        <Metric label={text(locale, "executableNotional")} value={`${number(scenario.executableNotionalUsd, locale)} USD`} />
      </dl>
      <h3>{text(locale, "scenarioAssumptions")}</h3>
      <dl className="opportunity-research-metrics compact">
        <Metric label={text(locale, "spotTaker")} value={`${number(assumptions.spotTakerBps, locale)} bps`} />
        <Metric label={text(locale, "perpetualTaker")} value={`${number(assumptions.perpetualTakerBps, locale)} bps`} />
        <Metric label={text(locale, "slippageReserve")} value={`${number(assumptions.roundTripSlippageReserveBps, locale)} bps`} />
        <Metric label={text(locale, "holdingPeriod")} value={`${number(assumptions.expectedHoldingHours, locale)} h`} />
        <Metric label={text(locale, "borrowRate")} value={`${number(assumptions.annualBorrowRatePct, locale)}%`} />
        <Metric label={text(locale, "transferCost")} value={`${number(assumptions.transferCostUsd, locale)} USD`} />
      </dl>
      <h3>{text(locale, "scenarioCosts")}</h3>
      <dl className="opportunity-research-metrics compact">
        <Metric label={text(locale, "tradingFees")} value={`${number(costs.tradingFees, locale)} bps`} />
        <Metric label={text(locale, "slippage")} value={`${number(costs.slippage, locale)} bps`} />
        <Metric label={text(locale, "borrowCost")} value={`${number(costs.borrow, locale)} bps`} />
        <Metric label={text(locale, "transferCost")} value={`${number(costs.transfer, locale)} bps`} />
        <Metric label={text(locale, "fundingCost")} value={`${number(costs.funding, locale)} bps`} />
        <Metric label={text(locale, "totalCost")} value={`${number(costs.total, locale)} bps`} />
        <Metric label={text(locale, "fundingSettlements")} value={number(costs.fundingSettlementCount, locale)} />
        <Metric label={text(locale, "fundingSchedule")} value={text(locale, costs.fundingScheduleVerified ? "yes" : "no")} />
      </dl>
    </div>
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function bps(value: number | undefined, locale: Locale, fallback: string): string {
  return value === undefined ? fallback : `${number(value, locale)} bps`;
}

function money(value: { value: number; currency: string } | undefined, locale: Locale, fallback: string): string {
  return value ? `${number(value.value, locale)} ${value.currency}` : fallback;
}

function capacity(opportunity: MarketOpportunityEnvelope, locale: Locale, fallback: string): string {
  if (opportunity.capacity.notional) return money(opportunity.capacity.notional, locale, fallback);
  if (opportunity.capacity.quantity !== undefined) return `${number(opportunity.capacity.quantity, locale)} ${opportunity.capacity.quantityAsset ?? opportunity.capacity.quantityUnit ?? ""}`.trim();
  return fallback;
}

function date(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);
}

function currentQuoteAge(opportunity: MarketOpportunityEnvelope, now: number): number {
  return opportunity.evidence.quoteAgeMs + Math.max(0, now - opportunity.evidence.evaluatedAt);
}

function outcomeKey(outcome: MarketOpportunityEnvelope["economics"]["outcome"]): "projected" | "researchSimulation" | "twoSidedQuote" {
  if (outcome === "research-simulation") return "researchSimulation";
  if (outcome === "two-sided-quote") return "twoSidedQuote";
  return "projected";
}
