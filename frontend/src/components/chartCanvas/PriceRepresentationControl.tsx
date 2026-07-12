import { RotateCcw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  DEFAULT_PRICE_REPRESENTATION_SETTINGS,
  isConfigurablePriceRepresentation,
  loadPriceRepresentationSettings,
  PRICE_REPRESENTATION_SETTINGS_EVENT,
  PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY,
  priceRepresentationBadge,
  sanitizePriceRepresentationSettings,
  storePriceRepresentationSettings,
  type PriceRepresentationSettings
} from "../../chart/priceRepresentationSettings";
import type { Locale } from "../../i18n";
import type { ChartType } from "../../types";

export { priceRepresentationBadge } from "../../chart/priceRepresentationSettings";

type SettingKey = keyof PriceRepresentationSettings;

export interface PriceRepresentationState {
  settings: PriceRepresentationSettings;
  update(key: SettingKey, value: number): void;
  reset(key: SettingKey): void;
}

export function usePriceRepresentationSettings(): PriceRepresentationState {
  const [settings, setSettings] = useState(loadPriceRepresentationSettings);
  useEffect(() => {
    const sync = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY) return;
      setSettings(event instanceof CustomEvent ? sanitizePriceRepresentationSettings(event.detail) : loadPriceRepresentationSettings());
    };
    window.addEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const commit = useCallback((next: PriceRepresentationSettings) => {
    const safe = sanitizePriceRepresentationSettings(next);
    storePriceRepresentationSettings(safe);
    setSettings(safe);
  }, []);
  return {
    settings,
    update: (key, value) => commit({ ...settings, [key]: value }),
    reset: (key) => commit({ ...settings, [key]: DEFAULT_PRICE_REPRESENTATION_SETTINGS[key] })
  };
}

export function PriceRepresentationControl({ chartType, locale, state }: { chartType: ChartType; locale: Locale; state: PriceRepresentationState }) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  if (!isConfigurablePriceRepresentation(chartType)) return null;
  const config = controlConfig(chartType, locale, state.settings);
  const badge = priceRepresentationBadge(chartType, state.settings);
  const settingsLabel = locale === "ru" ? `Настройки ${badge}` : `${badge} settings`;

  return (
    <details className="price-representation-control" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
      <summary aria-label={settingsLabel}>
        <Settings2 size={13} aria-hidden="true" />
        <span>{badge}</span>
      </summary>
      <div className="price-representation-panel">
        <label htmlFor={inputId}>{config.label}</label>
        <div className="price-representation-input">
          <input
            id={inputId}
            name={config.key}
            type="number"
            inputMode={config.step === 1 ? "numeric" : "decimal"}
            min={config.min}
            max={config.max}
            step={config.step}
            value={config.value}
            aria-describedby={helpId}
            onChange={(event) => {
              if (Number.isFinite(event.currentTarget.valueAsNumber)) state.update(config.key, event.currentTarget.valueAsNumber);
            }}
          />
          <output htmlFor={inputId}>{config.suffix}</output>
        </div>
        <p id={helpId}>{config.help}</p>
        <button type="button" onClick={() => state.reset(config.key)}>
          <RotateCcw size={13} aria-hidden="true" />
          {locale === "ru" ? "По умолчанию" : "Reset default"}
        </button>
      </div>
    </details>
  );
}

function controlConfig(chartType: ChartType, locale: Locale, settings: PriceRepresentationSettings) {
  if (chartType === "linebreak") return {
    key: "lineBreakDepth" as const, value: settings.lineBreakDepth, min: 1, max: 10, step: 1, suffix: locale === "ru" ? "линий" : "lines",
    label: locale === "ru" ? "Глубина разворота" : "Reversal depth",
    help: locale === "ru" ? "Разворот требует пробоя диапазона последних N подтверждённых линий." : "A reversal must break the range of the latest N confirmed lines."
  };
  const kagi = chartType === "kagi";
  return {
    key: kagi ? "kagiReversalPercent" as const : "renkoBrickPercent" as const,
    value: kagi ? settings.kagiReversalPercent : settings.renkoBrickPercent,
    min: 0.01, max: 10, step: 0.01, suffix: "%",
    label: locale === "ru" ? (kagi ? "Процент разворота" : "Размер кирпича") : (kagi ? "Reversal percentage" : "Brick percentage"),
    help: locale === "ru" ? "Фиксируется от первой загруженной подтверждённой цены и перестраивает всю отображаемую историю." : "Seeded from the first loaded confirmed price and rebuilds the full displayed history."
  };
}
