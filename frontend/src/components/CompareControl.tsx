import { GitCompareArrows, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { CompareLegendSnapshot } from "../chart/types";

export interface CompareCandidate {
  symbol: string;
  displayName: string;
}

interface CompareControlProps {
  candidates: CompareCandidate[];
  /** Symbols currently being compared (max reached disables the picker). */
  active: string[];
  max: number;
  /** Live legend (symbol · %change · color) emitted by the chart renderer. */
  legend: CompareLegendSnapshot[];
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

/**
 * "Compare +" affordance for the chart toolbar: pick another symbol from the
 * catalog to overlay (normalized to % change) and remove one via the legend ✕.
 * Styling mirrors the indicator strip/menu so it stays visually consistent.
 */
export function CompareControl({ candidates, active, max, legend, onAdd, onRemove }: CompareControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const atMax = active.length >= max;
  const options = useMemo(() => {
    const taken = new Set(active);
    const needle = query.trim().toUpperCase();
    return candidates
      .filter((item) => !taken.has(item.symbol))
      .filter(
        (item) =>
          needle === "" ||
          item.symbol.toUpperCase().includes(needle) ||
          item.displayName.toUpperCase().includes(needle)
      )
      .slice(0, 60);
  }, [candidates, active, query]);

  // The renderer emits base first; compare rows follow (those we can remove).
  const compareRows = legend.filter((entry) => !entry.base);

  return (
    <div className="compare-control">
      <div className="compare-strip">
        <button
          type="button"
          className="compare-add"
          aria-expanded={open}
          aria-haspopup="menu"
          disabled={atMax}
          title={atMax ? `Comparing the maximum of ${max} symbols` : "Compare another symbol"}
          onClick={() => setOpen((value) => !value)}
        >
          <GitCompareArrows size={13} aria-hidden="true" />
          Compare
          <Plus size={12} aria-hidden="true" />
        </button>

        {compareRows.map((entry) => (
          <div key={entry.symbol} className="compare-chip">
            <span className="compare-dot" style={{ background: entry.color }} />
            <strong>{entry.symbol}</strong>
            <small className={pctClass(entry.pct)}>{formatPct(entry.pct)}</small>
            <button type="button" aria-label={`Stop comparing ${entry.symbol}`} onClick={() => onRemove(entry.symbol)}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>

      {open && (
        <div className="compare-menu" role="menu">
          <label className="compare-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="text"
              value={query}
              placeholder="Search symbol"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="compare-menu-list">
            {options.map((item) => (
              <button
                type="button"
                key={item.symbol}
                role="menuitem"
                onClick={() => {
                  onAdd(item.symbol);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <strong>{item.symbol}</strong>
                <small>{item.displayName}</small>
              </button>
            ))}
            {options.length === 0 && <p>No symbols to compare</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function formatPct(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function pctClass(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "";
  return pct >= 0 ? "up" : "down";
}
