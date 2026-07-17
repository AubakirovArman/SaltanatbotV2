import { Archive, Bell, Power, RefreshCw, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { AlertRuleRecordV1 } from "@saltanatbotv2/contracts";
import { samePriceAlertRoute, type PriceAlert } from "../market/alerts";
import type { NewAlertInput, PriceAlertSyncState } from "../hooks/usePriceAlerts";
import type { Candle, DataExchange, DataMarketType, Instrument, PriceType, Timeframe } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";
import { localeTag, type Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { parseAlertThresholdInput } from "../alerts/localSnapshot";

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
  exchange: DataExchange;
  marketType?: DataMarketType;
  priceType?: PriceType;
  timeframe: Timeframe;
  alerts: PriceAlert[];
  alertSync: PriceAlertSyncState;
  /** Server screener-kind rules; rendered as records, never as price rows. */
  screenerAlerts?: AlertRuleRecordV1[];
  onAddAlert: (input: NewAlertInput) => void | Promise<void>;
  onRemoveAlert: (id: string) => void | Promise<void>;
  onResetAlert: (id: string) => void | Promise<void>;
  onToggleScreenerAlert?: (ruleId: string, enabled: boolean) => void | Promise<void>;
  onArchiveScreenerAlert?: (ruleId: string) => void | Promise<void>;
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
  exchange,
  marketType = "spot",
  priceType = "last",
  timeframe,
  alerts,
  alertSync,
  screenerAlerts = [],
  onAddAlert,
  onRemoveAlert,
  onResetAlert,
  onToggleScreenerAlert,
  onArchiveScreenerAlert
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
        exchange={exchange}
        marketType={marketType}
        priceType={priceType}
        timeframe={timeframe}
        alerts={alerts.filter((alert) => alert.symbol === instrument.symbol && (alert.timeframe === timeframe || alert.timeframe === undefined) && samePriceAlertRoute(alert, { exchange, marketType, priceType }))}
        screenerAlerts={screenerAlerts}
        sync={alertSync}
        onAddAlert={onAddAlert}
        onRemoveAlert={onRemoveAlert}
        onResetAlert={onResetAlert}
        onToggleScreenerAlert={onToggleScreenerAlert}
        onArchiveScreenerAlert={onArchiveScreenerAlert}
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
  exchange,
  marketType,
  priceType,
  timeframe,
  alerts,
  screenerAlerts,
  sync,
  onAddAlert,
  onRemoveAlert,
  onResetAlert,
  onToggleScreenerAlert,
  onArchiveScreenerAlert
}: {
  locale: Locale;
  instrument: Instrument;
  price?: number;
  exchange: DataExchange;
  marketType: DataMarketType;
  priceType: PriceType;
  timeframe: Timeframe;
  alerts: PriceAlert[];
  screenerAlerts: AlertRuleRecordV1[];
  sync: PriceAlertSyncState;
  onAddAlert: (input: NewAlertInput) => void | Promise<void>;
  onRemoveAlert: (id: string) => void | Promise<void>;
  onResetAlert: (id: string) => void | Promise<void>;
  onToggleScreenerAlert?: (ruleId: string, enabled: boolean) => void | Promise<void>;
  onArchiveScreenerAlert?: (ruleId: string) => void | Promise<void>;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string>();
  const [operationError, setOperationError] = useState<string>();

  const submit = async () => {
    setPending("create");
    setOperationError(undefined);
    try {
      const value = parseAlertThresholdInput(draft, instrument.decimals);
      // Direction is inferred from where the target sits relative to the last price.
      const direction = price !== undefined && value < price ? "below" : "above";
      await onAddAlert({ symbol: instrument.symbol, price: value, direction, exchange, marketType, priceType, timeframe });
      setDraft("");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message.slice(0, 256) : t("alertOperationFailed"));
    } finally {
      setPending(undefined);
    }
  };

  const runAction = async (key: string, action: () => void | Promise<void>) => {
    setPending(key);
    setOperationError(undefined);
    try {
      await action();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message.slice(0, 256) : t("alertOperationFailed"));
    } finally {
      setPending(undefined);
    }
  };

  const serverRouteSupported = priceType === "last" && timeframe !== "1M";
  const creationReady = sync.status === "legacy" || (sync.status === "synced" && serverRouteSupported);
  const visibleRuleIds = new Set([
    ...alerts.map(({ serverRuleId }) => serverRuleId).filter((id): id is string => Boolean(id)),
    ...screenerAlerts.map(({ id }) => id)
  ]);
  const recentEvents = sync.events.filter((event) => visibleRuleIds.has(event.ruleId)).slice(0, 5);
  const outboxByEvent = new Map(sync.outbox.map((item) => [item.envelope.alertEventId, item]));

  return (
    <section className="alerts-section" aria-label={t("priceAlerts")}>
      <div className="panel-header">
        <strong>{t("alerts")}</strong>
        <span>{alerts.length ? `${alerts.length} ${t("on")} ${instrument.symbol}` : instrument.symbol}</span>
      </div>
      <div className={`alert-sync-summary ${sync.status}`} role="status" aria-live="polite">
        <span>{t(sync.status === "legacy" ? "alertBrowserOnly" : sync.status === "loading" ? "alertSyncLoading" : sync.status === "error" ? "alertSyncError" : "alertServerSynced")}</span>
        {sync.status === "error" && (
          <button type="button" onClick={sync.refresh} aria-label={t("retryAlertSync")} title={t("retryAlertSync")}>
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {sync.status !== "legacy" && !serverRouteSupported && <p className="alert-review-note">{t("alertServerRouteUnavailable")}</p>}
      {sync.status !== "legacy" && serverRouteSupported && <p className="alert-review-note">{t("alertClosedCandleSemantics")}</p>}
      <form
        className="alert-add"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
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
        <button type="submit" disabled={!draft.trim() || !creationReady || pending !== undefined}>
          {pending === "create" ? t("alertSaving") : t("add")}
        </button>
      </form>
      {(operationError || sync.error) && <p className="alert-operation-error" role="alert">{operationError ?? sync.error}</p>}
      {sync.status !== "legacy" && (
        <details className="alert-activity">
          <summary>{t("alertRecentActivity")}{recentEvents.length ? ` · ${recentEvents.length}` : ""}</summary>
          {recentEvents.length === 0 ? (
            <p>{t("alertNoRecentActivity")}</p>
          ) : (
            <ul>
              {recentEvents.map((event) => {
                const delivery = outboxByEvent.get(event.id);
                const eventAlert = alerts.find((alert) => alert.serverRuleId === event.ruleId);
                const eventScreen = screenerAlerts.find((rule) => rule.id === event.ruleId);
                return (
                  <li key={event.id}>
                    <span title={event.summary}>{eventAlert ? `${eventAlert.symbol} · ` : eventScreen ? `${eventScreen.definition.name} · ` : ""}{t(alertEventMessageKey(event.eventType))}</span>
                    <time dateTime={event.occurredAt}>{new Intl.DateTimeFormat(localeTag(locale), { hour: "2-digit", minute: "2-digit" }).format(new Date(event.occurredAt))}</time>
                    {delivery && <small className={`delivery-${delivery.status}`}>{t(delivery.status === "delivered" ? "alertDeliveryDelivered" : delivery.status === "dead-letter" || delivery.status === "cancelled" ? "alertDeliveryFailed" : "alertDeliveryPending")}</small>}
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}
      {alerts.length > 0 && (
        <ul className="alert-list">
          {alerts
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((alert) => (
              <li key={alert.id} className={`alert-item ${alert.triggered ? "triggered" : ""}`}>
                <span className={`alert-dir ${alert.direction}`}>{alert.direction === "above" ? "▲" : "▼"}</span>
                <span className="alert-price num">{alert.price.toFixed(instrument.decimals)}</span>
                <span className="alert-timeframe num">{alert.timeframe ?? "?"}</span>
                <span className={`alert-source-badge ${alert.syncState ?? alert.source ?? "browser"}`}>
                  {t(alert.syncState === "deleting" ? "alertDeleting" : alert.syncState === "needs-review" ? "alertNeedsReview" : alert.syncState === "syncing" && !alert.serverRuleId ? "alertQueued" : alert.syncState === "syncing" ? "alertSyncing" : alert.syncState === "sync-error" ? "alertSyncError" : alert.source === "server" || alert.syncState === "synced" ? "alertServer" : "alertBrowserOnly")}
                </span>
                <span className="alert-state">{t(alert.triggered ? "hit" : alert.deletionPending || alert.timeframe === undefined ? "alertInactive" : alert.serverLifecycle === "disabled" ? "alertDisabled" : alert.serverLifecycle === "stale" ? "alertStale" : alert.serverLifecycle === "error" ? "alertError" : "armed")}</span>
                {alert.triggered && (
                  <button type="button" disabled={pending !== undefined} aria-label={t("rearmAlert")} title={t("rearm")} onClick={() => void runAction(`reset:${alert.id}`, () => onResetAlert(alert.id))}>
                    <RotateCcw size={12} aria-hidden="true" />
                  </button>
                )}
                <button type="button" disabled={pending !== undefined} aria-label={t("removeAlert")} title={t("remove")} onClick={() => void runAction(`remove:${alert.id}`, () => onRemoveAlert(alert.id))}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
        </ul>
      )}
      {sync.status !== "legacy" && screenerAlerts.length > 0 && (
        <div className="screener-alert-block">
          <div className="panel-header">
            <strong>{t("screenerAlerts")}</strong>
            <span>{screenerAlerts.length}</span>
          </div>
          <ul className="alert-list screener-alert-list" aria-label={t("screenerAlerts")}>
            {screenerAlerts.map((rule) => {
              const enabled = rule.definition.enabled;
              const toggleLabel = t(enabled ? "screenerAlertDisable" : "screenerAlertEnable");
              return (
                <li key={rule.id} className="alert-item screener-alert-item">
                  <span className={`alert-source-badge ${enabled ? "server" : "disabled"}`}>{t("screenerAlertKind")}</span>
                  <span className="alert-name" title={rule.definition.name}>{rule.definition.name}</span>
                  <span className="alert-state">{t(screenerAlertStateKey(rule))}</span>
                  {onToggleScreenerAlert && (
                    <button
                      type="button"
                      disabled={pending !== undefined}
                      aria-label={`${toggleLabel} ${rule.definition.name}`}
                      title={toggleLabel}
                      onClick={() => void runAction(`screener-toggle:${rule.id}`, () => onToggleScreenerAlert(rule.id, !enabled))}
                    >
                      {enabled ? <Power size={12} aria-hidden="true" /> : <Bell size={12} aria-hidden="true" />}
                    </button>
                  )}
                  {onArchiveScreenerAlert && (
                    <button
                      type="button"
                      disabled={pending !== undefined}
                      aria-label={`${t("screenerAlertArchive")} ${rule.definition.name}`}
                      title={t("screenerAlertArchive")}
                      onClick={() => void runAction(`screener-archive:${rule.id}`, () => onArchiveScreenerAlert(rule.id))}
                    >
                      <Archive size={12} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function screenerAlertStateKey(rule: AlertRuleRecordV1) {
  if (!rule.definition.enabled || rule.lifecycleState === "disabled") return "alertDisabled" as const;
  if (rule.lifecycleState === "stale") return "alertStale" as const;
  if (rule.lifecycleState === "error") return "alertError" as const;
  return "armed" as const;
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

function alertEventMessageKey(eventType: "armed" | "rearmed" | "eligible" | "ineligible" | "triggered" | "suppressed" | "stale" | "disabled" | "error") {
  switch (eventType) {
    case "armed": return "alertEventArmed" as const;
    case "rearmed": return "alertEventRearmed" as const;
    case "eligible": return "alertEventEligible" as const;
    case "ineligible": return "alertEventIneligible" as const;
    case "triggered": return "alertEventTriggered" as const;
    case "suppressed": return "alertEventSuppressed" as const;
    case "stale": return "alertEventStale" as const;
    case "disabled": return "alertEventDisabled" as const;
    case "error": return "alertEventError" as const;
  }
}

export function sessionRange(candles: Candle[]) {
  const latest = candles.at(-1);
  if (!latest) return undefined;
  const cutoff = latest.time - 86_400_000;
  let lowIndex = 0;
  let highIndex = candles.length;
  while (lowIndex < highIndex) {
    const middle = (lowIndex + highIndex) >>> 1;
    if (candles[middle].time < cutoff) lowIndex = middle + 1;
    else highIndex = middle;
  }
  const start = lowIndex < candles.length ? lowIndex : 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let index = start; index < candles.length; index += 1) {
    low = Math.min(low, candles[index].low);
    high = Math.max(high, candles[index].high);
  }
  const position = high === low ? 50 : Math.min(100, Math.max(0, (latest.close - low) / (high - low) * 100));
  return { low, high, position };
}
