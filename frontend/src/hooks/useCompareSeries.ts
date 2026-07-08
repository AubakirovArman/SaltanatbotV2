import { useEffect, useRef, useState } from "react";
import { getCandles } from "../api/marketClient";
import type { Candle, DataExchange, Timeframe } from "../types";

/** Bars fetched per compare symbol — kept light since these are overlay-only. */
const COMPARE_LIMIT = 500;

/**
 * Fetches candles for a small set of "compare" symbols on the current timeframe
 * and exchange, returning `{ [symbol]: Candle[] }`. Each symbol is fetched
 * independently and failures are ignored per-symbol so one bad symbol never
 * blanks the others. Refetches whenever the symbol set / timeframe / exchange
 * changes. This is snapshot-only (no live stream) — the compare overlay is a
 * relative-performance reference, so a periodic-ish snapshot is sufficient.
 */
export function useCompareSeries(
  symbols: string[],
  timeframe: Timeframe,
  exchange: DataExchange = "binance"
): Record<string, Candle[]> {
  const [series, setSeries] = useState<Record<string, Candle[]>>({});
  const key = symbols.join(",");
  // Keep already-fetched series around so re-adding a symbol is instant and so
  // an in-flight refetch doesn't flash empty overlays.
  const cacheRef = useRef<Record<string, Candle[]>>({});

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (list.length === 0) {
      cacheRef.current = {};
      setSeries({});
      return;
    }
    let alive = true;

    // Drop cached entries for symbols no longer requested.
    const pruned: Record<string, Candle[]> = {};
    for (const sym of list) {
      if (cacheRef.current[sym]) pruned[sym] = cacheRef.current[sym];
    }
    cacheRef.current = pruned;
    setSeries({ ...pruned });

    for (const symbol of list) {
      getCandles(symbol, timeframe, COMPARE_LIMIT, undefined, exchange)
        .then((payload) => {
          if (!alive) return;
          cacheRef.current = { ...cacheRef.current, [symbol]: payload.candles };
          setSeries({ ...cacheRef.current });
        })
        .catch(() => {
          // Ignore per-symbol failures — leave any previously cached data intact.
        });
    }

    return () => {
      alive = false;
    };
    // `key` captures the symbol set; timeframe/exchange force a full refetch.
  }, [key, timeframe, exchange]);

  return series;
}
