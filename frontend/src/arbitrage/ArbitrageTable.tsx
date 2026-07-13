import { ArrowRight, FlaskConical, Layers3 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Locale } from "../i18n";
import { localeTag } from "../i18n";
import type { ArbitrageDepthResponse, ArbitrageOpportunity } from "./client";
import { arbitrageText } from "./text";
import type { ArbitrageCostBreakdown } from "./fees";
import { ArbitrageHistoryChart } from "./ArbitrageHistoryChart";

interface Props {
  locale: Locale;
  rows: ArbitrageOpportunity[];
  costs(row: ArbitrageOpportunity): number;
  net(row: ArbitrageOpportunity): number;
  breakdown(row: ArbitrageOpportunity): ArbitrageCostBreakdown;
  depth?: { routeId: string; loading: boolean; error?: string; value?: ArbitrageDepthResponse };
  onDepth(row: ArbitrageOpportunity): void;
  onPaper(row: ArbitrageOpportunity): void;
  onOpenChart(symbol: string): void;
}

const PAGE_SIZE = 50;

export function ArbitrageTable({ locale, rows, costs, breakdown, net, depth, onDepth, onPaper, onOpenChart }: Props) {
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
      <table className="arb-table">
        <caption>{arbitrageText(locale, "results")}</caption>
        <thead>
          <tr>
            <th scope="col">{arbitrageText(locale, "pair")}</th>
            <th scope="col">{arbitrageText(locale, "buySpot")}</th>
            <th scope="col">{arbitrageText(locale, "shortPerpetual")}</th>
            <th scope="col">{arbitrageText(locale, "grossSpread")}</th>
            <th scope="col">{arbitrageText(locale, "netEdge")}</th>
            <th scope="col">{arbitrageText(locale, "capacity")}</th>
            <th scope="col">{arbitrageText(locale, "funding")}</th>
            <th scope="col">{arbitrageText(locale, "actions")}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const rowNet = net(row);
            const isOpen = depth?.routeId === row.id;
            return <RowGroup key={row.id} row={row} locale={locale} cost={costs(row)} breakdown={breakdown(row)} net={rowNet} depth={isOpen ? depth : undefined} onDepth={() => onDepth(row)} onPaper={() => onPaper(row)} onOpenChart={() => onOpenChart(row.symbol)} />;
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

function RowGroup({ row, locale, cost, breakdown, net, depth, onDepth, onPaper, onOpenChart }: { row: ArbitrageOpportunity; locale: Locale; cost: number; breakdown: ArbitrageCostBreakdown; net: number; depth?: Props["depth"]; onDepth(): void; onPaper(): void; onOpenChart(): void }) {
  const number = (value: number) => new Intl.NumberFormat(localeTag(locale), { maximumSignificantDigits: 10 }).format(value);
  const money = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  return (
    <>
      <tr>
        <th scope="row">
          <strong>{row.symbol}</strong>
          <small>USDT</small>
        </th>
        <td>
          <strong>{venue(row.spotExchange)}</strong>
          <span>
            {arbitrageText(locale, "buyAt")} {number(row.spotAsk)}
          </span>
        </td>
        <td>
          <strong>{venue(row.futuresExchange)}</strong>
          <span>
            {arbitrageText(locale, "sellAt")} {number(row.futuresBid)}
          </span>
        </td>
        <td>{formatBps(row.grossSpreadBps)}</td>
        <td>
          <mark className={net > 0 ? "positive" : "negative"}>{formatBps(net)}</mark>
          <small>−{cost.toFixed(1)} bp</small>
        </td>
        <td>{money(row.topBookCapacityUsd)}</td>
        <td className={row.fundingRate >= 0 ? "funding-positive" : "funding-negative"}>{(row.fundingRate * 100).toFixed(4)}%</td>
        <td>
          <span className="arb-row-actions">
            <button type="button" onClick={onDepth} aria-label={arbitrageText(locale, "analyzeDepth", { symbol: row.symbol })}>
              <Layers3 size={14} aria-hidden="true" />
            </button>
            <button type="button" onClick={onPaper} aria-label={arbitrageText(locale, "openPaper", { symbol: row.symbol })}>
              <FlaskConical size={14} aria-hidden="true" />
            </button>
            <button type="button" onClick={onOpenChart} aria-label={arbitrageText(locale, "openChart", { symbol: row.symbol })}>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </span>
        </td>
      </tr>
      {depth && (
        <tr className="arb-depth-row">
          <td colSpan={8}>
            <DepthPanel locale={locale} state={depth} cost={cost} breakdown={breakdown} />
          </td>
        </tr>
      )}
    </>
  );
}

function DepthPanel({ locale, state, cost, breakdown }: { locale: Locale; state: NonNullable<Props["depth"]>; cost: number; breakdown: ArbitrageCostBreakdown }) {
  if (state.loading) return <div className="arb-depth-panel">{arbitrageText(locale, "loadingDepth")}</div>;
  if (state.error)
    return (
      <div className="arb-depth-panel danger" role="alert">
        {state.error}
      </div>
    );
  if (!state.value) return null;
  const value = state.value;
  const depthNet = value.grossSpreadBps - cost;
  return (
    <div className="arb-depth-panel">
      <strong>{arbitrageText(locale, "depthResult", { amount: value.requestedNotionalUsd.toLocaleString(localeTag(locale)) })}</strong>
      <span>
        {arbitrageText(locale, "spotVwap")}: {value.spot.averagePrice.toPrecision(8)} · {value.spot.levelsUsed} {arbitrageText(locale, "levels")} · {value.spot.slippageBps.toFixed(2)} bp
      </span>
      <span>
        {arbitrageText(locale, "perpetualVwap")}: {value.perpetual.averagePrice.toPrecision(8)} · {value.perpetual.levelsUsed} {arbitrageText(locale, "levels")} · {value.perpetual.slippageBps.toFixed(2)} bp
      </span>
      <span>
        {arbitrageText(locale, "depthNet")}: <mark className={depthNet > 0 ? "positive" : "negative"}>{formatBps(depthNet)}</mark>
      </span>
      <span>
        Fees {breakdown.tradingFeesBps.toFixed(1)} · funding {breakdown.fundingCostBps.toFixed(1)} · financing {breakdown.borrowCostBps.toFixed(1)} · transfer {breakdown.transferCostBps.toFixed(1)} bp
      </span>
      <mark className={value.complete ? "positive" : "negative"}>{value.complete ? arbitrageText(locale, "depthComplete") : arbitrageText(locale, "depthIncomplete")}</mark>
      <ArbitrageHistoryChart routeId={state.routeId} locale={locale} />
    </div>
  );
}

export function venue(exchange: "binance" | "bybit") {
  return exchange === "binance" ? "Binance" : "Bybit";
}
export function formatBps(value: number) {
  return `${value >= 0 ? "+" : ""}${(value / 100).toFixed(3)}%`;
}
