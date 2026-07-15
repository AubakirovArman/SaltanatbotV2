import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Locale } from "../i18n";
import { deleteScannerPreset, findScannerPreset, loadScannerWorkspace, saveScannerPreset, storeScannerWorkspace, type ScannerFilterValue, type ScannerMode, type ScannerVisualization, type ScannerWorkspacePreferences } from "./scannerPrefs";
import { scannerUxText } from "./scannerUxText";

export interface ScannerColumn {
  id: string;
  label: string;
  required?: boolean;
}

export interface ScannerVisualMetric {
  key: "primary" | "secondary" | "capacity" | "freshness";
  label: string;
  value: number;
  formatted: string;
}

export interface ScannerVisualNode {
  label: string;
  detail?: string;
}

export interface ScannerVisualRow {
  id: string;
  label: string;
  subtitle: string;
  heatValue: number;
  metrics: ScannerVisualMetric[];
  nodes: ScannerVisualNode[];
}

interface Props {
  mode: ScannerMode;
  storageOwner?: string;
  locale: Locale;
  filters: Record<string, ScannerFilterValue>;
  columns: readonly ScannerColumn[];
  defaultColumns: readonly string[];
  rows: readonly ScannerVisualRow[];
  onApplyFilters(filters: Record<string, ScannerFilterValue>): void;
  children(state: { visibleColumns: ReadonlySet<string>; visualization: ScannerVisualization }): ReactNode;
  statusSlot?: ReactNode;
}

export function ScannerWorkbench({ mode, storageOwner, locale, filters, columns, defaultColumns, rows, onApplyFilters, children, statusSlot }: Props) {
  const allowedColumns = useMemo(() => columns.map((column) => column.id), [columns]);
  const requiredColumns = useMemo(() => columns.filter((column) => column.required).map((column) => column.id), [columns]);
  const [preferences, setPreferences] = useState(() => loadScannerWorkspace(mode, allowedColumns, defaultColumns, requiredColumns, undefined, storageOwner));
  const [presetName, setPresetName] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const controlId = useId();
  const bufferedRows = useVisibleRows(rows);

  useEffect(() => {
    setPreferences(loadScannerWorkspace(mode, allowedColumns, defaultColumns, requiredColumns, undefined, storageOwner));
    setPresetName("");
  }, [allowedColumns, defaultColumns, mode, requiredColumns, storageOwner]);

  const persist = (next: ScannerWorkspacePreferences) => {
    setPreferences(storeScannerWorkspace(mode, next, allowedColumns, defaultColumns, requiredColumns, undefined, storageOwner));
  };
  const setVisualization = (visualization: ScannerVisualization) => persist({ ...preferences, visualization });
  const toggleColumn = (column: ScannerColumn) => {
    if (column.required) return;
    const selected = new Set(preferences.columns);
    if (selected.has(column.id)) selected.delete(column.id);
    else selected.add(column.id);
    persist({ ...preferences, columns: allowedColumns.filter((id) => selected.has(id) || requiredColumns.includes(id)) });
  };
  const applyPreset = (presetId: string) => {
    const preset = findScannerPreset(preferences, presetId);
    if (!preset) {
      persist({ ...preferences, selectedPresetId: "" });
      return;
    }
    persist({
      ...preferences,
      selectedPresetId: preset.id,
      columns: preset.columns,
      visualization: preset.visualization,
      compareIds: preset.compareIds
    });
    onApplyFilters(preset.filters);
  };
  const savePreset = () => {
    const next = saveScannerPreset(preferences, presetName, filters);
    if (next === preferences) return;
    persist(next);
    setPresetName("");
    setAnnouncement(scannerUxText(locale, "presetSaved"));
  };
  const deletePreset = () => {
    if (!preferences.selectedPresetId) return;
    persist(deleteScannerPreset(preferences, preferences.selectedPresetId));
    setAnnouncement(scannerUxText(locale, "presetDeleted"));
  };
  const resetLayout = () => {
    persist({ ...preferences, columns: [...new Set([...requiredColumns, ...defaultColumns])], visualization: "table", compareIds: ["", ""], selectedPresetId: "" });
  };
  const setCompareId = (index: 0 | 1, id: string) => {
    const compareIds: [string, string] = [...preferences.compareIds];
    compareIds[index] = id;
    if (compareIds[0] === compareIds[1]) compareIds[index === 0 ? 1 : 0] = "";
    persist({ ...preferences, compareIds });
  };
  const visibleColumns = useMemo(() => new Set(preferences.columns), [preferences.columns]);

  return (
    <section className="arb-workbench" aria-labelledby={`${controlId}-title`}>
      <header className="arb-workbench-header">
        <div>
          <h2 id={`${controlId}-title`}>{scannerUxText(locale, "workspace")}</h2>
          <p>{scannerUxText(locale, "workspaceHint")}</p>
        </div>
        {statusSlot}
      </header>
      <div className="arb-workbench-controls">
        <fieldset className="arb-view-options">
          <legend>{scannerUxText(locale, "view")}</legend>
          <div role="group" aria-label={scannerUxText(locale, "view")}>
            {(["table", "heatmap", "compare"] as const).map((view) => (
              <button key={view} type="button" aria-pressed={preferences.visualization === view} onClick={() => setVisualization(view)}>
                {scannerUxText(locale, view === "table" ? "tableView" : view === "heatmap" ? "heatmapView" : "compareView")}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="arb-column-options">
          <legend>{scannerUxText(locale, "columns")}</legend>
          <div>
            {columns.map((column) => (
              <label key={column.id}>
                <input type="checkbox" checked={visibleColumns.has(column.id)} disabled={column.required} onChange={() => toggleColumn(column)} />
                <span>
                  {column.label}
                  {column.required ? <small> · {scannerUxText(locale, "requiredColumn")}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="arb-preset-controls">
          <label htmlFor={`${controlId}-preset-name`}>{scannerUxText(locale, "presetName")}</label>
          <div>
            <input id={`${controlId}-preset-name`} value={presetName} maxLength={40} placeholder={scannerUxText(locale, "presetNamePlaceholder")} onChange={(event) => setPresetName(event.target.value)} />
            <button type="button" disabled={!presetName.trim()} onClick={savePreset}>
              {scannerUxText(locale, "savePreset")}
            </button>
          </div>
          <label htmlFor={`${controlId}-saved-preset`}>{scannerUxText(locale, "savedPresets")}</label>
          <div>
            <select id={`${controlId}-saved-preset`} value={preferences.selectedPresetId} onChange={(event) => applyPreset(event.target.value)}>
              <option value="">{scannerUxText(locale, "choosePreset")}</option>
              {preferences.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={!preferences.selectedPresetId} onClick={deletePreset}>
              {scannerUxText(locale, "deletePreset")}
            </button>
            <button type="button" onClick={resetLayout}>
              {scannerUxText(locale, "resetLayout")}
            </button>
          </div>
          <small>{scannerUxText(locale, "presetLimit")}</small>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {preferences.visualization === "table" ? (
        children({ visibleColumns, visualization: preferences.visualization })
      ) : preferences.visualization === "heatmap" ? (
        <OpportunityHeatmap locale={locale} rows={bufferedRows} />
      ) : (
        <RouteComparison locale={locale} rows={bufferedRows} compareIds={preferences.compareIds} onCompareId={setCompareId} />
      )}
    </section>
  );
}

function OpportunityHeatmap({ locale, rows }: { locale: Locale; rows: readonly ScannerVisualRow[] }) {
  const visible = rows.slice(0, 12);
  const values = visible.map((row) => row.heatValue).filter(Number.isFinite);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 0;
  return (
    <figure className="arb-opportunity-heatmap" aria-labelledby="arb-heatmap-title">
      <figcaption>
        <strong id="arb-heatmap-title">{scannerUxText(locale, "heatmapTitle")}</strong>
        <span>{scannerUxText(locale, "heatmapHint")}</span>
      </figcaption>
      {visible.length === 0 ? (
        <p>{scannerUxText(locale, "noCandidates")}</p>
      ) : (
        <ol>
          {visible.map((row, index) => {
            const intensity = maximum === minimum ? 0.55 : (row.heatValue - minimum) / (maximum - minimum);
            const primary = row.metrics.find((metric) => metric.key === "primary");
            return (
              <li key={row.id} style={{ "--arb-heat": intensity.toFixed(3) } as CSSProperties}>
                <span>{scannerUxText(locale, "rank", { rank: String(index + 1) })}</span>
                <strong>{row.label}</strong>
                <small>{row.subtitle}</small>
                <b>{primary?.formatted ?? "—"}</b>
              </li>
            );
          })}
        </ol>
      )}
    </figure>
  );
}

function RouteComparison({ locale, rows, compareIds, onCompareId }: { locale: Locale; rows: readonly ScannerVisualRow[]; compareIds: [string, string]; onCompareId(index: 0 | 1, id: string): void }) {
  const first = rows.find((row) => row.id === compareIds[0]) ?? rows[0];
  const second = rows.find((row) => row.id === compareIds[1] && row.id !== first?.id) ?? rows.find((row) => row.id !== first?.id);
  return (
    <section className="arb-route-compare" aria-labelledby="arb-route-compare-title">
      <header>
        <strong id="arb-route-compare-title">{scannerUxText(locale, "compareTitle")}</strong>
        <p>{scannerUxText(locale, "compareHint")}</p>
      </header>
      {first ? (
        <>
          <div className="arb-compare-selectors">
            <CandidateSelect locale={locale} label="candidateA" value={first.id} rows={rows} excludedId={second?.id} onChange={(id) => onCompareId(0, id)} />
            <CandidateSelect locale={locale} label="candidateB" value={second?.id ?? ""} rows={rows} excludedId={first.id} onChange={(id) => onCompareId(1, id)} />
          </div>
          <RouteGraph locale={locale} row={first} />
          <ComparisonTable locale={locale} first={first} second={second} />
        </>
      ) : (
        <p>{scannerUxText(locale, "noCandidates")}</p>
      )}
    </section>
  );
}

function CandidateSelect({ locale, label, value, rows, excludedId, onChange }: { locale: Locale; label: "candidateA" | "candidateB"; value: string; rows: readonly ScannerVisualRow[]; excludedId?: string; onChange(id: string): void }) {
  const id = useId();
  return (
    <label htmlFor={id}>
      {scannerUxText(locale, label)}
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{scannerUxText(locale, "chooseCandidate")}</option>
        {rows
          .filter((row) => row.id !== excludedId)
          .slice(0, 50)
          .map((row) => (
            <option key={row.id} value={row.id}>
              {row.label} · {row.subtitle}
            </option>
          ))}
      </select>
    </label>
  );
}

function RouteGraph({ locale, row }: { locale: Locale; row: ScannerVisualRow }) {
  const titleId = useId();
  const nodes = row.nodes.slice(0, 6);
  const positions = nodes.map((_, index) => (nodes.length === 1 ? 360 : 60 + (index * 600) / (nodes.length - 1)));
  return (
    <figure className="arb-route-graph">
      <svg viewBox="0 0 720 150" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{scannerUxText(locale, "graphTitle", { route: row.label })}</title>
        {positions.slice(0, -1).map((x, index) => (
          <line key={`${row.id}-line-${index}`} x1={x + 28} y1="62" x2={positions[index + 1] - 28} y2="62" />
        ))}
        {nodes.map((node, index) => (
          <g key={`${row.id}-node-${index}`} transform={`translate(${positions[index]} 62)`}>
            <circle r="25" />
            <text className="arb-route-node-index" textAnchor="middle" dominantBaseline="central">
              {index + 1}
            </text>
            <text className="arb-route-node-label" x="0" y="45" textAnchor="middle">
              {shortLabel(node.label)}
            </text>
            {node.detail ? (
              <text className="arb-route-node-detail" x="0" y="60" textAnchor="middle">
                {shortLabel(node.detail)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption>{scannerUxText(locale, "graphCaption")}</figcaption>
      <ol className="sr-only">
        {nodes.map((node, index) => (
          <li key={`${row.id}-alternative-${index}`}>
            {node.label}
            {node.detail ? `: ${node.detail}` : ""}
          </li>
        ))}
      </ol>
    </figure>
  );
}

function ComparisonTable({ locale, first, second }: { locale: Locale; first: ScannerVisualRow; second?: ScannerVisualRow }) {
  const keys: ScannerVisualMetric["key"][] = ["primary", "secondary", "capacity", "freshness"];
  return (
    <div className="arb-compare-table-shell">
      <table className="arb-compare-table">
        <caption>{scannerUxText(locale, "compareCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{scannerUxText(locale, "metric")}</th>
            <th scope="col">{first.label}</th>
            <th scope="col">{second?.label ?? scannerUxText(locale, "candidateB")}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const firstMetric = first.metrics.find((metric) => metric.key === key);
            const secondMetric = second?.metrics.find((metric) => metric.key === key);
            return (
              <tr key={key}>
                <th scope="row">{firstMetric?.label ?? secondMetric?.label ?? scannerUxText(locale, `${key}Metric`)}</th>
                <td>{firstMetric?.formatted ?? "—"}</td>
                <td>{secondMetric?.formatted ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function useVisibleRows(rows: readonly ScannerVisualRow[]): readonly ScannerVisualRow[] {
  const latest = useRef(rows);
  latest.current = rows;
  const [visibleRows, setVisibleRows] = useState(rows);
  useEffect(() => {
    if (typeof document === "undefined" || document.visibilityState === "visible") setVisibleRows(rows);
  }, [rows]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") setVisibleRows(latest.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return visibleRows;
}

function shortLabel(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 14)}…`;
}
