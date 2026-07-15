import { Bell, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { PriceAlert } from "../market/alerts";
import type { NewAlertInput } from "../hooks/usePriceAlerts";
import type { Candle, DataMarketType, Instrument, PriceType } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";
import { localeTag, type Locale } from "../i18n";
import { shellText } from "../i18n/shell";

interface StatsPanelProps {
  locale: Locale;
  instrument: Instrument;
  candles: Candle[];
  provider: string;
  connection: ConnectionState;
  message: string;
  latencyMs?: number;
  gapCount?: number;
  missingBars?: number;
  fallbackActive?: boolean;
  marketType?: DataMarketType;
  priceType?: PriceType;
  alerts: PriceAlert[];
  onAddAlert: (input: NewAlertInput) => void;
  onRemoveAlert: (id: string) => void;
  onResetAlert: (id: string) => void;
}

export function StatsPanel({
  locale,
  instrument,
  candles,
  provider,
  connection,
  message,
  latencyMs,
  gapCount = 0,
  missingBars = 0,
  fallbackActive = false,
  marketType = "spot",
  priceType = "last",
  alerts,
  onAddAlert,
  onRemoveAlert,
  onResetAlert
}: StatsPanelProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const change = latest && previous ? latest.close - previous.close : 0;
  const percent = latest && previous ? (change / previous.close) * 100 : 0;
  const direction = change >= 0 ? "up" : "down";
  const range = latest ? latest.high - latest.low : undefined;
  const session = sessionRange(candles);

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

      {latest && session && (
        <section className="session-range" aria-label={t("sessionRange")}>
          <div><span>{t("sessionRange")}</span><strong className="num">{session.low.toFixed(instrument.decimals)} — {session.high.toFixed(instrument.decimals)}</strong></div>
          <div className="session-range-track" aria-hidden="true">
            <i style={{ insetInlineStart: `${session.position}%` }} />
          </div>
          <footer><span>L</span><span>{Math.round(session.position)}%</span><span>H</span></footer>
        </section>
      )}

      <section className="stat-table" aria-label={t("barStatistics")}>
        <StatRow label={t("open")} value={format(latest?.open, instrument.decimals)} />
        <StatRow label={t("high")} value={format(latest?.high, instrument.decimals)} />
        <StatRow label={t("low")} value={format(latest?.low, instrument.decimals)} />
        <StatRow label={t("range")} value={format(range, instrument.decimals)} />
        <StatRow label={t("change")} value={`${change >= 0 ? "+" : ""}${change.toFixed(instrument.decimals)}`} tone={direction} />
        <StatRow label={t("volume")} value={compact(latest?.volume, locale)} />
      </section>

      <AlertsSection
        locale={locale}
        instrument={instrument}
        price={latest?.close}
        alerts={alerts.filter((alert) => alert.symbol === instrument.symbol)}
        onAddAlert={onAddAlert}
        onRemoveAlert={onRemoveAlert}
        onResetAlert={onResetAlert}
      />

      <section>
        <div className="panel-header">
          <strong>{t("feed")}</strong>
          <span className={connection}>{connection}</span>
        </div>
        <div className="feed-list">
          <FeedRow label={t("provider")} value={provider} />
          <FeedRow label={t("marketType")} value={instrument.assetClass === "crypto" ? `${marketType === "spot" ? t("spotMarket") : marketType} · ${priceType}` : instrument.assetClass} />
          <FeedRow label={t("latency")} value={latencyMs !== undefined ? `${latencyMs} ms` : "…"} num />
          <FeedRow label={t("candles")} value={String(candles.length)} num />
          <FeedRow label={t("dataGaps")} value={gapCount ? `${gapCount} (${missingBars} ${t("missingBars")})` : t("noDataGaps")} num />
          <FeedRow label={t("dataMode")} value={t(fallbackActive ? "fallbackData" : "liveData")} />
          <FeedRow label={t("status")} value={message} />
        </div>
      </section>
    </aside>
  );
}

function AlertsSection({
  locale,
  instrument,
  price,
  alerts,
  onAddAlert,
  onRemoveAlert,
  onResetAlert
}: {
  locale: Locale;
  instrument: Instrument;
  price?: number;
  alerts: PriceAlert[];
  onAddAlert: (input: NewAlertInput) => void;
  onRemoveAlert: (id: string) => void;
  onResetAlert: (id: string) => void;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
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
    <section className="alerts-section" aria-label={t("priceAlerts")}>
      <div className="panel-header">
        <strong>{t("alerts")}</strong>
        <span>{alerts.length ? `${alerts.length} ${t("on")} ${instrument.symbol}` : instrument.symbol}</span>
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
          placeholder={price !== undefined ? price.toFixed(instrument.decimals) : t("price")}
          aria-label={`${t("alertPrice")} ${instrument.symbol}`}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          {t("add")}
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
                <span className="alert-state">{t(alert.triggered ? "hit" : "armed")}</span>
                {alert.triggered && (
                  <button type="button" aria-label={t("rearmAlert")} title={t("rearm")} onClick={() => onResetAlert(alert.id)}>
                    <RotateCcw size={12} aria-hidden="true" />
                  </button>
                )}
                <button type="button" aria-label={t("removeAlert")} title={t("remove")} onClick={() => onRemoveAlert(alert.id)}>
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

function compact(value: number | undefined, locale: Locale) {
  return value === undefined
    ? "…"
    : Intl.NumberFormat(localeTag(locale), { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function sessionRange(candles: Candle[]) {
  const latest = candles.at(-1);
  if (!latest) return undefined;
  const cutoff = latest.time - 86_400_000;
  const window = candles.filter((candle) => candle.time >= cutoff);
  const source = window.length > 0 ? window : candles;
  const low = Math.min(...source.map((candle) => candle.low));
  const high = Math.max(...source.map((candle) => candle.high));
  const position = high === low ? 50 : Math.min(100, Math.max(0, (latest.close - low) / (high - low) * 100));
  return { low, high, position };
}
