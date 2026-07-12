import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMarketSocket, getCandles, parseStreamMessage } from "../api/marketClient";
import type { SharedSocketClient } from "../api/sharedWebSocketPool";
import type { Candle, DataExchange, StreamMessage, Timeframe } from "../types";
import { analyzeCandleGaps } from "../market/dataQuality";

export type ConnectionState = "connecting" | "connected" | "fallback" | "error";

const MAX_CANDLES = 12_000;
const EMPTY_CANDLES: Candle[] = [];

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
  exchange: DataExchange = "binance"
): MarketStreamState {
  const marketKey = `${exchange}:${symbol}:${timeframe}`;
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataKey, setDataKey] = useState(marketKey);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [provider, setProvider] = useState("Loading");
  const [message, setMessage] = useState("Connecting");
  const [latencyMs, setLatencyMs] = useState<number>();
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const candlesRef = useRef<Candle[]>([]);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const activeCandles = dataKey === marketKey ? candles : EMPTY_CANDLES;
  const gapSummary = useMemo(() => analyzeCandleGaps(activeCandles, timeframe), [activeCandles, timeframe]);
  candlesRef.current = activeCandles;

  useEffect(() => {
    setHasMore(true);
  }, [symbol, timeframe, exchange]);

  useEffect(() => {
    let alive = true;
    let socket: SharedSocketClient | undefined;
    let reconnect: number | undefined;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const historyAbort = new AbortController();
    let attempts = 0;
    loadingRef.current = false;
    loadAbortRef.current?.abort();
    setConnection("connecting");
    setProvider("Loading");
    setMessage(`Loading ${symbol} ${timeframe}`);
    setLatencyMs(undefined);
    setLoadingMore(false);

    const mergeCandle = (next: Candle) => {
      setDataKey(marketKey);
      setCandles((current) => {
        const last = current[current.length - 1];
        if (last?.time === next.time) {
          return [...current.slice(0, -1), next];
        }
        // Keep a large ring so lazily-loaded history survives new live bars.
        return [...current.slice(-(MAX_CANDLES - 1)), next];
      });
    };

    const connect = () => {
      setConnection("connecting");
      socket = createMarketSocket(symbol, timeframe, exchange);

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
        setLatencyMs(Math.max(0, Date.now() - data.ts));

        if (data.type === "snapshot") {
          setDataKey(marketKey);
          setCandles(data.candles);
          setProvider(data.provider);
          setMessage(`${data.symbol} ${data.timeframe} snapshot loaded`);
        } else if (data.type === "candle") {
          mergeCandle(data.candle);
          setProvider(data.provider);
        } else if (data.type === "status") {
          setConnection(data.status === "fallback" ? "fallback" : "connected");
          setProvider(data.provider);
          setMessage(data.message);
        } else if (data.type === "error") {
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

    getCandles(symbol, timeframe, 1000, undefined, exchange, { signal: historyAbort.signal })
      .then((payload) => {
        if (!alive || generationRef.current !== generation) return;
        setDataKey(marketKey);
        setCandles(payload.candles);
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
      socket?.close();
    };
  }, [symbol, timeframe, exchange, marketKey]);

  const loadOlder = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    loadAbortRef.current?.abort();
    loadAbortRef.current = controller;
    loadingRef.current = true;
    setLoadingMore(true);
    getCandles(symbol, timeframe, 1000, oldest.time - 1, exchange, { signal: controller.signal })
      .then((payload) => {
        if (generationRef.current !== generation) return;
        const older = payload.candles.filter((candle) => candle.time < oldest.time);
        if (older.length === 0) {
          setHasMore(false);
          return;
        }
        setCandles((current) => {
          const firstTime = current[0]?.time ?? Infinity;
          const merged = [...older.filter((candle) => candle.time < firstTime), ...current];
          return merged.slice(-MAX_CANDLES);
        });
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
  }, [symbol, timeframe, hasMore, exchange]);

  return useMemo(
    () => ({ candles: activeCandles, connection, provider, message, latencyMs, hasMore, loadingMore, loadOlder, gapCount: gapSummary.gapCount, missingBars: gapSummary.missingBars, fallbackActive: connection === "fallback" || provider.toLowerCase().includes("synthetic") }),
    [activeCandles, connection, latencyMs, message, provider, hasMore, loadingMore, loadOlder, gapSummary]
  );
}
