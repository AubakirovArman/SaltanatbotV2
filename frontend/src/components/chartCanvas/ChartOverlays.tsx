import { X } from "lucide-react";
import { useState } from "react";
import type { ChartTable } from "../../chart/types";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

export function ChartTablesOverlay({ locale, tables }: { locale: Locale; tables: ChartTable[] }) {
  const [open, setOpen] = useState(true);
  return (
    <aside className={`chart-tables ${open ? "" : "collapsed"}`} aria-label={shellText(locale, "indicatorStatistics")}>
      <button type="button" className="chart-tables-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {shellText(locale, open ? "hideStatistics" : "showStatistics")}
      </button>
      {open &&
        tables.map((table) => (
          <table key={table.id} className="chart-data-table">
            <caption>{table.id}</caption>
            <thead>
              <tr>
                <th scope="col">{shellText(locale, "metric")}</th>
                {table.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {row.values.map((value, index) => (
                    <td key={`${row.label}-${table.columns[index]}`}>{formatTableValue(value)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </aside>
  );
}

export function ArtifactInputPanel({ locale, inputs, onChange, onClose }: { locale: Locale; inputs: { name: string; value: number }[]; onChange: (name: string, value: number) => void; onClose: () => void }) {
  return (
    <aside className="artifact-input-panel" aria-label={shellText(locale, "indicatorInputs")}>
      <header>
        <strong>{shellText(locale, "inputs")}</strong>
        <button type="button" onClick={onClose} aria-label={shellText(locale, "closeInputs")}>
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      <div className="artifact-input-list">
        {inputs.map((input) => {
          const boolean = isBooleanInput(input);
          const options = inputOptions(input.name);
          const id = `artifact-input-${input.name.replace(/[^a-z0-9_-]/gi, "-")}`;
          return (
            <label key={input.name} htmlFor={id}>
              <span>{inputLabel(input.name)}</span>
              {options ? (
                <select id={id} value={input.value} onChange={(event) => onChange(input.name, Number(event.target.value))}>
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : boolean ? (
                <input id={id} type="checkbox" checked={input.value !== 0} onChange={(event) => onChange(input.name, event.target.checked ? 1 : 0)} />
              ) : (
                <input
                  id={id}
                  type="number"
                  value={input.value}
                  step="any"
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isFinite(value)) onChange(input.name, value);
                  }}
                />
              )}
            </label>
          );
        })}
      </div>
    </aside>
  );
}

function isBooleanInput(input: { name: string; value: number }) {
  return (input.value === 0 || input.value === 1) && /^(show|use|calculate|enforce|enable|allow)/i.test(input.name);
}

function inputLabel(name: string) {
  return name
    .replace(/Input$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function inputOptions(name: string) {
  if (name === "cyclesDirectionMode")
    return [
      { value: 0, label: "Percentage" },
      { value: 1, label: "Duration" },
      { value: 2, label: "Both" }
    ];
  if (name === "cyclesDurationUnits")
    return [
      { value: 0, label: "Days" },
      { value: 1, label: "Candles" }
    ];
  if (name === "cyclesMinimumFor")
    return [
      { value: 0, label: "None" },
      { value: 1, label: "Both" },
      { value: 2, label: "Bull" },
      { value: 3, label: "Bear" }
    ];
  if (name === "cyclesFirstDirection")
    return [
      { value: 1, label: "Bull" },
      { value: -1, label: "Bear" }
    ];
  return undefined;
}

function formatTableValue(value: string | number | null) {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
