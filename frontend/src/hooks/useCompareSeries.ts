import { useEffect, useRef, useState } from "react";
import { getCandles } from "../api/marketClient";
import type { CompareOverlayConfig } from "../chart/types";
import type { Candle, DataExchange } from "../types";

/** Bars fetched per compare symbol — kept light since these are overlay-only. */
const COMPARE_LIMIT = 500;
const COMPARE_REFRESH_MS = 15_000;

/**
 * Fetches candles for configured compare overlays on their own timeframe
 * and exchange, returning `{ [overlayId]: Candle[] }`. Each overlay is fetched
 * independently and failures are ignored per-symbol so one bad symbol never
 * blanks the others. The hook also refreshes on a light timer so compare layers
 * keep moving without opening extra exchange streams for every overlay.
 */
export interface CompareSeriesState {
  series: Record<string, Candle[]>;
  loading: Record<string, boolean>;
  errors: Record<string, string | undefined>;
}

export function useCompareSeries(
  overlays: CompareOverlayConfig[],
  exchange: DataExchange = "binance"
): CompareSeriesState {
  const [series, setSeries] = useState<Record<string, Candle[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const key = overlays.map((overlay) => `${overlay.id}:${overlay.symbol}:${overlay.timeframe}`).join(",");
  // Keep already-fetched series around so re-adding a symbol is instant and so
  // an in-flight refetch doesn't flash empty overlays.
  const cacheRef = useRef<Record<string, { requestKey: string; candles: Candle[] }>>({});

  useEffect(() => {
    const list = overlays;
    if (list.length === 0) {
      cacheRef.current = {};
      setSeries({});
      setLoading({});
      setErrors({});
      return;
    }
    let alive = true;

    // Drop cached entries for overlays no longer requested.
    const pruned: Record<string, Candle[]> = {};
    const nextCache: typeof cacheRef.current = {};
    const nextLoading: Record<string, boolean> = {};
    const nextErrors: Record<string, string | undefined> = {};
    for (const overlay of list) {
      const requestKey = cacheKey(overlay, exchange);
      const cached = cacheRef.current[overlay.id];
      if (cached?.requestKey === requestKey) {
        pruned[overlay.id] = cached.candles;
        nextCache[overlay.id] = cached;
        nextLoading[overlay.id] = false;
      } else {
        nextLoading[overlay.id] = true;
      }
    }
    cacheRef.current = nextCache;
    setSeries({ ...pruned });
    setLoading(nextLoading);
    setErrors(nextErrors);

    const fetchOverlay = (overlay: CompareOverlayConfig, silent: boolean) => {
      const requestKey = cacheKey(overlay, exchange);
      if (!silent && cacheRef.current[overlay.id]?.requestKey === requestKey) return;
      getCandles(overlay.symbol, overlay.timeframe, COMPARE_LIMIT, undefined, exchange)
        .then((payload) => {
          if (!alive) return;
          cacheRef.current = { ...cacheRef.current, [overlay.id]: { requestKey, candles: payload.candles } };
          setSeries((current) => ({ ...current, [overlay.id]: payload.candles }));
          setLoading((current) => ({ ...current, [overlay.id]: false }));
          setErrors((current) => ({ ...current, [overlay.id]: undefined }));
        })
        .catch((cause) => {
          if (!alive) return;
          // Ignore per-symbol failures for the chart, but expose status in the UI.
          setLoading((current) => ({ ...current, [overlay.id]: false }));
          setErrors((current) => ({
            ...current,
            [overlay.id]: cause instanceof Error ? cause.message : "Failed to load"
          }));
        });
    };

    for (const overlay of list) fetchOverlay(overlay, false);
    const refreshId = window.setInterval(() => {
      for (const overlay of list) fetchOverlay(overlay, true);
    }, COMPARE_REFRESH_MS);

    return () => {
      alive = false;
      window.clearInterval(refreshId);
    };
  }, [key, overlays, exchange]);

  return { series, loading, errors };
}

function cacheKey(overlay: CompareOverlayConfig, exchange: DataExchange) {
  return `${exchange}:${overlay.symbol}:${overlay.timeframe}`;
}
