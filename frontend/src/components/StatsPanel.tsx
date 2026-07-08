import { Bell, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { PriceAlert } from "../market/alerts";
import type { NewAlertInput } from "../hooks/usePriceAlerts";
import type { Candle, Instrument } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";

interface StatsPanelProps {
  instrument: Instrument;
  candles: Candle[];
  provider: string;
  connection: ConnectionState;
  message: string;
  latencyMs?: number;
  alerts: PriceAlert[];
  onAddAlert: (input: NewAlertInput) => void;
  onRemoveAlert: (id: string) => void;
  onResetAlert: (id: string) => void;
}

export function StatsPanel({
  instrument,
  candles,
  provider,
  connection,
  message,
  latencyMs,
  alerts,
  onAddAlert,
  onRemoveAlert,
  onResetAlert
}: StatsPanelProps) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const change = latest && previous ? latest.close - previous.close : 0;
  const percent = latest && previous ? (change / previous.close) * 100 : 0;
  const direction = change >= 0 ? "up" : "down";
  const range = latest ? latest.high - latest.low : undefined;

  return (
    <aside className="stats-panel">
      <section>
        <div className="quote-meta">
          {instrument.symbol} · {instrument.exchange} · {instrument.assetClass}
        </div>
        <div className="quote-block">
          <strong className="num">{latest ? latest.close.toFixed(instrument.decimals) : "…"}</strong>
          <em className={`num ${direction}`}>
            {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(instrument.decimals)} · {percent.toFixed(2)}%
          </em>
        </div>
      </section>

      <section className="stat-table" aria-label="Bar statistics">
        <StatRow label="Open" value={format(latest?.open, instrument.decimals)} />
        <StatRow label="High" value={format(latest?.high, instrument.decimals)} />
        <StatRow label="Low" value={format(latest?.low, instrument.decimals)} />
        <StatRow label="Range" value={format(range, instrument.decimals)} />
        <StatRow label="Change" value={`${change >= 0 ? "+" : ""}${change.toFixed(instrument.decimals)}`} tone={direction} />
        <StatRow label="Volume" value={compact(latest?.volume)} />
      </section>

      <AlertsSection
        instrument={instrument}
        price={latest?.close}
        alerts={alerts.filter((alert) => alert.symbol === instrument.symbol)}
        onAddAlert={onAddAlert}
        onRemoveAlert={onRemoveAlert}
        onResetAlert={onResetAlert}
      />

      <section>
        <div className="panel-header">
          <strong>Feed</strong>
          <span className={connection}>{connection}</span>
        </div>
        <div className="feed-list">
          <FeedRow label="Provider" value={provider} />
          <FeedRow label="Latency" value={latencyMs !== undefined ? `${latencyMs} ms` : "…"} num />
          <FeedRow label="Candles" value={String(candles.length)} num />
          <FeedRow label="Status" value={message} />
        </div>
      </section>
    </aside>
  );
}

function AlertsSection({
  instrument,
  price,
  alerts,
  onAddAlert,
  onRemoveAlert,
  onResetAlert
}: {
  instrument: Instrument;
  price?: number;
  alerts: PriceAlert[];
  onAddAlert: (input: NewAlertInput) => void;
  onRemoveAlert: (id: string) => void;
  onResetAlert: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0) return;
    // Direction is inferred from where the target sits relative to the last price.
    const direction = price !== undefined && value < price ? "below" : "above";
    onAddAlert({ symbol: instrument.symbol, price: value, direction });
    setDraft("");
  };

  return (
    <section className="alerts-section" aria-label="Price alerts">
      <div className="panel-header">
        <strong>Alerts</strong>
        <span>{alerts.length ? `${alerts.length} on ${instrument.symbol}` : instrument.symbol}</span>
      </div>
      <form
        className="alert-add"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Bell size={13} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="number"
          className="num"
          inputMode="decimal"
          step="any"
          min={0}
          value={draft}
          placeholder={price !== undefined ? price.toFixed(instrument.decimals) : "Price"}
          aria-label={`Alert price for ${instrument.symbol}`}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {alerts.length > 0 && (
        <ul className="alert-list">
          {alerts
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((alert) => (
              <li key={alert.id} className={`alert-item ${alert.triggered ? "triggered" : ""}`}>
                <span className={`alert-dir ${alert.direction}`}>{alert.direction === "above" ? "▲" : "▼"}</span>
                <span className="alert-price num">{alert.price.toFixed(instrument.decimals)}</span>
                <span className="alert-state">{alert.triggered ? "hit" : "armed"}</span>
                {alert.triggered && (
                  <button type="button" aria-label="Re-arm alert" title="Re-arm" onClick={() => onResetAlert(alert.id)}>
                    <RotateCcw size={12} aria-hidden="true" />
                  </button>
                )}
                <button type="button" aria-label="Remove alert" title="Remove" onClick={() => onRemoveAlert(alert.id)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong className={`num ${tone ?? ""}`}>{value}</strong>
    </div>
  );
}

function FeedRow({ label, value, num }: { label: string; value: string; num?: boolean }) {
  return (
    <div className="feed-row">
      <span>{label}</span>
      <strong className={num ? "num" : ""} title={value}>{value}</strong>
    </div>
  );
}

function format(value: number | undefined, decimals: number) {
  return value === undefined ? "…" : value.toFixed(decimals);
}

function compact(value: number | undefined) {
  return value === undefined
    ? "…"
    : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
