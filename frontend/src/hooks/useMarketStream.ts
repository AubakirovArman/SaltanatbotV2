import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMarketSocket, getCandles, parseStreamMessage } from "../api/marketClient";
import type { Candle, DataExchange, Timeframe } from "../types";

export type ConnectionState = "connecting" | "connected" | "fallback" | "error";

const MAX_CANDLES = 12_000;

interface MarketStreamState {
  candles: Candle[];
  connection: ConnectionState;
  provider: string;
  message: string;
  latencyMs?: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadOlder: () => void;
}

export function useMarketStream(
  symbol: string,
  timeframe: Timeframe,
  exchange: DataExchange = "binance"
): MarketStreamState {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [provider, setProvider] = useState("Loading");
  const [message, setMessage] = useState("Connecting");
  const [latencyMs, setLatencyMs] = useState<number>();
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const candlesRef = useRef<Candle[]>([]);
  const loadingRef = useRef(false);
  candlesRef.current = candles;

  useEffect(() => {
    setHasMore(true);
  }, [symbol, timeframe, exchange]);

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let attempts = 0;

    const mergeCandle = (next: Candle) => {
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
        const data = parseStreamMessage(event.data);
        setLatencyMs(Math.max(0, Date.now() - data.ts));

        if (data.type === "snapshot") {
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

    getCandles(symbol, timeframe, 1000, undefined, exchange)
      .then((payload) => {
        if (!alive) return;
        setCandles(payload.candles);
        setProvider(payload.provider);
        connect();
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setConnection("error");
        setMessage(error instanceof Error ? error.message : "History request failed");
        connect();
      });

    return () => {
      alive = false;
      if (reconnect) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [symbol, timeframe, exchange]);

  const loadOlder = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    const oldest = candlesRef.current[0];
    if (!oldest) return;
    loadingRef.current = true;
    setLoadingMore(true);
    getCandles(symbol, timeframe, 1000, oldest.time - 1, exchange)
      .then((payload) => {
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
      .catch(() => undefined)
      .finally(() => {
        loadingRef.current = false;
        setLoadingMore(false);
      });
  }, [symbol, timeframe, hasMore, exchange]);

  return useMemo(
    () => ({ candles, connection, provider, message, latencyMs, hasMore, loadingMore, loadOlder }),
    [candles, connection, latencyMs, message, provider, hasMore, loadingMore, loadOlder]
  );
}
