import { useEffect, useMemo, useState } from "react";
import { getCandles } from "../../api/marketClient";
import {
  loadRealVolumeProfileCandles,
  normalizeVolumeProfileSource,
  volumeProfileRefreshIntervalMs,
  VolumeProfileSourceError,
  type VisibleTimeRange,
  type VolumeProfileSource,
  type VolumeProfileSourceIssue
} from "../../chart/volumeProfileSource";
import type { Candle, DataExchange, DataMarketType, PriceType, Timeframe } from "../../types";

const STORAGE_KEY = "saltanat.chart.volume-profile-source.v1";
const REQUEST_DEBOUNCE_MS = 180;
const EMPTY_PROFILE_CANDLES: Candle[] = [];

interface LoadState {
  key?: string;
  range?: VisibleTimeRange;
  status: "idle" | "loading" | "ready" | "error";
  candles: Candle[];
  issue?: VolumeProfileSourceIssue;
  detail?: string;
}

export interface VolumeProfileSourceState extends LoadState {
  source: VolumeProfileSource;
  timeframe: Timeframe;
  setSource: (source: VolumeProfileSource) => void;
  /** Undefined deliberately selects the renderer's chart-candle fast path. */
  profileCandles?: Candle[];
}

export function useVolumeProfileSource(options: {
  enabled: boolean;
  symbol: string;
  chartTimeframe: Timeframe;
  visibleRange?: VisibleTimeRange;
  exchange: DataExchange;
  marketType: DataMarketType;
  priceType: PriceType;
}): VolumeProfileSourceState {
  const [source, setSourceState] = useState<VolumeProfileSource>(readSource);
  const [load, setLoad] = useState<LoadState>({ status: "idle", candles: EMPTY_PROFILE_CANDLES });
  const [refreshRevision, setRefreshRevision] = useState(0);
  const timeframe = source === "chart" ? options.chartTimeframe : source;
  const requestKey = useMemo(() => {
    const range = options.visibleRange;
    if (!range || source === "chart") return undefined;
    return [options.exchange, options.marketType, options.priceType, options.symbol, source, range.startTime, range.endTime].join(":");
  }, [options.exchange, options.marketType, options.priceType, options.symbol, options.visibleRange, source]);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, source); } catch { /* Runtime-only setting when storage is unavailable. */ }
  }, [source]);

  useEffect(() => {
    if (!options.enabled || source === "chart" || !options.visibleRange) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshRevision((revision) => (revision + 1) % 1_000_000);
    };
    const timer = window.setInterval(refresh, volumeProfileRefreshIntervalMs(source));
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [options.enabled, options.visibleRange, source]);

  useEffect(() => {
    if (!options.enabled || source === "chart" || !options.visibleRange || !requestKey) return;
    const controller = new AbortController();
    const range = options.visibleRange;
    setLoad((current) => current.key === requestKey && current.candles.length > 0
      ? { ...current, range, status: "loading", issue: undefined, detail: undefined }
      : { key: requestKey, range, status: "loading", candles: EMPTY_PROFILE_CANDLES });
    const timer = window.setTimeout(() => {
      loadRealVolumeProfileCandles({
        timeframe: source,
        range,
        signal: controller.signal,
        fetchPage: async (endTime, limit, signal) => {
          const payload = await getCandles(options.symbol, source, limit, endTime, options.exchange, {
            signal,
            marketType: options.marketType,
            priceType: options.priceType
          });
          return { candles: payload.candles, provider: payload.provider, hasMore: payload.hasMore };
        }
      }).then(
        (candles) => { if (!controller.signal.aborted) setLoad({ key: requestKey, range, status: "ready", candles }); },
        (error: unknown) => {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          setLoad({
            key: requestKey,
            range,
            status: "error",
            candles: EMPTY_PROFILE_CANDLES,
            issue: error instanceof VolumeProfileSourceError ? error.code : "request",
            detail: error instanceof VolumeProfileSourceError ? undefined : error instanceof Error ? error.message : undefined
          });
        }
      );
    }, REQUEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [options.enabled, options.exchange, options.marketType, options.priceType, options.symbol, options.visibleRange, refreshRevision, requestKey, source]);

  const setSource = (next: VolumeProfileSource) => setSourceState(normalizeVolumeProfileSource(next));
  if (!options.enabled || !options.visibleRange) {
    return { source, setSource, timeframe, status: "idle", candles: EMPTY_PROFILE_CANDLES, profileCandles: source === "chart" ? undefined : EMPTY_PROFILE_CANDLES };
  }
  if (source === "chart") {
    return { source, setSource, timeframe, status: "ready", candles: EMPTY_PROFILE_CANDLES, profileCandles: undefined };
  }
  const current = load.key === requestKey ? load : { status: "loading" as const, candles: EMPTY_PROFILE_CANDLES };
  return { ...current, source, setSource, timeframe, profileCandles: current.status === "ready" || (current.status === "loading" && current.candles.length > 0) ? current.candles : EMPTY_PROFILE_CANDLES };
}

function readSource(): VolumeProfileSource {
  if (typeof window === "undefined") return "chart";
  try { return normalizeVolumeProfileSource(window.localStorage.getItem(STORAGE_KEY)); } catch { return "chart"; }
}
