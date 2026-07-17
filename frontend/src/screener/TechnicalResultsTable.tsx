import { BarChart3 } from "lucide-react";
import { useState } from "react";
import type { ScreenerRowV1 } from "@saltanatbotv2/contracts";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { localeTag, type Locale } from "../i18n";
import { screenerText, type ScreenerMessageKey } from "../i18n/screener";

interface Props {
  locale: Locale;
  rows: ScreenerRowV1[];
  onOpenRow(row: ScreenerRowV1): void;
}

const METRIC_COLUMNS = [
  ["rsi", "colRsi"],
  ["atrPercent", "colAtrPercent"],
  ["macdHistogram", "colMacdHistogram"],
  ["fastMa", "colFastMa"],
  ["slowMa", "colSlowMa"]
] as const satisfies ReadonlyArray<readonly [keyof ScreenerRowV1["metrics"], ScreenerMessageKey]>;

export function TechnicalResultsTable({ locale, rows, onOpenRow }: Props) {
  const [mobileView, setMobileView] = useState<"cards" | "table">("cards");
  const mobileLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const metricColumns = METRIC_COLUMNS.filter(([key]) => rows.some((row) => row.metrics[key] !== undefined));

  return (
    <div className="arb-table-shell" data-mobile-view={mobileView}>
      {mobileLayout && (
        <>
          <div className="arb-results-view-switch" role="group" aria-label={screenerText(locale, "switchResultsView")}>
            <button type="button" aria-pressed={mobileView === "cards"} onClick={() => setMobileView("cards")}>
              {screenerText(locale, "cardsView")}
            </button>
            <button type="button" aria-pressed={mobileView === "table"} onClick={() => setMobileView("table")}>
              {screenerText(locale, "tableView")}
            </button>
          </div>
          {mobileView === "cards" && (
            <ol className="arb-card-list" aria-label={screenerText(locale, "results")}>
              {rows.map((row) => (
                <ResultCard key={row.symbol} locale={locale} row={row} metricColumns={metricColumns} onOpen={() => onOpenRow(row)} />
              ))}
            </ol>
          )}
        </>
      )}
      {(!mobileLayout || mobileView === "table") && (
        <table className="arb-table tech-screener-table" style={{ minWidth: `${Math.max(680, (6 + metricColumns.length) * 120)}px` }}>
          <caption>{screenerText(locale, "results")}</caption>
          <thead>
            <tr>
              <th scope="col">{screenerText(locale, "colSymbol")}</th>
              <th scope="col">{screenerText(locale, "colLastClose")}</th>
              <th scope="col">{screenerText(locale, "colChange24h")}</th>
              <th scope="col">{screenerText(locale, "colQuoteVolume")}</th>
              {metricColumns.map(([key, textKey]) => (
                <th scope="col" key={key}>
                  {screenerText(locale, textKey)}
                </th>
              ))}
              <th scope="col">{screenerText(locale, "colMatched")}</th>
              <th scope="col">{screenerText(locale, "colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.symbol}>
                <th scope="row" className="arb-route-cell">
                  <strong>{row.symbol}</strong>
                  <small>{formatBarTime(row.closedBarTime, locale)}</small>
                </th>
                <td>{formatDecimal(row.lastClose, locale)}</td>
                <td>{formatChange(row.change24hPercent, locale)}</td>
                <td>{formatDecimal(row.quoteVolume24h, locale)}</td>
                {metricColumns.map(([key]) => (
                  <td key={key} title={row.metrics[key] === undefined ? screenerText(locale, "metricUnavailable") : undefined}>
                    {formatDecimal(row.metrics[key], locale)}
                  </td>
                ))}
                <td>{row.matchedFilters}</td>
                <td>
                  <OpenChartButton locale={locale} symbol={row.symbol} onOpen={() => onOpenRow(row)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ResultCard({ locale, row, metricColumns, onOpen }: { locale: Locale; row: ScreenerRowV1; metricColumns: ReadonlyArray<readonly [keyof ScreenerRowV1["metrics"], ScreenerMessageKey]>; onOpen(): void }) {
  return (
    <li className="arb-result-card">
      <article>
        <header>
          <div>
            <strong>{row.symbol}</strong>
            <small>{formatBarTime(row.closedBarTime, locale)}</small>
          </div>
          <div className="arb-card-edge">
            <span>{screenerText(locale, "colLastClose")}</span>
            <mark>{formatDecimal(row.lastClose, locale)}</mark>
          </div>
        </header>
        <dl className="arb-card-metrics">
          <div>
            <dt>{screenerText(locale, "colChange24h")}</dt>
            <dd>{formatChange(row.change24hPercent, locale)}</dd>
          </div>
          <div>
            <dt>{screenerText(locale, "colQuoteVolume")}</dt>
            <dd>{formatDecimal(row.quoteVolume24h, locale)}</dd>
          </div>
          {metricColumns.map(([key, textKey]) => (
            <div key={key}>
              <dt>{screenerText(locale, textKey)}</dt>
              <dd>{formatDecimal(row.metrics[key], locale)}</dd>
            </div>
          ))}
          <div>
            <dt>{screenerText(locale, "colMatched")}</dt>
            <dd>{row.matchedFilters}</dd>
          </div>
        </dl>
        <OpenChartButton locale={locale} symbol={row.symbol} onOpen={onOpen} />
      </article>
    </li>
  );
}

function OpenChartButton({ locale, symbol, onOpen }: { locale: Locale; symbol: string; onOpen(): void }) {
  return (
    <span className="arb-row-actions">
      <button type="button" aria-label={screenerText(locale, "openChart", { symbol })} title={screenerText(locale, "openChart", { symbol })} onClick={onOpen}>
        <BarChart3 size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

function formatDecimal(value: string | undefined, locale: Locale): string {
  if (value === undefined) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(numeric);
}

function formatChange(value: string | undefined, locale: Locale): string {
  if (value === undefined) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric > 0 ? "+" : ""}${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }).format(numeric)}%`;
}

function formatBarTime(value: number, locale: Locale): string {
  return new Date(value).toLocaleString(localeTag(locale));
}
