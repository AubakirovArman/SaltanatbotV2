import { BarChart3, Code2, Eye, EyeOff, Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { indicatorLogicPreview, indicatorSummary } from "../chart/indicatorLogic";
import type {
  BollingerConfig,
  IndicatorConfig,
  MacdConfig,
  PeriodIndicatorConfig,
  StochasticConfig
} from "../chart/indicatorTypes";
import type { Locale } from "../i18n";
import { chartText } from "../i18n/chart";
import { shellText } from "../i18n/shell";
import type { Timeframe } from "../types";
import { VolumeProfileSourceControl } from "./chartCanvas/VolumeProfileSourceControl";
import type { VolumeProfileSourceState } from "./chartCanvas/useVolumeProfileSource";

export interface StrategyMenuItem {
  id: string;
  name: string;
  description: string;
}

export interface VolumeProfileIndicatorControl {
  added: boolean;
  visible: boolean;
  chartTimeframe: Timeframe;
  state: VolumeProfileSourceState;
  onAdd: () => void;
  onVisibleChange: (visible: boolean) => void;
  onRemove: () => void;
}

interface ChartIndicatorOverlayProps {
  locale: Locale;
  indicators: IndicatorConfig[];
  onChange: (indicators: IndicatorConfig[]) => void;
  onEditLogic: (indicator: IndicatorConfig) => void;
  customIndicators?: StrategyMenuItem[];
  strategies?: StrategyMenuItem[];
  activeArtifactId?: string;
  onAddArtifact?: (id: string) => void;
  volumeProfile?: VolumeProfileIndicatorControl;
}

export function ChartIndicatorOverlay({
  locale,
  indicators,
  onChange,
  onEditLogic,
  customIndicators = [],
  strategies = [],
  activeArtifactId,
  onAddArtifact,
  volumeProfile
}: ChartIndicatorOverlayProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingVolumeProfile, setEditingVolumeProfile] = useState(false);
  const active = indicators.filter((indicator) => indicator.enabled);
  const available = indicators.filter((indicator) => !indicator.enabled);
  const editing = useMemo(
    () => indicators.find((indicator) => indicator.id === editingId),
    [editingId, indicators]
  );

  useEffect(() => {
    if (!adding && !editingId && !editingVolumeProfile) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !overlayRef.current?.contains(event.target)) {
        setAdding(false);
        setEditingId(undefined);
        setEditingVolumeProfile(false);
      }
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAdding(false);
      setEditingId(undefined);
      setEditingVolumeProfile(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [adding, editingId, editingVolumeProfile]);

  useEffect(() => {
    if (!volumeProfile?.added) setEditingVolumeProfile(false);
  }, [volumeProfile?.added]);

  const update = (id: string, patch: Partial<IndicatorConfig>) => {
    onChange(indicators.map((indicator) => (
      indicator.id === id ? ({ ...indicator, ...patch } as IndicatorConfig) : indicator
    )));
  };

  const addIndicator = (id: string) => {
    update(id, { enabled: true, visible: true });
    setAdding(false);
    setEditingVolumeProfile(false);
    setEditingId(id);
  };

  return (
    <div className="chart-indicator-overlay" ref={overlayRef}>
      <div className="indicator-strip">
        <button
          type="button"
          className="indicator-add"
          aria-expanded={adding}
          aria-haspopup="menu"
          onClick={() => {
            setAdding((value) => !value);
            setEditingId(undefined);
            setEditingVolumeProfile(false);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          {t("addIndicator")}
        </button>

        {active.map((indicator) => (
          <IndicatorChip
            locale={locale}
            key={indicator.id}
            indicator={indicator}
            editing={indicator.id === editingId}
            onEdit={() => {
              setAdding(false);
              setEditingVolumeProfile(false);
              setEditingId(indicator.id === editingId ? undefined : indicator.id);
            }}
            onRemove={() => {
              update(indicator.id, { enabled: false, visible: true });
              if (editingId === indicator.id) setEditingId(undefined);
            }}
            onToggleVisible={() => update(indicator.id, { visible: indicator.visible === false })}
          />
        ))}
        {volumeProfile?.added && (
          <VolumeProfileChip
            locale={locale}
            control={volumeProfile}
            editing={editingVolumeProfile}
            onEdit={() => {
              setAdding(false);
              setEditingId(undefined);
              setEditingVolumeProfile((value) => !value);
            }}
            onRemove={() => {
              setEditingVolumeProfile(false);
              volumeProfile.onRemove();
            }}
          />
        )}
      </div>

      {adding && (
        <div className="indicator-menu" role="menu">
          <span className="menu-group-title">{t("indicators")}</span>
          {available.map((indicator) => (
            <button type="button" key={indicator.id} role="menuitem" onClick={() => addIndicator(indicator.id)}>
              <span style={{ background: indicator.color }} />
              <strong>{indicator.label}</strong>
              <small>{indicatorSummary(indicator)}</small>
            </button>
          ))}
          {volumeProfile && !volumeProfile.added && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                volumeProfile.onAdd();
                setAdding(false);
                setEditingId(undefined);
                setEditingVolumeProfile(true);
              }}
            >
              <span className="volume-profile-menu-dot" />
              <strong>{chartText(locale, "volumeProfile")}</strong>
              <small>{volumeProfileSummary(locale, volumeProfile)}</small>
            </button>
          )}
          {available.length === 0 && (!volumeProfile || volumeProfile.added) && <p>{t("allIndicatorsAdded")}</p>}

          {onAddArtifact && customIndicators.length > 0 && (
            <>
              <span className="menu-group-title">{t("customIndicators")}</span>
              {customIndicators.map((indicator) => (
                <button
                  type="button"
                  key={indicator.id}
                  role="menuitem"
                  className={`menu-strategy ${indicator.id === activeArtifactId ? "active" : ""}`}
                  onClick={() => { onAddArtifact(indicator.id); setAdding(false); }}
                >
                  <Code2 size={12} aria-hidden="true" />
                  <strong>{indicator.name}</strong>
                  <small>{indicator.description}</small>
                </button>
              ))}
            </>
          )}

          {onAddArtifact && strategies.length > 0 && (
            <>
              <span className="menu-group-title">{t("strategies")}</span>
              {strategies.map((strategy) => (
                <button
                  type="button"
                  key={strategy.id}
                  role="menuitem"
                  className={`menu-strategy ${strategy.id === activeArtifactId ? "active" : ""}`}
                  onClick={() => { onAddArtifact(strategy.id); setAdding(false); }}
                >
                  <Workflow size={12} aria-hidden="true" />
                  <strong>{strategy.name}</strong>
                  <small>{strategy.description}</small>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {editing && (
        <IndicatorEditor
          locale={locale}
          indicator={editing}
          onClose={() => setEditingId(undefined)}
          onUpdate={(patch) => update(editing.id, patch)}
          onEditLogic={() => onEditLogic(editing)}
        />
      )}
      {editingVolumeProfile && volumeProfile?.added && (
        <VolumeProfileSourceControl
          locale={locale}
          chartTimeframe={volumeProfile.chartTimeframe}
          onClose={() => setEditingVolumeProfile(false)}
          state={volumeProfile.state}
        />
      )}
    </div>
  );
}

function VolumeProfileChip({
  locale,
  control,
  editing,
  onEdit,
  onRemove
}: {
  locale: Locale;
  control: VolumeProfileIndicatorControl;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const label = chartText(locale, "volumeProfile");
  return (
    <div className={`indicator-chip volume-profile-chip ${control.visible ? "" : "muted"} ${editing ? "editing" : ""}`}>
      <BarChart3 size={13} aria-hidden="true" />
      <strong>{label}</strong>
      <small>{volumeProfileSummary(locale, control)}</small>
      <button type="button" aria-label={`${shellText(locale, control.visible ? "hide" : "show")} ${label}`} onClick={() => control.onVisibleChange(!control.visible)}>
        {control.visible ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
      </button>
      <button type="button" aria-expanded={editing} aria-label={`${shellText(locale, "edit")} ${label}`} onClick={onEdit}>
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button type="button" aria-label={`${shellText(locale, "remove")} ${label}`} onClick={onRemove}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function volumeProfileSummary(locale: Locale, control: VolumeProfileIndicatorControl): string {
  return control.state.source === "chart"
    ? `${chartText(locale, "volumeProfileAsChart")} · ${control.chartTimeframe}`
    : control.state.source;
}

function IndicatorChip({
  locale,
  indicator,
  editing,
  onEdit,
  onRemove,
  onToggleVisible
}: {
  locale: Locale;
  indicator: IndicatorConfig;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggleVisible: () => void;
}) {
  const hidden = indicator.visible === false;
  return (
    <div className={`indicator-chip ${hidden ? "muted" : ""} ${editing ? "editing" : ""}`}>
      <span className="indicator-dot" style={{ background: indicator.color }} />
      <strong>{indicator.label}</strong>
      <small>{indicatorSummary(indicator)}</small>
      <button type="button" aria-label={`${shellText(locale, hidden ? "show" : "hide")} ${indicator.label}`} onClick={onToggleVisible}>
        {hidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
      </button>
      <button type="button" aria-label={`${shellText(locale, "edit")} ${indicator.label}`} onClick={onEdit}>
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button type="button" aria-label={`${shellText(locale, "remove")} ${indicator.label}`} onClick={onRemove}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function IndicatorEditor({
  locale,
  indicator,
  onClose,
  onUpdate,
  onEditLogic
}: {
  locale: Locale;
  indicator: IndicatorConfig;
  onClose: () => void;
  onUpdate: (patch: Partial<IndicatorConfig>) => void;
  onEditLogic: () => void;
}) {
  return (
    <div className="indicator-editor" role="dialog" aria-label={`${indicator.label} ${shellText(locale, "settings")}`}>
      <div className="indicator-editor-head">
        <strong>{indicator.label}</strong>
        <button type="button" aria-label={shellText(locale, "closeIndicatorEditor")} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="indicator-editor-grid">
        {hasPeriod(indicator) && (
          <NumberField label={shellText(locale, "period")} value={indicator.period} min={2} max={300} onChange={(period) => onUpdate({ period })} />
        )}
        {indicator.kind === "bollinger" && (
          <NumberField label={shellText(locale, "deviation")} value={indicator.deviation} min={0.5} max={5} step={0.1} onChange={(deviation) => onUpdate({ deviation })} />
        )}
        {indicator.kind === "stochastic" && (
          <NumberField label={shellText(locale, "smooth")} value={indicator.smooth} min={1} max={20} onChange={(smooth) => onUpdate({ smooth })} />
        )}
        {indicator.kind === "macd" && <MacdFields locale={locale} indicator={indicator} onUpdate={onUpdate} />}
        <ColorField label={shellText(locale, "line")} value={indicator.color} onChange={(color) => onUpdate({ color })} />
        <label className="indicator-select-field">
          <span>{shellText(locale, "indicatorPane")}</span>
          <select value={indicator.pane ?? "auto"} onChange={(event) => onUpdate({ pane: event.target.value as IndicatorConfig["pane"] })}>
            <option value="auto">{shellText(locale, "paneAuto")}</option>
            {!isOscillator(indicator) && <option value="main">{shellText(locale, "paneMain")}</option>}
            <option value="separate">{shellText(locale, "paneSeparate")}</option>
          </select>
        </label>
        <label className="indicator-select-field">
          <span>{shellText(locale, "scalePlacement")}</span>
          <select value={indicator.scalePlacement ?? "right"} onChange={(event) => onUpdate({ scalePlacement: event.target.value as IndicatorConfig["scalePlacement"] })}>
            <option value="right">{shellText(locale, "scaleRight")}</option>
            <option value="left">{shellText(locale, "scaleLeft")}</option>
            <option value="hidden">{shellText(locale, "scaleHidden")}</option>
          </select>
        </label>
        {indicator.kind === "bollinger" && (
          <ColorField label={shellText(locale, "band")} value={indicator.bandColor} onChange={(bandColor) => onUpdate({ bandColor })} />
        )}
        {indicator.kind === "stochastic" && (
          <ColorField label="%D" value={indicator.signalColor} onChange={(signalColor) => onUpdate({ signalColor })} />
        )}
        {indicator.kind === "macd" && (
          <>
            <ColorField label={shellText(locale, "signal")} value={indicator.signalColor} onChange={(signalColor) => onUpdate({ signalColor })} />
            <ColorField label={shellText(locale, "histogramUp")} value={indicator.histogramUp} onChange={(histogramUp) => onUpdate({ histogramUp })} />
            <ColorField label={shellText(locale, "histogramDown")} value={indicator.histogramDown} onChange={(histogramDown) => onUpdate({ histogramDown })} />
          </>
        )}
      </div>
      <div className="indicator-logic">
        <div>
          <span>
            <Code2 size={13} aria-hidden="true" />
            {shellText(locale, "logic")}
          </span>
          <button type="button" onClick={onEditLogic}>
            <Workflow size={13} aria-hidden="true" />
            {shellText(locale, "edit")}
          </button>
        </div>
        <pre>{indicatorLogicPreview(indicator)}</pre>
      </div>
    </div>
  );
}

function isOscillator(indicator: IndicatorConfig) {
  return indicator.kind === "rsi" || indicator.kind === "macd" || indicator.kind === "stochastic" || indicator.kind === "atr" || indicator.kind === "obv";
}

function MacdFields({
  locale,
  indicator,
  onUpdate
}: {
  locale: Locale;
  indicator: MacdConfig;
  onUpdate: (patch: Partial<IndicatorConfig>) => void;
}) {
  return (
    <>
      <NumberField label={shellText(locale, "fast")} value={indicator.fast} min={2} max={100} onChange={(fast) => onUpdate({ fast })} />
      <NumberField label={shellText(locale, "slow")} value={indicator.slow} min={3} max={160} onChange={(slow) => onUpdate({ slow })} />
      <NumberField label={shellText(locale, "signal")} value={indicator.signal} min={2} max={80} onChange={(signal) => onUpdate({ signal })} />
    </>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(clamp(Number(event.target.value), min, max))} />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function hasPeriod(indicator: IndicatorConfig): indicator is PeriodIndicatorConfig | BollingerConfig | StochasticConfig {
  return "period" in indicator;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
