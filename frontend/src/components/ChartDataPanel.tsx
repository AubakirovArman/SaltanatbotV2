import { useState } from "react";
import type { ChartMarker, ChartTrade } from "../chart/types";
import type { Candle, Timeframe } from "../types";
import type { Locale } from "../i18n";
import { chartSummary, chartTerm, chartText, executedTradesCaption, intlLocale, recentCandlesCaption, strategySignalsCaption } from "../i18n/chart";

const MAX_ROWS = 20;

interface ChartDataPanelProps {
  candles: Candle[];
  decimals: number;
  focusedIndex?: number;
  signals?: ChartMarker[];
  trades?: ChartTrade[];
  symbol: string;
  timeframe: Timeframe;
  summaryId: string;
  locale: Locale;
}

/** Semantic, keyboard-operable alternative to the pixels rendered by Canvas. */
export function ChartDataPanel({ candles, decimals, focusedIndex, signals = [], trades = [], symbol, timeframe, summaryId, locale }: ChartDataPanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = `${summaryId}-panel`;
  const focused = focusedIndex === undefined ? candles.at(-1) : candles[focusedIndex];
  const recentCandles = candles.slice(-MAX_ROWS).reverse();
  const recentSignals = signals.slice(-MAX_ROWS).reverse();
  const recentTrades = trades.slice(-MAX_ROWS).reverse();

  return (
    <aside className={`chart-data-panel ${open ? "open" : ""}`} aria-label={chartText(locale, "chartData")}>
      <p id={summaryId} className="sr-only">
        {chartSummary(locale, { symbol, timeframe, close: focused ? formatPrice(focused.close, decimals) : undefined, signals: signals.length, trades: trades.length })}
      </p>
      <button type="button" className="chart-data-toggle" aria-controls={panelId} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {chartText(locale, open ? "hideChartData" : "chartData")}
      </button>

      {open && (
        <div id={panelId} className="chart-data-content" role="region" aria-label={chartText(locale, "chartData")}>
          <header>
            <div>
              <strong>{symbol} · {timeframe}</strong>
              <span>{chartText(locale, "semanticAlternative")}</span>
            </div>
            <button type="button" className="chart-data-close" aria-label={chartText(locale, "hideChartData")} onClick={() => setOpen(false)}>×</button>
          </header>

          {focused ? (
            <table className="chart-data-table chart-data-focused">
              <caption>{chartText(locale, focusedIndex === undefined ? "latestCandle" : "focusedCandle")}</caption>
              <thead>
                <tr>
                  <CandleHeaders locale={locale} />
                </tr>
              </thead>
              <tbody>
                <CandleRow candle={focused} decimals={decimals} locale={locale} />
              </tbody>
            </table>
          ) : (
            <p className="chart-data-empty">{chartText(locale, "marketDataLoading")}</p>
          )}

          {recentCandles.length > 0 && (
            <table className="chart-data-table">
              <caption>{recentCandlesCaption(locale, MAX_ROWS)}</caption>
              <thead>
                <tr>
                  <CandleHeaders locale={locale} />
                </tr>
              </thead>
              <tbody>
                {recentCandles.map((candle, index) => (
                  <CandleRow key={`${candle.time}-${index}`} candle={candle} decimals={decimals} locale={locale} />
                ))}
              </tbody>
            </table>
          )}

          <table className="chart-data-table">
            <caption>{strategySignalsCaption(locale, signals.length, MAX_ROWS)}</caption>
            <thead>
              <tr>
                <th scope="col">{chartText(locale, "time")}</th>
                <th scope="col">{chartText(locale, "type")}</th>
                <th scope="col">{chartText(locale, "price")}</th>
                <th scope="col">{chartText(locale, "label")}</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals.length > 0 ? (
                recentSignals.map((signal, index) => (
                  <tr key={`${signal.time}-${signal.kind}-${index}`}>
                    <td>
                      <ChartTime value={signal.time} locale={locale} />
                    </td>
                    <td>{chartTerm(locale, signal.kind)}</td>
                    <td>{formatPrice(signal.price, decimals)}</td>
                    <td>{signal.label ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow columns={4}>{chartText(locale, "noSignals")}</EmptyRow>
              )}
            </tbody>
          </table>

          <table className="chart-data-table">
            <caption>{executedTradesCaption(locale, trades.length, MAX_ROWS)}</caption>
            <thead>
              <tr>
                <th scope="col">{chartText(locale, "entry")}</th>
                <th scope="col">{chartText(locale, "exit")}</th>
                <th scope="col">{chartText(locale, "side")}</th>
                <th scope="col">{chartText(locale, "entryPrice")}</th>
                <th scope="col">{chartText(locale, "exitPrice")}</th>
                <th scope="col">{chartText(locale, "pnl")}</th>
                <th scope="col">{chartText(locale, "reason")}</th>
              </tr>
            </thead>
            <tbody>
              {recentTrades.length > 0 ? (
                recentTrades.map((trade, index) => (
                  <tr key={`${trade.entryTime}-${trade.exitTime}-${index}`}>
                    <td>
                      <ChartTime value={trade.entryTime} locale={locale} />
                    </td>
                    <td>
                      <ChartTime value={trade.exitTime} locale={locale} />
                    </td>
                    <td>{chartTerm(locale, trade.direction)}</td>
                    <td>{formatPrice(trade.entryPrice, decimals)}</td>
                    <td>{formatPrice(trade.exitPrice, decimals)}</td>
                    <td className={trade.pnl >= 0 ? "up" : "down"}>{formatPrice(trade.pnl, decimals)}</td>
                    <td>{chartTerm(locale, trade.reason)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow columns={7}>{chartText(locale, "noTrades")}</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}

function CandleHeaders({ locale }: { locale: Locale }) {
  return (
    <>
      {(["time", "open", "high", "low", "close", "volume"] as const).map((key) => (
        <th key={key} scope="col">
          {chartText(locale, key)}
        </th>
      ))}
    </>
  );
}

function CandleRow({ candle, decimals, locale }: { candle: Candle; decimals: number; locale: Locale }) {
  return (
    <tr>
      <td>
        <ChartTime value={candle.time} locale={locale} />
      </td>
      <td>{formatPrice(candle.open, decimals)}</td>
      <td>{formatPrice(candle.high, decimals)}</td>
      <td>{formatPrice(candle.low, decimals)}</td>
      <td>{formatPrice(candle.close, decimals)}</td>
      <td>{formatVolume(candle.volume, locale)}</td>
    </tr>
  );
}

function ChartTime({ value, locale }: { value: number; locale: Locale }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString(intlLocale(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>;
}

function EmptyRow({ columns, children }: { columns: number; children: string }) {
  return (
    <tr>
      <td colSpan={columns} className="chart-data-empty">
        {children}
      </td>
    </tr>
  );
}

function formatPrice(value: number, decimals: number) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "—";
}

function formatVolume(value: number, locale: Locale) {
  return Number.isFinite(value) ? value.toLocaleString(intlLocale(locale), { maximumFractionDigits: 2 }) : "—";
}
