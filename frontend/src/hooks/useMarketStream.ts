import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMarketSocket, getCandles, parseStreamMessage } from "../api/marketClient";
import type { SharedSocketClient } from "../api/sharedWebSocketPool";
import type { Candle, DataExchange, DataMarketType, PriceType, StreamMessage, Timeframe } from "../types";
import { analyzeCandleGaps } from "../market/dataQuality";
import {
  createCandleSeriesBuffer,
  EMPTY_CANDLE_SERIES,
  mergeCandleSeriesBuffer,
  prependCandleSeriesBuffer
} from "../market/candleSeries";
import { recordBrowserMetric } from "../performance/browserProbe";

export type ConnectionState = "idle" | "connecting" | "connected" | "fallback" | "error";

const MAX_CANDLES = 12_000;
const PROVISIONAL_COMMIT_INTERVAL_MS = 250;
type CandleCopyReason = "snapshot" | "newBar" | "finalization" | "prepend";

function recordCopiedCandleElements(reason: CandleCopyReason, elements: number): void {
  recordBrowserMetric("candle.copiedElements", elements);
  recordBrowserMetric(`candle.copiedElements.${reason}`, elements);
}

interface MarketStreamOptions {
  marketType?: DataMarketType;
  priceType?: PriceType;
  enabled?: boolean;
}

export interface MarketStreamState {
  candles: Candle[];
  connection: ConnectionState;
  provider: string;
  message: string;
  latencyMs?: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadOlder: () => void;
  gapCount: number;
  missingBars: number;
  fallbackActive: boolean;
}

export function useMarketStream(
  symbol: string,
  timeframe: Timeframe,
  exchange: DataExchange = "binance",
  route: MarketStreamOptions = {}
): MarketStreamState {
  const marketType = route.marketType ?? "spot";
  const priceType = route.priceType ?? "last";
  const enabled = route.enabled ?? true;
  const marketKey = `${exchange}:${marketType}:${priceType}:${symbol}:${timeframe}`;
  const [series, setSeries] = useState(EMPTY_CANDLE_SERIES);
  const [dataKey, setDataKey] = useState(marketKey);
  const [connection, setConnection] = useState<ConnectionState>(enabled ? "connecting" : "idle");
  const [provider, setProvider] = useState("Loading");
  const [message, setMessage] = useState(enabled ? "Connecting" : "Market stream paused");
  const [latencyMs, setLatencyMs] = useState<number>();
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const seriesRef = useRef(series);
  const candlesRef = useRef<Candle[]>([]);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const activeSeries = dataKey === marketKey ? series : EMPTY_CANDLE_SERIES;
  const activeCandles = activeSeries.candles;
  const gapSummary = useMemo(() => analyzeCandleGaps(activeSeries.structuralCandles, timeframe), [activeSeries.structuralCandles, timeframe]);
  candlesRef.current = activeCandles;
  seriesRef.current = series;

  useEffect(() => {
    setHasMore(true);
  }, [symbol, timeframe, exchange, marketType, priceType]);

  useEffect(() => {
    interface PendingCandle {
      candle: Candle;
      latencyMs: number;
      provider: string;
    }

    let alive = true;
    let socket: SharedSocketClient | undefined;
    let reconnect: number | undefined;
    let pendingCandle: PendingCandle | undefined;
    let provisionalFlush: number | undefined;
    let lastCandleCommitAt = 0;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let attempts = 0;
    loadingRef.current = false;
    loadAbortRef.current?.abort();
    if (!enabled) {
      setConnection("idle");
      setMessage("Market stream paused");
      setLatencyMs(undefined);
      setLoadingMore(false);
      return () => {
        alive = false;
      };
    }

    const historyAbort = new AbortController();
    setConnection("connecting");
    setProvider("Loading");
    setMessage(`Loading ${symbol} ${timeframe}`);
    setLatencyMs(undefined);
    setLoadingMore(false);

    const cancelProvisionalFlush = () => {
      if (provisionalFlush !== undefined) window.clearTimeout(provisionalFlush);
      provisionalFlush = undefined;
    };

    const commitCandle = ({ candle, latencyMs: nextLatency, provider: nextProvider }: PendingCandle) => {
      cancelProvisionalFlush();
      pendingCandle = undefined;
      setDataKey(marketKey);
      const current = seriesRef.current;
      const merged = mergeCandleSeriesBuffer(current, candle, MAX_CANDLES);
      const provisional = current.tailTime === candle.time
        && current.candles.length > 0
        && merged.structuralCandles === current.structuralCandles;
      seriesRef.current = merged;
      setSeries(merged);
      setLatencyMs(nextLatency);
      setProvider(nextProvider);
      lastCandleCommitAt = Date.now();
      recordBrowserMetric("candle.committed");
      if (provisional) recordBrowserMetric("candle.provisionalTail");
      else {
        const reason: CandleCopyReason = current.tailTime === candle.time ? "finalization" : "newBar";
        recordCopiedCandleElements(reason, merged.structuralCandles.length);
      }
    };

    const flushPendingCandle = () => {
      const pending = pendingCandle;
      if (pending) commitCandle(pending);
      else cancelProvisionalFlush();
    };

    const scheduleCandle = (next: PendingCandle) => {
      const effectiveTailTime = pendingCandle?.candle.time ?? seriesRef.current.tailTime;
      if (effectiveTailTime !== next.candle.time) {
        flushPendingCandle();
        commitCandle(next);
        return;
      }

      const remaining = PROVISIONAL_COMMIT_INTERVAL_MS - (Date.now() - lastCandleCommitAt);
      if (lastCandleCommitAt === 0 || remaining <= 0) {
        commitCandle(next);
        return;
      }

      pendingCandle = next;
      recordBrowserMetric("candle.coalesced");
      if (provisionalFlush === undefined) {
        provisionalFlush = window.setTimeout(flushPendingCandle, remaining);
      }
    };

    const commitSnapshot = (candles: Candle[]) => {
      cancelProvisionalFlush();
      pendingCandle = undefined;
      const snapshot = createCandleSeriesBuffer(candles, MAX_CANDLES);
      seriesRef.current = snapshot;
      setSeries(snapshot);
      lastCandleCommitAt = Date.now();
      recordCopiedCandleElements("snapshot", snapshot.structuralCandles.length);
    };

    const connect = () => {
      setConnection("connecting");
      socket = createMarketSocket(symbol, timeframe, exchange, { marketType, priceType });

      socket.onopen = () => {
        attempts = 0;
        if (alive) {
          setConnection("connected");
          setMessage("WebSocket connected");
        }
      };

      socket.onmessage = (event) => {
        if (!alive || typeof event.data !== "string") return;
        let data: StreamMessage;
        try {
          data = parseStreamMessage(event.data);
        } catch (error) {
          setConnection("error");
          setMessage(error instanceof Error ? `Invalid market message: ${error.message}` : "Invalid market message");
          return;
        }
        recordBrowserMetric("stream.processed");
        const nextLatency = Math.max(0, Date.now() - data.ts);

        if (data.type === "snapshot") {
          setDataKey(marketKey);
          commitSnapshot(data.candles);
          setLatencyMs(nextLatency);
          setProvider(data.provider);
          setMessage(`${data.symbol} ${data.timeframe} snapshot loaded`);
        } else if (data.type === "candle") {
          recordBrowserMetric("candle.received");
          scheduleCandle({ candle: data.candle, latencyMs: nextLatency, provider: data.provider });
        } else if (data.type === "status") {
          setLatencyMs(nextLatency);
          setConnection(data.status === "fallback" ? "fallback" : "connected");
          setProvider(data.provider);
          setMessage(data.message);
        } else if (data.type === "error") {
          setLatencyMs(nextLatency);
          setConnection("error");
          setMessage(data.message);
        }
      };

      socket.onerror = () => {
        if (!alive) return;
        setConnection("error");
        setMessage("WebSocket error");
      };

      socket.onclose = () => {
        if (!alive) return;
        attempts += 1;
        setConnection("error");
        setMessage(`Disconnected. Reconnecting ${attempts}`);
        reconnect = window.setTimeout(connect, Math.min(8000, attempts * 1200));
      };
    };

    getCandles(symbol, timeframe, 1000, undefined, exchange, { signal: historyAbort.signal, marketType, priceType })
      .then((payload) => {
        if (!alive || generationRef.current !== generation) return;
        setDataKey(marketKey);
        commitSnapshot(payload.candles);
        setProvider(payload.provider);
        connect();
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!alive) return;
        setConnection("error");
        setMessage(error instanceof Error ? error.message : "History request failed");
        connect();
      });

    return () => {
      alive = false;
      historyAbort.abort();
      loadAbortRef.current?.abort();
      if (reconnect) window.clearTimeout(reconnect);
      cancelProvisionalFlush();
      pendingCandle = undefined;
      socket?.close();
    };
  }, [enabled, symbol, timeframe, exchange, marketKey, marketType, priceType]);

  const loadOlder = useCallback(() => {
    if (!enabled || loadingRef.current || !hasMore) return;
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    loadAbortRef.current?.abort();
    loadAbortRef.current = controller;
    loadingRef.current = true;
    setLoadingMore(true);
    getCandles(symbol, timeframe, 1000, oldest.time - 1, exchange, { signal: controller.signal, marketType, priceType })
      .then((payload) => {
        if (generationRef.current !== generation) return;
        const older = payload.candles.filter((candle) => candle.time < oldest.time);
        if (older.length === 0) {
          setHasMore(false);
          return;
        }
        const current = seriesRef.current;
        const firstTime = current.candles[0]?.time ?? Infinity;
        const merged = prependCandleSeriesBuffer(current, older.filter((candle) => candle.time < firstTime), MAX_CANDLES);
        seriesRef.current = merged;
        setSeries(merged);
        recordCopiedCandleElements("prepend", merged.structuralCandles.length);
        setHasMore(payload.hasMore ?? older.length >= 1000);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      })
      .finally(() => {
        if (loadAbortRef.current !== controller) return;
        loadAbortRef.current = null;
        loadingRef.current = false;
        setLoadingMore(false);
      });
  }, [enabled, symbol, timeframe, hasMore, exchange, marketType, priceType]);

  return useMemo(
    () => ({ candles: activeCandles, connection, provider, message, latencyMs, hasMore, loadingMore, loadOlder, gapCount: gapSummary.gapCount, missingBars: gapSummary.missingBars, fallbackActive: connection === "fallback" || provider.toLowerCase().includes("synthetic") }),
    [activeCandles, connection, latencyMs, message, provider, hasMore, loadingMore, loadOlder, gapSummary]
  );
}
