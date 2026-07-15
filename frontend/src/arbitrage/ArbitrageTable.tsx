import { FlaskConical, Layers3 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import type { ArbitrageDepthResponse, ArbitrageOpportunity } from "./client";
import { arbitrageText } from "./text";
import { capitalEstimate, convergenceScenarios, routeCostBreakdown, type ArbitrageFeeProfile, type BasisDisplayedScenario } from "./fees";
import { ArbitrageHistoryChart } from "./ArbitrageHistoryChart";
import type { ArbitrageChartTarget } from "./chartTarget";
import { analysisText } from "./analysisText";
import { adaptBasisOpportunity } from "./marketOpportunityAdapters";
import { OpportunityHandoffButton } from "./OpportunityHandoffButton";

export type ArbitrageDepthError = "depthUnavailable" | "exitDepthUnavailable";

interface Props {
  locale: Locale;
  rows: ArbitrageOpportunity[];
  columns?: ReadonlySet<string>;
  scenario(row: ArbitrageOpportunity): BasisDisplayedScenario;
  depth?: { routeId: string; loading: boolean; error?: ArbitrageDepthError; value?: ArbitrageDepthResponse };
  onDepth(row: ArbitrageOpportunity): void;
  onPaper(row: ArbitrageOpportunity): void;
  onOpenChart(target: ArbitrageChartTarget): void;
  profile: ArbitrageFeeProfile;
  notionalUsd: number;
}

const PAGE_SIZE = 50;
const ALL_COLUMNS = new Set(["route", "spot", "perpetual", "gross", "net", "profit", "capacity", "funding", "actions"]);
const depthQualityKey = {
  fresh: "depthQualityFresh",
  stale: "depthQualityStale",
  skewed: "depthQualitySkewed",
  unverified: "depthQualityUnverified"
} as const;
const signalQualityKey = {
  fresh: "signalQualityFresh",
  stale: "signalQualityStale",
  skewed: "signalQualitySkewed",
  unverified: "signalQualityUnverified"
} as const;

export function ArbitrageTable({ locale, rows, columns = ALL_COLUMNS, scenario, depth, onDepth, onPaper, onOpenChart, profile, notionalUsd }: Props) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  useEffect(() => {
    setPage((value) => Math.min(value, pages - 1));
  }, [pages]);
  const visible = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const from = rows.length ? page * PAGE_SIZE + 1 : 0;
  const to = Math.min(rows.length, (page + 1) * PAGE_SIZE);
  return (
    <div className="arb-table-shell">
      <table className="arb-table" style={{ minWidth: `${Math.max(680, columns.size * 135)}px` }}>
        <caption>{arbitrageText(locale, "results")}</caption>
        <thead>
          <tr>
            {columns.has("route") && <th scope="col">{arbitrageText(locale, "pair")}</th>}
            {columns.has("spot") && <th scope="col">{arbitrageText(locale, "buySpot")}</th>}
            {columns.has("perpetual") && <th scope="col">{arbitrageText(locale, "shortPerpetual")}</th>}
            {columns.has("gross") && <th scope="col">{arbitrageText(locale, "grossSpread")}</th>}
            {columns.has("net") && <th scope="col">{arbitrageText(locale, "netEdge")}</th>}
            {columns.has("profit") && <th scope="col">{arbitrageText(locale, "expectedProfit")}</th>}
            {columns.has("capacity") && <th scope="col">{arbitrageText(locale, "capacity")}</th>}
            {columns.has("funding") && <th scope="col">{arbitrageText(locale, "funding")}</th>}
            {columns.has("actions") && <th scope="col">{arbitrageText(locale, "actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const displayedScenario = scenario(row);
            const isOpen = depth?.routeId === row.id;
            return <RowGroup key={row.id} row={row} locale={locale} columns={columns} scenario={displayedScenario} depth={isOpen ? depth : undefined} onDepth={() => onDepth(row)} onPaper={() => onPaper(row)} onOpenChart={onOpenChart} profile={profile} notionalUsd={notionalUsd} />;
          })}
        </tbody>
      </table>
      {rows.length > PAGE_SIZE && (
        <nav className="arb-pagination" aria-label={arbitrageText(locale, "results")}>
          <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            {arbitrageText(locale, "previousPage")}
          </button>
          <span>{arbitrageText(locale, "pageStatus", { from: String(from), to: String(to), total: String(rows.length) })}</span>
          <button type="button" disabled={page >= pages - 1} onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>
            {arbitrageText(locale, "nextPage")}
          </button>
        </nav>
      )}
    </div>
  );
}

function RowGroup({
  row,
  locale,
  columns,
  scenario,
  depth,
  onDepth,
  onPaper,
  onOpenChart,
  profile,
  notionalUsd
}: { row: ArbitrageOpportunity; locale: Locale; columns: ReadonlySet<string>; scenario: BasisDisplayedScenario; depth?: Props["depth"]; onDepth(): void; onPaper(): void; onOpenChart(target: ArbitrageChartTarget): void; profile: ArbitrageFeeProfile; notionalUsd: number }) {
  const number = (value: number) => new Intl.NumberFormat(localeTag(locale), { maximumSignificantDigits: 10 }).format(value);
  const money = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  const net = scenario.netEdgeBps;
  const profit = scenario.projectedNetProfitUsd;
  const cost = scenario.basisScenario.costBreakdownBps.total;
  return (
    <>
      <tr>
        {columns.has("route") && (
          <th scope="row" className="arb-route-cell">
            <strong>{row.symbol}</strong>
            <small>
              USDT · <mark className={row.dataQuality === "fresh" ? "positive" : "negative"}>{arbitrageText(locale, signalQualityKey[row.dataQuality])}</mark>
            </small>
          </th>
        )}
        {columns.has("spot") && (
          <td className="arb-leg-cell">
            <strong>{venue(row.spotExchange)}</strong>
            <span>
              {arbitrageText(locale, "buyAt")} {number(row.spotAsk)}
            </span>
          </td>
        )}
        {columns.has("perpetual") && (
          <td className="arb-leg-cell">
            <strong>{venue(row.futuresExchange)}</strong>
            <span>
              {arbitrageText(locale, "sellAt")} {number(row.futuresBid)}
            </span>
          </td>
        )}
        {columns.has("gross") && <td>{formatBps(row.grossSpreadBps)}</td>}
        {columns.has("net") && (
          <td>
            <mark className={net > 0 ? "positive" : "negative"}>{formatBps(net)}</mark>
            <small>
              −{cost.toFixed(1)} {arbitrageText(locale, "basisPointUnit")}
            </small>
          </td>
        )}
        {columns.has("profit") && (
          <td>
            <mark className={profit > 0 ? "positive" : "negative"}>{new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(profit)}</mark>
          </td>
        )}
        {columns.has("capacity") && <td>{money(row.topBookCapacityUsd)}</td>}
        {columns.has("funding") && <td className={row.fundingRate >= 0 ? "funding-positive" : "funding-negative"}>{(row.fundingRate * 100).toFixed(4)}%</td>}
        {columns.has("actions") && (
          <td>
            <span className="arb-row-actions">
              <button type="button" onClick={onDepth} aria-label={arbitrageText(locale, "analyzeDepth", { symbol: row.symbol })}>
                <Layers3 size={14} aria-hidden="true" />
              </button>
              <button type="button" onClick={onPaper} aria-label={arbitrageText(locale, "openPaper", { symbol: row.symbol })} title={row.dataQuality === "fresh" ? undefined : arbitrageText(locale, "paperRequiresFreshSignal")}>
                <FlaskConical size={14} aria-hidden="true" />
              </button>
              <OpportunityHandoffButton locale={locale} name={row.symbol} createOpportunity={() => adaptBasisOpportunity(row, scenario)} />
              <button
                type="button"
                onClick={() => onOpenChart({ symbol: row.symbol, exchange: row.spotExchange, marketType: "spot", priceType: "last" })}
                aria-label={arbitrageText(locale, "openSpotChart", { symbol: row.symbol, venue: venue(row.spotExchange) })}
                title={arbitrageText(locale, "openSpotChart", { symbol: row.symbol, venue: venue(row.spotExchange) })}
              >
                <span className="arb-market-glyph" aria-hidden="true">
                  S
                </span>
              </button>
              <button
                type="button"
                onClick={() => onOpenChart({ symbol: row.symbol, exchange: row.futuresExchange, marketType: "linear", priceType: "last" })}
                aria-label={arbitrageText(locale, "openPerpetualChart", { symbol: row.symbol, venue: venue(row.futuresExchange) })}
                title={arbitrageText(locale, "openPerpetualChart", { symbol: row.symbol, venue: venue(row.futuresExchange) })}
              >
                <span className="arb-market-glyph" aria-hidden="true">
                  P
                </span>
              </button>
            </span>
          </td>
        )}
      </tr>
      {depth && (
        <tr className="arb-depth-row">
          <td colSpan={columns.size}>
            <DepthPanel locale={locale} state={depth} row={row} profile={profile} notionalUsd={notionalUsd} />
          </td>
        </tr>
      )}
    </>
  );
}

function DepthPanel({ locale, state, row, profile, notionalUsd }: { locale: Locale; state: NonNullable<Props["depth"]>; row: ArbitrageOpportunity; profile: ArbitrageFeeProfile; notionalUsd: number }) {
  if (state.loading) return <div className="arb-depth-panel">{arbitrageText(locale, "loadingDepth")}</div>;
  if (state.error)
    return (
      <div className="arb-depth-panel danger" role="alert">
        {arbitrageText(locale, state.error)}
      </div>
    );
  if (!state.value) return null;
  const value = state.value;
  const analyzedNotional = Math.min(notionalUsd, value.spot.filledNotionalUsd);
  const analyzedBreakdown = routeCostBreakdown(row, profile, analyzedNotional);
  const depthNet = value.grossSpreadBps - analyzedBreakdown.totalBps;
  return (
    <div className="arb-depth-panel">
      <strong>{arbitrageText(locale, "depthResult", { amount: value.requestedNotionalUsd.toLocaleString(localeTag(locale)) })}</strong>
      <span>
        {arbitrageText(locale, "spotVwap")}: {value.spot.averagePrice.toPrecision(8)} · {value.spot.levelsUsed} {arbitrageText(locale, "levels")} · {value.spot.slippageBps.toFixed(2)} {arbitrageText(locale, "basisPointUnit")}
      </span>
      <span>
        {arbitrageText(locale, "perpetualVwap")}: {value.perpetual.averagePrice.toPrecision(8)} · {value.perpetual.levelsUsed} {arbitrageText(locale, "levels")} · {value.perpetual.slippageBps.toFixed(2)} {arbitrageText(locale, "basisPointUnit")}
      </span>
      <span>
        {arbitrageText(locale, "depthTiming", {
          age: String(Math.round(value.timing.ageMs)),
          skew: String(Math.round(value.timing.receiveSkewMs))
        })}
        {value.timing.exchangeSkewMs === undefined ? ` · ${arbitrageText(locale, "depthExchangePartial")}` : ` · ${arbitrageText(locale, "depthExchangeSkew", { skew: String(Math.round(value.timing.exchangeSkewMs)) })}`}
      </span>
      <mark className={value.timing.quality === "fresh" ? "positive" : "negative"}>{arbitrageText(locale, depthQualityKey[value.timing.quality])}</mark>
      <span>
        {arbitrageText(locale, "depthNet")}: <mark className={depthNet > 0 ? "positive" : "negative"}>{formatBps(depthNet)}</mark>
      </span>
      <span>
        {analysisText(locale, "depthCostBreakdown", {
          fees: analyzedBreakdown.tradingFeesBps.toFixed(1),
          funding: analyzedBreakdown.fundingCostBps.toFixed(1),
          financing: analyzedBreakdown.borrowCostBps.toFixed(1),
          transfer: analyzedBreakdown.transferCostBps.toFixed(1)
        })}
      </span>
      <mark className={value.complete ? "positive" : "negative"}>{value.complete ? arbitrageText(locale, "depthComplete") : arbitrageText(locale, "depthIncomplete")}</mark>
      <ArbitrageHistoryChart routeId={state.routeId} locale={locale} />
      <CapitalScenario locale={locale} row={row} profile={profile} notionalUsd={analyzedNotional} />
    </div>
  );
}

function CapitalScenario({ locale, row, profile, notionalUsd }: { locale: Locale; row: ArbitrageOpportunity; profile: ArbitrageFeeProfile; notionalUsd: number }) {
  const capital = capitalEstimate(row, profile, notionalUsd);
  const scenarios = convergenceScenarios(row, profile, notionalUsd);
  const breakdown = routeCostBreakdown(row, profile, capital.executableNotionalUsd || notionalUsd);
  const currency = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
  const costRows: Array<[string, number]> = [
    [analysisText(locale, "tradingFees"), breakdown.tradingFeesBps],
    [analysisText(locale, "slippage"), breakdown.slippageReserveBps],
    [analysisText(locale, "financing"), breakdown.borrowCostBps],
    [analysisText(locale, "transfer"), breakdown.transferCostBps],
    [analysisText(locale, "funding"), breakdown.fundingCostBps]
  ];
  return (
    <section className="arb-depth-analysis" aria-labelledby={`arb-analysis-${row.id.replaceAll(":", "-")}`}>
      <header>
        <strong id={`arb-analysis-${row.id.replaceAll(":", "-")}`}>{analysisText(locale, "analysisTitle")}</strong>
        <p>{analysisText(locale, "analysisHint")}</p>
      </header>
      <dl className="arb-capital-summary">
        <div>
          <dt>{analysisText(locale, "spotCapital")}</dt>
          <dd>{currency(capital.spotCapitalUsd)}</dd>
        </div>
        <div>
          <dt>{analysisText(locale, "derivativeMargin")}</dt>
          <dd>{currency(capital.derivativeInitialMarginUsd)}</dd>
        </div>
        <div>
          <dt>{analysisText(locale, "safetyBuffer")}</dt>
          <dd>{currency(capital.derivativeSafetyBufferUsd)}</dd>
        </div>
        <div>
          <dt>{analysisText(locale, "requiredCapital")}</dt>
          <dd>{currency(capital.requiredCapitalUsd)}</dd>
        </div>
      </dl>
      <div className="arb-analysis-tables">
        <table>
          <caption>{analysisText(locale, "costWaterfall")}</caption>
          <thead>
            <tr>
              <th scope="col">{analysisText(locale, "component")}</th>
              <th scope="col">{analysisText(locale, "costBps")}</th>
              <th scope="col">{analysisText(locale, "costUsd")}</th>
            </tr>
          </thead>
          <tbody>
            {costRows.map(([label, bps]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{bps.toFixed(2)}</td>
                <td>{currency((capital.executableNotionalUsd * bps) / 10_000)}</td>
              </tr>
            ))}
            <tr className="total">
              <th scope="row">{analysisText(locale, "totalCosts")}</th>
              <td>{breakdown.totalBps.toFixed(2)}</td>
              <td>{currency((capital.executableNotionalUsd * breakdown.totalBps) / 10_000)}</td>
            </tr>
          </tbody>
        </table>
        <table>
          <caption>{analysisText(locale, "scenario")}</caption>
          <thead>
            <tr>
              <th scope="col">{analysisText(locale, "convergence")}</th>
              <th scope="col">{analysisText(locale, "grossPnl")}</th>
              <th scope="col">{analysisText(locale, "netPnl")}</th>
              <th scope="col">{analysisText(locale, "roi")}</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((scenario) => (
              <tr key={scenario.convergencePct}>
                <th scope="row">{scenario.convergencePct}%</th>
                <td>{currency(scenario.grossPnlUsd)}</td>
                <td className={scenario.netPnlUsd >= 0 ? "positive" : "negative"}>{currency(scenario.netPnlUsd)}</td>
                <td>{scenario.roiPct.toFixed(3)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function venue(exchange: "binance" | "bybit") {
  return exchange === "binance" ? "Binance" : "Bybit";
}
export function formatBps(value: number) {
  return `${value >= 0 ? "+" : ""}${(value / 100).toFixed(3)}%`;
}
