import { BellRing, Settings2, Trash2, X } from "lucide-react";
import { ensureNotificationPermission, playAlertBeep } from "../../market/alerts";
import type { MicrostructureAlertEvent, MicrostructureAlertSettings } from "../../chart/microstructureAlerts";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { createChartTimeFormatter, type ChartTimeZone } from "../../chart/timeAxis";

export function TradeFlowAlertCenter({
  locale,
  timeZone,
  settings,
  events,
  onSettingsChange,
  onDismiss,
  onClear
}: {
  locale: Locale;
  timeZone: ChartTimeZone;
  settings: MicrostructureAlertSettings;
  events: MicrostructureAlertEvent[];
  onSettingsChange: (patch: Partial<MicrostructureAlertSettings>) => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const patch = onSettingsChange;
  return (
    <section className="trade-flow-alert-center" aria-label={t("microstructureAlerts")}>
      <header>
        <BellRing size={12} aria-hidden="true" />
        <strong>{t("flowAlerts")}</strong>
        <span>{settings.enabled ? events.length : t("off")}</span>
        {events.length > 0 && (
          <button type="button" onClick={onClear} aria-label={t("clearFlowAlerts")} title={t("clearFlowAlerts")}>
            <Trash2 size={11} aria-hidden="true" />
          </button>
        )}
      </header>
      {events.length > 0 && settings.enabled && (
        <ol aria-live="polite" aria-relevant="additions">
          {events.slice(0, 4).map((event) => {
            const label = eventText(event, t);
            return (
              <li key={event.id} className={event.side ?? ""}>
                <span title={label}>{label}</span>
                <time dateTime={new Date(event.time).toISOString()} title={createChartTimeFormatter(locale, timeZone).dateTime(event.time)}>{createChartTimeFormatter(locale, timeZone).time(event.time)}</time>
                <button type="button" onClick={() => onDismiss(event.id)} aria-label={t("dismissFlowAlert")}>
                  <X size={10} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <details>
        <summary><Settings2 size={11} aria-hidden="true" /> {t("alertSettings")}</summary>
        <div className="trade-flow-alert-settings">
          <Toggle checked={settings.enabled} label={t("enableFlowAlerts")} onChange={(enabled) => patch({ enabled })} />
          <Toggle checked={settings.stackedImbalance} label={t("alertStackedImbalance")} onChange={(stackedImbalance) => patch({ stackedImbalance })} />
          <Toggle checked={settings.potentialAbsorption} label={t("alertPotentialAbsorption")} onChange={(potentialAbsorption) => patch({ potentialAbsorption })} />
          <Toggle checked={settings.cvdSpike} label={t("alertCvdSpike")} onChange={(cvdSpike) => patch({ cvdSpike })} />
          <NumberSetting label={t("cvdDeltaThreshold")} value={settings.cvdDeltaPercent} min={10} max={100} suffix="%" onChange={(cvdDeltaPercent) => patch({ cvdDeltaPercent })} />
          <NumberSetting label={t("cvdMinimumNotional")} value={settings.cvdMinimumNotional} min={100} max={1_000_000_000} suffix="$" onChange={(cvdMinimumNotional) => patch({ cvdMinimumNotional })} />
          <Toggle checked={settings.largePrint} label={t("alertLargePrint")} onChange={(largePrint) => patch({ largePrint })} />
          <NumberSetting label={t("largePrintThreshold")} value={settings.largePrintNotional} min={100} max={1_000_000_000} suffix="$" onChange={(largePrintNotional) => patch({ largePrintNotional })} />
          <Toggle checked={settings.sound} label={t("alertSound")} onChange={(sound) => { patch({ sound }); if (sound) playAlertBeep(); }} />
          <Toggle
            checked={settings.desktopNotifications}
            label={t("desktopNotifications")}
            onChange={(desktopNotifications) => {
              if (!desktopNotifications) { patch({ desktopNotifications: false }); return; }
              void ensureNotificationPermission().then((permission) => patch({ desktopNotifications: permission === "granted" }));
            }}
          />
        </div>
      </details>
    </section>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
}

function NumberSetting({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="number-setting">
      <span>{label}</span>
      <span><input type="number" value={value} min={min} max={max} step={min} onChange={(event) => { const next = Number(event.currentTarget.value); if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next))); }} />{suffix}</span>
    </label>
  );
}

function eventText(event: MicrostructureAlertEvent, t: (key: Parameters<typeof shellText>[1]) => string) {
  const side = event.side === "buy" ? t("buyAggression") : event.side === "sell" ? t("sellAggression") : "";
  if (event.kind === "stacked_imbalance") return `${side} · ${t("stackedImbalance")} ${event.value}×`;
  if (event.kind === "potential_absorption") return `${side} · ${t("potentialAbsorptionShort")} Δ ${event.value.toFixed(0)}%`;
  if (event.kind === "cvd_spike") return `${side} · ${t("cvdSpike")} ${event.value.toFixed(0)}%`;
  return `${side} · ${t("largePrint")} ${formatNotional(event.value)}`;
}

function formatNotional(value: number) {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1, style: "currency", currency: "USD" }).format(value);
}
