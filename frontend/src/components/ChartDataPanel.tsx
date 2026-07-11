import { useState } from "react";
import type { ChartMarker, ChartTrade } from "../chart/types";
import type { Candle, Timeframe } from "../types";

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
}

/** Semantic, keyboard-operable alternative to the pixels rendered by Canvas. */
export function ChartDataPanel({ candles, decimals, focusedIndex, signals = [], trades = [], symbol, timeframe, summaryId }: ChartDataPanelProps) {
  const [open, setOpen] = useState(false);
  const panelId = `${summaryId}-panel`;
  const focused = focusedIndex === undefined ? candles.at(-1) : candles[focusedIndex];
  const recentCandles = candles.slice(-MAX_ROWS).reverse();
  const recentSignals = signals.slice(-MAX_ROWS).reverse();
  const recentTrades = trades.slice(-MAX_ROWS).reverse();

  return (
    <aside className={`chart-data-panel ${open ? "open" : ""}`} aria-label="Chart data">
      <p id={summaryId} className="sr-only">
        {focused ? `${symbol} ${timeframe}. Focused candle close ${formatPrice(focused.close, decimals)}. ${signals.length} signals and ${trades.length} trades.` : `${symbol} ${timeframe}. Chart data is loading.`}
      </p>
      <button type="button" className="chart-data-toggle" aria-controls={panelId} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide chart data" : "Chart data"}
      </button>

      {open && (
        <div id={panelId} className="chart-data-content">
          <header>
            <strong>
              {symbol} · {timeframe}
            </strong>
            <span>Semantic alternative to the visual chart</span>
          </header>

          {focused ? (
            <table className="chart-data-table chart-data-focused">
              <caption>{focusedIndex === undefined ? "Latest candle" : "Focused candle"}</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Open</th>
                  <th scope="col">High</th>
                  <th scope="col">Low</th>
                  <th scope="col">Close</th>
                  <th scope="col">Volume</th>
                </tr>
              </thead>
              <tbody>
                <CandleRow candle={focused} decimals={decimals} />
              </tbody>
            </table>
          ) : (
            <p className="chart-data-empty">Market data is loading.</p>
          )}

          {recentCandles.length > 0 && (
            <table className="chart-data-table">
              <caption>Recent candles (newest first, up to {MAX_ROWS})</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Open</th>
                  <th scope="col">High</th>
                  <th scope="col">Low</th>
                  <th scope="col">Close</th>
                  <th scope="col">Volume</th>
                </tr>
              </thead>
              <tbody>
                {recentCandles.map((candle) => (
                  <CandleRow key={candle.time} candle={candle} decimals={decimals} />
                ))}
              </tbody>
            </table>
          )}

          <table className="chart-data-table">
            <caption>
              Strategy signals ({signals.length} total; newest {MAX_ROWS} shown)
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Price</th>
                <th scope="col">Label</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals.length > 0 ? (
                recentSignals.map((signal, index) => (
                  <tr key={`${signal.time}-${signal.kind}-${index}`}>
                    <td>
                      <ChartTime value={signal.time} />
                    </td>
                    <td>{signal.kind}</td>
                    <td>{formatPrice(signal.price, decimals)}</td>
                    <td>{signal.label ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow columns={4}>No strategy signals.</EmptyRow>
              )}
            </tbody>
          </table>

          <table className="chart-data-table">
            <caption>
              Executed trades ({trades.length} total; newest {MAX_ROWS} shown)
            </caption>
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Exit</th>
                <th scope="col">Side</th>
                <th scope="col">Entry price</th>
                <th scope="col">Exit price</th>
                <th scope="col">P&amp;L</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {recentTrades.length > 0 ? (
                recentTrades.map((trade, index) => (
                  <tr key={`${trade.entryTime}-${trade.exitTime}-${index}`}>
                    <td>
                      <ChartTime value={trade.entryTime} />
                    </td>
                    <td>
                      <ChartTime value={trade.exitTime} />
                    </td>
                    <td>{trade.direction}</td>
                    <td>{formatPrice(trade.entryPrice, decimals)}</td>
                    <td>{formatPrice(trade.exitPrice, decimals)}</td>
                    <td className={trade.pnl >= 0 ? "up" : "down"}>{formatPrice(trade.pnl, decimals)}</td>
                    <td>{trade.reason}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow columns={7}>No executed trades.</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}

function CandleRow({ candle, decimals }: { candle: Candle; decimals: number }) {
  return (
    <tr>
      <td>
        <ChartTime value={candle.time} />
      </td>
      <td>{formatPrice(candle.open, decimals)}</td>
      <td>{formatPrice(candle.high, decimals)}</td>
      <td>{formatPrice(candle.low, decimals)}</td>
      <td>{formatPrice(candle.close, decimals)}</td>
      <td>{formatVolume(candle.volume)}</td>
    </tr>
  );
}

function ChartTime({ value }: { value: number }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>;
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

function formatVolume(value: number) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
}
