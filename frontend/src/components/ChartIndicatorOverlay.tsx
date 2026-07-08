import { Code2, Eye, EyeOff, Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { useMemo, useState } from "react";
import { indicatorLogicPreview, indicatorSummary } from "../chart/indicatorLogic";
import type {
  BollingerConfig,
  IndicatorConfig,
  MacdConfig,
  PeriodIndicatorConfig
} from "../chart/indicatorTypes";

export interface StrategyMenuItem {
  id: string;
  name: string;
  description: string;
}

interface ChartIndicatorOverlayProps {
  indicators: IndicatorConfig[];
  onChange: (indicators: IndicatorConfig[]) => void;
  onEditLogic: (indicator: IndicatorConfig) => void;
  strategies?: StrategyMenuItem[];
  activeStrategyId?: string;
  onAddStrategy?: (id: string) => void;
}

export function ChartIndicatorOverlay({ indicators, onChange, onEditLogic, strategies = [], activeStrategyId, onAddStrategy }: ChartIndicatorOverlayProps) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const active = indicators.filter((indicator) => indicator.enabled);
  const available = indicators.filter((indicator) => !indicator.enabled);
  const editing = useMemo(
    () => indicators.find((indicator) => indicator.id === editingId),
    [editingId, indicators]
  );

  const update = (id: string, patch: Partial<IndicatorConfig>) => {
    onChange(indicators.map((indicator) => (
      indicator.id === id ? ({ ...indicator, ...patch } as IndicatorConfig) : indicator
    )));
  };

  const addIndicator = (id: string) => {
    update(id, { enabled: true, visible: true });
    setAdding(false);
    setEditingId(id);
  };

  return (
    <div className="chart-indicator-overlay">
      <div className="indicator-strip">
        <button
          type="button"
          className="indicator-add"
          aria-expanded={adding}
          aria-haspopup="menu"
          onClick={() => setAdding((value) => !value)}
        >
          <Plus size={14} aria-hidden="true" />
          ADD
        </button>

        {active.map((indicator) => (
          <IndicatorChip
            key={indicator.id}
            indicator={indicator}
            editing={indicator.id === editingId}
            onEdit={() => setEditingId(indicator.id === editingId ? undefined : indicator.id)}
            onRemove={() => {
              update(indicator.id, { enabled: false, visible: true });
              if (editingId === indicator.id) setEditingId(undefined);
            }}
            onToggleVisible={() => update(indicator.id, { visible: indicator.visible === false })}
          />
        ))}
      </div>

      {adding && (
        <div className="indicator-menu" role="menu">
          <span className="menu-group-title">Indicators</span>
          {available.map((indicator) => (
            <button type="button" key={indicator.id} role="menuitem" onClick={() => addIndicator(indicator.id)}>
              <span style={{ background: indicator.color }} />
              <strong>{indicator.label}</strong>
              <small>{indicatorSummary(indicator)}</small>
            </button>
          ))}
          {available.length === 0 && <p>All indicators added</p>}

          {onAddStrategy && strategies.length > 0 && (
            <>
              <span className="menu-group-title">Strategies</span>
              {strategies.map((strategy) => (
                <button
                  type="button"
                  key={strategy.id}
                  role="menuitem"
                  className={`menu-strategy ${strategy.id === activeStrategyId ? "active" : ""}`}
                  onClick={() => { onAddStrategy(strategy.id); setAdding(false); }}
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
          indicator={editing}
          onClose={() => setEditingId(undefined)}
          onUpdate={(patch) => update(editing.id, patch)}
          onEditLogic={() => onEditLogic(editing)}
        />
      )}
    </div>
  );
}

function IndicatorChip({
  indicator,
  editing,
  onEdit,
  onRemove,
  onToggleVisible
}: {
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
      <button type="button" aria-label={`${hidden ? "Show" : "Hide"} ${indicator.label}`} onClick={onToggleVisible}>
        {hidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
      </button>
      <button type="button" aria-label={`Edit ${indicator.label}`} onClick={onEdit}>
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Remove ${indicator.label}`} onClick={onRemove}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function IndicatorEditor({
  indicator,
  onClose,
  onUpdate,
  onEditLogic
}: {
  indicator: IndicatorConfig;
  onClose: () => void;
  onUpdate: (patch: Partial<IndicatorConfig>) => void;
  onEditLogic: () => void;
}) {
  return (
    <div className="indicator-editor" role="dialog" aria-label={`${indicator.label} settings`}>
      <div className="indicator-editor-head">
        <strong>{indicator.label}</strong>
        <button type="button" aria-label="Close indicator editor" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="indicator-editor-grid">
        {hasPeriod(indicator) && (
          <NumberField label="Period" value={indicator.period} min={2} max={300} onChange={(period) => onUpdate({ period })} />
        )}
        {indicator.kind === "bollinger" && (
          <NumberField label="Dev" value={indicator.deviation} min={0.5} max={5} step={0.1} onChange={(deviation) => onUpdate({ deviation })} />
        )}
        {indicator.kind === "macd" && <MacdFields indicator={indicator} onUpdate={onUpdate} />}
        <ColorField label="Line" value={indicator.color} onChange={(color) => onUpdate({ color })} />
        {indicator.kind === "bollinger" && (
          <ColorField label="Band" value={indicator.bandColor} onChange={(bandColor) => onUpdate({ bandColor })} />
        )}
        {indicator.kind === "macd" && (
          <>
            <ColorField label="Signal" value={indicator.signalColor} onChange={(signalColor) => onUpdate({ signalColor })} />
            <ColorField label="Hist +" value={indicator.histogramUp} onChange={(histogramUp) => onUpdate({ histogramUp })} />
            <ColorField label="Hist -" value={indicator.histogramDown} onChange={(histogramDown) => onUpdate({ histogramDown })} />
          </>
        )}
      </div>
      <div className="indicator-logic">
        <div>
          <span>
            <Code2 size={13} aria-hidden="true" />
            Logic
          </span>
          <button type="button" onClick={onEditLogic}>
            <Workflow size={13} aria-hidden="true" />
            Edit
          </button>
        </div>
        <pre>{indicatorLogicPreview(indicator)}</pre>
      </div>
    </div>
  );
}

function MacdFields({
  indicator,
  onUpdate
}: {
  indicator: MacdConfig;
  onUpdate: (patch: Partial<IndicatorConfig>) => void;
}) {
  return (
    <>
      <NumberField label="Fast" value={indicator.fast} min={2} max={100} onChange={(fast) => onUpdate({ fast })} />
      <NumberField label="Slow" value={indicator.slow} min={3} max={160} onChange={(slow) => onUpdate({ slow })} />
      <NumberField label="Signal" value={indicator.signal} min={2} max={80} onChange={(signal) => onUpdate({ signal })} />
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

function hasPeriod(indicator: IndicatorConfig): indicator is PeriodIndicatorConfig | BollingerConfig {
  return "period" in indicator;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
