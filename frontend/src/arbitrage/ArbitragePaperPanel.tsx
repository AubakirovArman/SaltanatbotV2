import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import type { ArbitrageOpportunity } from "./client";
import { paperAnalytics, paperPnl, type ArbitragePaperPosition } from "./paper";
import { arbitrageText } from "./text";

export function ArbitragePaperPanel({ locale, positions, quotes, onClose, onClearClosed }: { locale: Locale; positions: ArbitragePaperPosition[]; quotes: ArbitrageOpportunity[]; onClose(position: ArbitragePaperPosition): void; onClearClosed(): void }) {
  if (positions.length === 0) return null;
  const analytics = paperAnalytics(positions, quotes);
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
        <PaperStat label={arbitrageText(locale, "paperUnrealized")} value={money(analytics.unrealizedPnlUsd, locale)} />
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
              {position.closedAt ? (
                <span>{arbitrageText(locale, "closed")}</span>
              ) : (
                <button type="button" disabled={!quote} onClick={() => onClose(position)}>
                  {arbitrageText(locale, "closePaper")}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PaperStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function money(value: number, locale: Locale) {
  return new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}
