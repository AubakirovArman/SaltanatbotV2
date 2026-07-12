import { RotateCcw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  DEFAULT_PRICE_REPRESENTATION_SETTINGS,
  isConfigurablePriceRepresentation,
  loadPriceRepresentationSettings,
  PRICE_REPRESENTATION_SETTINGS_EVENT,
  priceRepresentationSettingsStorageKey,
  priceRepresentationBadge,
  sanitizePriceRepresentationSettings,
  storePriceRepresentationSettings,
  type PriceRepresentationSettingsEventDetail,
  type PriceRepresentationSettings
} from "../../chart/priceRepresentationSettings";
import type { Locale } from "../../i18n";
import type { ChartType } from "../../types";

export { priceRepresentationBadge } from "../../chart/priceRepresentationSettings";

type SettingKey = keyof PriceRepresentationSettings;

export interface PriceRepresentationState {
  settings: PriceRepresentationSettings;
  update(key: SettingKey, value: number): void;
  reset(keys: SettingKey | SettingKey[]): void;
}

export function usePriceRepresentationSettings(symbol: string, chartId: string): PriceRepresentationState {
  const key = priceRepresentationSettingsStorageKey(symbol, chartId);
  const [state, setState] = useState(() => ({ key, settings: loadPriceRepresentationSettings(symbol, chartId) }));
  if (state.key !== key) setState({ key, settings: loadPriceRepresentationSettings(symbol, chartId) });
  useEffect(() => {
    const sync = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== key) return;
        setState({ key, settings: loadPriceRepresentationSettings(symbol, chartId) });
        return;
      }
      const detail = (event as CustomEvent<PriceRepresentationSettingsEventDetail>).detail;
      if (detail?.key !== key) return;
      setState({ key, settings: sanitizePriceRepresentationSettings(detail.settings) });
    };
    window.addEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [chartId, key, symbol]);
  const commit = useCallback((next: PriceRepresentationSettings) => {
    const safe = sanitizePriceRepresentationSettings(next);
    storePriceRepresentationSettings(safe, symbol, chartId);
    setState({ key, settings: safe });
  }, [chartId, key, symbol]);
  const settings = state.settings;
  return {
    settings,
    update: (key, value) => commit({ ...settings, [key]: value }),
    reset: (keys) => {
      const next = { ...settings };
      for (const key of Array.isArray(keys) ? keys : [keys]) next[key] = DEFAULT_PRICE_REPRESENTATION_SETTINGS[key];
      commit(next);
    }
  };
}

export function PriceRepresentationControl({ chartType, locale, state }: { chartType: ChartType; locale: Locale; state: PriceRepresentationState }) {
  const baseId = useId();
  if (!isConfigurablePriceRepresentation(chartType)) return null;
  const configs = controlConfigs(chartType, locale, state.settings);
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
        {configs.map((config, index) => {
          const inputId = `${baseId}-${index}`;
          const helpId = `${inputId}-help`;
          return <div className="price-representation-field" key={config.key}>
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
          </div>;
        })}
        <button type="button" onClick={() => state.reset(configs.map((config) => config.key))}>
          <RotateCcw size={13} aria-hidden="true" />
          {locale === "ru" ? "По умолчанию" : "Reset default"}
        </button>
      </div>
    </details>
  );
}

interface ControlConfig {
  key: SettingKey;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  label: string;
  help: string;
}

function controlConfigs(chartType: ChartType, locale: Locale, settings: PriceRepresentationSettings): ControlConfig[] {
  if (chartType === "linebreak") return [{
    key: "lineBreakDepth" as const, value: settings.lineBreakDepth, min: 1, max: 10, step: 1, suffix: locale === "ru" ? "линий" : "lines",
    label: locale === "ru" ? "Глубина разворота" : "Reversal depth",
    help: locale === "ru" ? "Разворот требует пробоя диапазона последних N подтверждённых линий." : "A reversal must break the range of the latest N confirmed lines."
  }];
  if (chartType === "pnf") return [
    {
      key: "pnfBoxPercent", value: settings.pnfBoxPercent, min: 0.01, max: 10, step: 0.01, suffix: "%",
      label: locale === "ru" ? "Размер клетки" : "Box percentage",
      help: locale === "ru" ? "Фиксируется от первой загруженной подтверждённой цены." : "Seeded from the first loaded confirmed price."
    },
    {
      key: "pnfReversalBoxes", value: settings.pnfReversalBoxes, min: 1, max: 10, step: 1, suffix: locale === "ru" ? "клеток" : "boxes",
      label: locale === "ru" ? "Клеток для разворота" : "Reversal boxes",
      help: locale === "ru" ? "Новая X/O-колонка требует движения на это число клеток." : "A new X/O column requires this many boxes in the opposite direction."
    }
  ];
  const kagi = chartType === "kagi";
  return [{
    key: kagi ? "kagiReversalPercent" as const : "renkoBrickPercent" as const,
    value: kagi ? settings.kagiReversalPercent : settings.renkoBrickPercent,
    min: 0.01, max: 10, step: 0.01, suffix: "%",
    label: locale === "ru" ? (kagi ? "Процент разворота" : "Размер кирпича") : (kagi ? "Reversal percentage" : "Brick percentage"),
    help: locale === "ru" ? "Фиксируется от первой загруженной подтверждённой цены и перестраивает всю отображаемую историю." : "Seeded from the first loaded confirmed price and rebuilds the full displayed history."
  }];
}
