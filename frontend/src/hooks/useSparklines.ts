import { useEffect, useState } from "react";
import { createQuoteSocket, getSparklines, parseQuoteStreamMessage, type SparklineSeries } from "../api/marketClient";
import type { DataExchange, Timeframe } from "../types";

/** Fetches mini price series for a set of symbols and refreshes periodically. */
export function useSparklines(
  symbols: string[],
  timeframe: Timeframe,
  exchange: DataExchange = "binance"
): Record<string, SparklineSeries> {
  const [map, setMap] = useState<Record<string, SparklineSeries>>({});
  const key = symbols.join(",");

  useEffect(() => {
    if (!key) {
      setMap({});
      return;
    }
    let alive = true;
    const list = key.split(",");
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let fallbackPoll: number | undefined;
    let attempts = 0;

    const load = () => {
      getSparklines(list, timeframe, 32, exchange)
        .then((response) => {
          if (!alive) return;
          const next: Record<string, SparklineSeries> = {};
          for (const [symbol, series] of Object.entries(response.series)) {
            if (series) next[symbol] = series;
          }
          setMap(next);
        })
        .catch(() => undefined);
    };

    const connect = () => {
      socket = createQuoteSocket(list, timeframe, 32, exchange);
      socket.onopen = () => {
        attempts = 0;
        if (fallbackPoll) window.clearInterval(fallbackPoll);
        fallbackPoll = undefined;
      };
      socket.onmessage = (event) => {
        if (!alive || typeof event.data !== "string") return;
        try {
          const message = parseQuoteStreamMessage(event.data);
          if (message.type === "quotes_snapshot") {
            setMap(Object.fromEntries(Object.entries(message.series).filter((entry): entry is [string, SparklineSeries] => entry[1] !== null)));
          } else if (message.type === "quote") {
            setMap((current) => ({ ...current, [message.symbol]: message.series }));
          }
        } catch {
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (!alive) return;
        attempts += 1;
        if (!fallbackPoll) fallbackPoll = window.setInterval(load, 30_000);
        reconnect = window.setTimeout(connect, Math.min(10_000, 1_000 * 2 ** Math.min(attempts, 4)));
      };
      socket.onerror = () => socket?.close();
    };

    load();
    connect();
    return () => {
      alive = false;
      if (reconnect) window.clearTimeout(reconnect);
      if (fallbackPoll) window.clearInterval(fallbackPoll);
      socket?.close();
    };
  }, [key, timeframe, exchange]);

  return map;
}
