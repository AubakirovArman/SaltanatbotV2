import { GitCompareArrows, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { CompareChartType, CompareLegendSnapshot, CompareOverlayConfig } from "../chart/types";
import type { ChartType, Timeframe } from "../types";
import { chartTypeLabel } from "./chartTypePresentation";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";

export interface CompareCandidate {
  symbol: string;
  displayName: string;
}

interface CompareControlProps {
  locale: Locale;
  candidates: CompareCandidate[];
  /** Configured compare overlays (max reached disables the picker). */
  active: CompareOverlayConfig[];
  max: number;
  timeframes: Timeframe[];
  chartTypes: ChartType[];
  /** Live legend (symbol · %change · color) emitted by the chart renderer. */
  legend: CompareLegendSnapshot[];
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  onAdd: (symbol: string) => void;
  onUpdate: (id: string, patch: Partial<CompareOverlayConfig>) => void;
  onRemove: (id: string) => void;
}

export function CompareControl({ locale, candidates, active, max, timeframes, chartTypes, legend, loading, errors, onAdd, onUpdate, onRemove }: CompareControlProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [query, setQuery] = useState("");
  const [optionIndex, setOptionIndex] = useState(0);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const atMax = active.length >= max;
  const legendById = useMemo(() => new Map(legend.filter((entry) => !entry.base).map((entry) => [entry.id, entry])), [legend]);
  const compareChartTypes = useMemo(() => chartTypes.filter(isCompareChartType), [chartTypes]);
  const options = useMemo(() => {
    const taken = new Set(active.map((entry) => entry.symbol));
    const needle = query.trim().toUpperCase();
    return candidates
      .filter((item) => !taken.has(item.symbol))
      .map((item, index) => ({ item, index, score: scoreCandidate(item, needle) }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => a.score! - b.score! || a.index - b.index)
      .slice(0, 60)
      .map((entry) => entry.item);
  }, [candidates, active, query]);

  const editing = active.find((entry) => entry.id === editingId);
  const editingCandleLike = editing ? isCandleLike(editing.chartType) : false;
  const currentOptionIndex = options.length > 0 ? Math.min(optionIndex, options.length - 1) : 0;

  const closePicker = () => {
    setOpen(false);
    setQuery("");
    addButtonRef.current?.focus();
  };

  const choose = (symbol: string) => {
    onAdd(symbol);
    setEditingId(symbol);
    setOpen(false);
    setQuery("");
  };

  const focusOption = (index: number) => {
    if (options.length === 0) return;
    const next = Math.max(0, Math.min(options.length - 1, index));
    setOptionIndex(next);
    optionRefs.current[next]?.focus();
  };

  return (
    <div className="compare-control">
      <div className="compare-strip">
        <button
          ref={addButtonRef}
          type="button"
          className="compare-add"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listboxId : undefined}
          disabled={atMax}
          title={atMax ? `${t("compareMaximum")} ${max}` : t("compareAnother")}
          onClick={() => {
            setOptionIndex(0);
            setOpen((value) => !value);
          }}
        >
          <GitCompareArrows size={13} aria-hidden="true" />
          {t("compare")}
          <Plus size={12} aria-hidden="true" />
        </button>

        {active.map((entry) => {
          const live = legendById.get(entry.id);
          const status = loading[entry.id] ? t("loading") : errors[entry.id] ? t("noData") : formatPct(live?.pct);
          return (
            <div key={entry.id} className="compare-chip">
              <span className="compare-dot" style={dotStyle(entry)} />
              <span className="compare-chip-main">
                <strong>{entry.symbol}</strong>
                <em>
                  {entry.timeframe} · {typeLabel(locale, entry.chartType)}
                </em>
              </span>
              <small className={pctClass(live?.pct)}>{status}</small>
              <button type="button" aria-label={`${t("configure")} ${entry.symbol}`} title={t("configureCompare")} onClick={() => setEditingId((current) => (current === entry.id ? undefined : entry.id))}>
                <SlidersHorizontal size={12} aria-hidden="true" />
              </button>
              <button type="button" aria-label={`${t("stopComparing")} ${entry.symbol}`} onClick={() => onRemove(entry.id)}>
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {open && (
        <div
          className="compare-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closePicker();
            }
          }}
        >
          <label className="compare-search">
            <Search size={13} aria-hidden="true" />
            <span className="sr-only">{t("searchCompare")}</span>
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-activedescendant={options[currentOptionIndex] ? `${listboxId}-option-${currentOptionIndex}` : undefined}
              value={query}
              placeholder={t("searchSymbol")}
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setOptionIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusOption(0);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(options.length - 1);
                } else if (event.key === "Enter" && options[currentOptionIndex]) {
                  event.preventDefault();
                  choose(options[currentOptionIndex].symbol);
                }
              }}
            />
          </label>
          <div id={listboxId} className="compare-menu-list" role="listbox" aria-label={t("compareSymbols")}>
            {options.map((item, index) => (
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                key={item.symbol}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={index === currentOptionIndex}
                tabIndex={index === currentOptionIndex ? 0 : -1}
                onFocus={() => setOptionIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    focusOption(index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    if (index === 0) {
                      setOptionIndex(0);
                      searchRef.current?.focus();
                    } else {
                      focusOption(index - 1);
                    }
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    focusOption(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    focusOption(options.length - 1);
                  }
                }}
                onClick={() => choose(item.symbol)}
              >
                <strong>{item.symbol}</strong>
                <small>{item.displayName}</small>
              </button>
            ))}
          </div>
          {options.length === 0 && (
            <p className="compare-menu-empty" role="status">
              {t("noCompareSymbols")}
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="compare-settings" role="group" aria-label={`${editing.symbol} ${t("compareSettings")}`}>
          <header>
            <span className="compare-dot" style={dotStyle(editing)} />
            <strong>{editing.symbol}</strong>
            <button type="button" aria-label={t("closeCompare")} onClick={() => setEditingId(undefined)}>
              <X size={12} aria-hidden="true" />
            </button>
          </header>
          <label>
            <span>{t("timeframe")}</span>
            <select value={editing.timeframe} onChange={(event) => onUpdate(editing.id, { timeframe: event.target.value as Timeframe })}>
              {timeframes.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("type")}</span>
            <select value={editing.chartType} onChange={(event) => onUpdate(editing.id, { chartType: event.target.value as CompareChartType })}>
              {compareChartTypes.map((item) => (
                <option key={item} value={item}>
                  {typeLabel(locale, item)}
                </option>
              ))}
            </select>
          </label>
          {editingCandleLike ? (
            <>
              <label>
                <span>{t("up")}</span>
                <input type="color" value={editing.upColor} onChange={(event) => onUpdate(editing.id, { upColor: event.target.value })} />
              </label>
              <label>
                <span>{t("down")}</span>
                <input type="color" value={editing.downColor} onChange={(event) => onUpdate(editing.id, { downColor: event.target.value })} />
              </label>
            </>
          ) : (
            <label>
              <span>{t("line")}</span>
              <input type="color" value={editing.color} onChange={(event) => onUpdate(editing.id, { color: event.target.value })} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function isCompareChartType(value: ChartType): value is CompareChartType {
  return value !== "renko" && value !== "linebreak" && value !== "kagi" && value !== "pnf";
}

function isCandleLike(type: CompareChartType) {
  return type === "candles" || type === "hollow" || type === "heikin" || type === "bars";
}

function dotStyle(entry: CompareOverlayConfig) {
  if (!isCandleLike(entry.chartType)) return { background: entry.color };
  return { background: `linear-gradient(135deg, ${entry.upColor} 0 50%, ${entry.downColor} 50% 100%)` };
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

function typeLabel(locale: Locale, type: CompareChartType) {
  return chartTypeLabel(locale, type);
}

function formatPct(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function pctClass(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return "";
  return pct >= 0 ? "up" : "down";
}
