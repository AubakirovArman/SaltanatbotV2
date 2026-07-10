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
      .map((item, index) => ({ item, index, score: scoreCandidate(item, needle) }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => a.score! - b.score! || a.index - b.index)
      .slice(0, 60)
      .map((entry) => entry.item);
  }, [candidates, active, query]);

  // The renderer emits base first; compare rows follow (those we can remove).
  const compareRows = legend.filter((entry) => !entry.base);

  return (
    <div className="compare-control">
      <div className="compare-strip">
        <button type="button" className="compare-add" aria-expanded={open} aria-haspopup="listbox" disabled={atMax} title={atMax ? `Comparing the maximum of ${max} symbols` : "Compare another symbol"} onClick={() => setOpen((value) => !value)}>
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
        <div className="compare-menu">
          <label className="compare-search">
            <Search size={13} aria-hidden="true" />
            <span className="sr-only">Search symbol to compare</span>
            <input type="text" value={query} placeholder="Search symbol" autoFocus onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="compare-menu-list" role="listbox" aria-label="Compare symbols">
            {options.map((item) => (
              <button
                type="button"
                key={item.symbol}
                role="option"
                aria-selected={false}
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

function scoreCandidate(item: CompareCandidate, needle: string): number | null {
  if (!needle) return 100;
  const symbol = item.symbol.toUpperCase();
  const baseSymbol = symbolBase(symbol);
  const [baseName = "", quoteName = ""] = item.displayName
    .toUpperCase()
    .split("/")
    .map((part) => part.trim());

  if (symbol === needle) return 0;
  if (baseSymbol === needle) return 1;
  if (symbol.startsWith(needle)) return 2;
  if (baseName === needle) return 3;
  if (baseName.startsWith(needle)) return 4;
  if (symbol.includes(needle)) return 5;
  if (baseName.includes(needle)) return 6;
  if (quoteName.startsWith(needle)) return 9;
  return null;
}

function symbolBase(symbol: string): string {
  const suffix = ["USDT", "USDC", "USD", "BTC", "ETH", "EUR", "GBP", "JPY"].find((quote) => symbol.endsWith(quote));
  return suffix ? symbol.slice(0, -suffix.length) : symbol;
}

function formatPct(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function pctClass(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "";
  return pct >= 0 ? "up" : "down";
}
