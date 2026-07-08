import { useEffect, useState } from "react";
import { getSparklines, type SparklineSeries } from "../api/marketClient";
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
    if (!key) return;
    let alive = true;
    const list = key.split(",");

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

    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [key, timeframe, exchange]);

  return map;
}
