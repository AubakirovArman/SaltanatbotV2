import { ArrowDownUp, ArrowDownWideNarrow, ArrowUpNarrowWide, Search, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SparklineSeries } from "../api/marketClient";
import { loadFavorites, storeFavorites } from "../market/favorites";
import { loadWatchlistSort, storeWatchlistSort, type WatchlistSort } from "../market/watchlistPrefs";
import type { AssetClass, Candle, DataExchange, Instrument } from "../types";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";

interface WatchlistProps {
  locale: Locale;
  instruments: Instrument[];
  selectedSymbol: string;
  selectedAsset: AssetClass | "all";
  latest?: Candle;
  sparklines?: Record<string, SparklineSeries>;
  cryptoExchange: DataExchange;
  onSelectSymbol: (symbol: string) => void;
  onSelectAsset: (asset: AssetClass | "all") => void;
  onSelectExchange: (exchange: DataExchange) => void;
}

const assets: Array<AssetClass | "all"> = ["all", "crypto", "forex", "stock", "index"];
const exchanges: Array<{ id: DataExchange; label: string }> = [
  { id: "binance", label: "Binance" },
  { id: "bybit", label: "Bybit" }
];

// Sort cycles: A→Z, then % desc (top gainers), then % asc (top losers).
const sortCycle: WatchlistSort[] = ["symbol", "change-desc", "change-asc"];
const sortMeta: Record<WatchlistSort, { labelKey: "sortHighLow" | "sortLowHigh" | undefined; Icon: typeof ArrowDownUp }> = {
  symbol: { labelKey: undefined, Icon: ArrowDownUp },
  "change-desc": { labelKey: "sortHighLow", Icon: ArrowDownWideNarrow },
  "change-asc": { labelKey: "sortLowHigh", Icon: ArrowUpNarrowWide }
};

export function Watchlist({
  locale,
  instruments,
  selectedSymbol,
  selectedAsset,
  latest,
  sparklines,
  cryptoExchange,
  onSelectSymbol,
  onSelectAsset,
  onSelectExchange
}: WatchlistProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [sort, setSort] = useState<WatchlistSort>(() => loadWatchlistSort());
  const sortLabel = sortMeta[sort].labelKey ? t(sortMeta[sort].labelKey) : "A → Z";
  const showExchange = useMemo(
    () => instruments.some((instrument) => instrument.assetClass === "crypto"),
    [instruments]
  );

  useEffect(() => {
    storeFavorites(favorites);
  }, [favorites]);
  useEffect(() => {
    storeWatchlistSort(sort);
  }, [sort]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const toggleFavorite = useCallback((symbol: string) => {
    setFavorites((current) =>
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]
    );
  }, []);
  const cycleSort = useCallback(() => {
    setSort((current) => sortCycle[(sortCycle.indexOf(current) + 1) % sortCycle.length]);
  }, []);

  const changeFor = useCallback(
    (instrument: Instrument) => {
      const active = instrument.symbol === selectedSymbol;
      if (active && latest) return ((latest.close - latest.open) / latest.open) * 100;
      return sparklines?.[instrument.symbol]?.changePct;
    },
    [latest, selectedSymbol, sparklines]
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = !normalized
      ? instruments
      : instruments.filter((instrument) =>
          [
            instrument.symbol,
            instrument.displayName,
            instrument.exchange,
            instrument.assetClass,
            instrument.currency
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalized)
        );

    // Pinned symbols always float to the top; the chosen sort orders within each group.
    const compare = (a: Instrument, b: Instrument) => {
      const aFav = favoriteSet.has(a.symbol);
      const bFav = favoriteSet.has(b.symbol);
      if (aFav !== bFav) return aFav ? -1 : 1;
      if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
      // Missing % (no sparkline yet) sinks to the bottom of its group.
      const aChange = changeFor(a);
      const bChange = changeFor(b);
      if (aChange === undefined && bChange === undefined) return a.symbol.localeCompare(b.symbol);
      if (aChange === undefined) return 1;
      if (bChange === undefined) return -1;
      return sort === "change-desc" ? bChange - aChange : aChange - bChange;
    };
    return [...matches].sort(compare);
  }, [instruments, query, favoriteSet, sort, changeFor]);

  return (
    <aside className="watchlist">
      <div className="panel-header">
        <strong>{t("markets")}</strong>
        <div className="panel-header-meta">
          <span>{filtered.length} {t("symbols")}</span>
          <button
            type="button"
            className="watchlist-sort"
            onClick={cycleSort}
            title={`${t("sort")}: ${sortLabel}`}
            aria-label={`${t("changeSort")} ${sortLabel}`}
          >
            {(() => {
              const { Icon } = sortMeta[sort];
              return <Icon size={13} strokeWidth={1.75} aria-hidden="true" />;
            })()}
          </button>
        </div>
      </div>

      <label className="market-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">{t("searchInstruments")}</span>
        <input
          value={query}
          placeholder={t("searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="asset-tabs">
        {assets.map((asset) => (
          <button
            type="button"
            key={asset}
            className={asset === selectedAsset ? "active" : ""}
            onClick={() => onSelectAsset(asset)}
            aria-pressed={asset === selectedAsset}
          >
            {t(asset === "all" ? "all" : asset === "stock" ? "stocks" : asset)}
          </button>
        ))}
      </div>

      {showExchange && (
        <div className="exchange-select" role="group" aria-label={t("cryptoSource")}>
          <span className="exchange-select-label">{t("source")}</span>
          <div className="exchange-select-options">
            {exchanges.map((exchange) => (
              <button
                type="button"
                key={exchange.id}
                className={exchange.id === cryptoExchange ? "active" : ""}
                onClick={() => onSelectExchange(exchange.id)}
                aria-pressed={exchange.id === cryptoExchange}
                title={`${t("showPricesFrom")} ${exchange.label}`}
              >
                {exchange.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="symbol-list">
        {filtered.map((instrument) => {
          const active = instrument.symbol === selectedSymbol;
          const spark = sparklines?.[instrument.symbol];
          const price = active && latest ? latest.close : spark?.last ?? instrument.basePrice;
          const change = active && latest ? ((latest.close - latest.open) / latest.open) * 100 : spark?.changePct;
          const pinned = favoriteSet.has(instrument.symbol);
          return (
            <div
              className={`symbol-row ${active ? "active" : ""} ${pinned ? "pinned" : ""}`}
              key={instrument.symbol}
              title={`${instrument.displayName} · ${instrument.exchange}`}
            >
              <button
                type="button"
                className={`symbol-star ${pinned ? "active" : ""}`}
                onClick={() => toggleFavorite(instrument.symbol)}
                aria-pressed={pinned}
                aria-label={`${t(pinned ? "unpin" : "pin")} ${instrument.symbol}`}
                title={pinned ? t("unpin") : t("pinTop")}
              >
                <Star size={13} strokeWidth={1.75} fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="symbol-select"
                onClick={() => onSelectSymbol(instrument.symbol)}
                aria-pressed={active}
              >
                <strong className="symbol-ticker">{instrument.symbol}</strong>
                {spark && spark.points.length > 1 ? (
                  <Sparkline points={spark.points} up={(change ?? 0) >= 0} />
                ) : (
                  <span className="sparkline-empty" aria-hidden="true" />
                )}
                <span className="symbol-quote">
                  <span className="symbol-price num">{price.toFixed(instrument.decimals)}</span>
                  <span className={`symbol-change num ${change !== undefined && change < 0 ? "down" : "up"}`}>
                    {change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="empty-state">
            <strong>{t("noMatches")}</strong>
            <span>{t("noMatchesHint")}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const width = 58;
  const height = 22;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke={up ? "var(--up, #23c97a)" : "var(--down, #ef5350)"} strokeWidth={1.4} />
    </svg>
  );
}
