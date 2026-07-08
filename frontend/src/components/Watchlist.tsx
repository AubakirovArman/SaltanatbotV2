import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { SparklineSeries } from "../api/marketClient";
import type { AssetClass, Candle, DataExchange, Instrument } from "../types";

interface WatchlistProps {
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
const assetLabels: Record<AssetClass | "all", string> = {
  all: "All",
  crypto: "Crypto",
  forex: "FX",
  stock: "Stocks",
  index: "Index"
};

const exchanges: Array<{ id: DataExchange; label: string }> = [
  { id: "binance", label: "Binance" },
  { id: "bybit", label: "Bybit" }
];

export function Watchlist({
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
  const [query, setQuery] = useState("");
  const showExchange = useMemo(
    () => instruments.some((instrument) => instrument.assetClass === "crypto"),
    [instruments]
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return instruments;
    return instruments.filter((instrument) =>
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
  }, [instruments, query]);

  return (
    <aside className="watchlist">
      <div className="panel-header">
        <strong>Markets</strong>
        <span>{filtered.length} symbols</span>
      </div>

      <label className="market-search">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Search instruments</span>
        <input
          value={query}
          placeholder="Search BTC, NASDAQ, EUR..."
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
            {assetLabels[asset]}
          </button>
        ))}
      </div>

      {showExchange && (
        <div className="exchange-select" role="group" aria-label="Crypto data source">
          <span className="exchange-select-label">Source</span>
          <div className="exchange-select-options">
            {exchanges.map((exchange) => (
              <button
                type="button"
                key={exchange.id}
                className={exchange.id === cryptoExchange ? "active" : ""}
                onClick={() => onSelectExchange(exchange.id)}
                aria-pressed={exchange.id === cryptoExchange}
                title={`Show crypto prices from ${exchange.label}`}
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
          return (
            <button
              type="button"
              className={`symbol-row ${active ? "active" : ""}`}
              onClick={() => onSelectSymbol(instrument.symbol)}
              key={instrument.symbol}
              title={`${instrument.displayName} · ${instrument.exchange}`}
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
          );
        })}
        {filtered.length === 0 && (
          <div className="empty-state">
            <strong>No matches</strong>
            <span>Try another symbol, venue, or asset class.</span>
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
