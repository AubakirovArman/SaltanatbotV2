import { getCandles } from "../api/marketClient";
import type { Candle, DataExchange, Timeframe } from "../types";

export interface CandleHistoryRequest {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  endTime?: number;
  exchange?: DataExchange;
  /** Stop paging once the oldest loaded candle reaches this timestamp. */
  stopAt?: number;
  signal?: AbortSignal;
}

export type CandlePageLoader = (
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  endTime?: number,
  exchange?: DataExchange,
  init?: { signal?: AbortSignal }
) => Promise<{ candles: Candle[] }>;

/** Loads a deterministic, de-duplicated candle window in bounded API pages. */
export async function loadCandleHistory(
  request: CandleHistoryRequest,
  loadPage: CandlePageLoader = getCandles
): Promise<Candle[]> {
  const target = Math.max(0, Math.floor(request.bars));
  if (target === 0) return [];
  let candles = normalize((await loadPage(
    request.symbol,
    request.timeframe,
    Math.min(target, 1_000),
    request.endTime,
    request.exchange,
    { signal: request.signal }
  )).candles);

  while (candles.length < target && candles.length > 0) {
    const oldest = candles[0].time;
    if (request.stopAt !== undefined && oldest <= request.stopAt) break;
    const older = normalize((await loadPage(
      request.symbol,
      request.timeframe,
      Math.min(1_000, target - candles.length),
      oldest - 1,
      request.exchange,
      { signal: request.signal }
    )).candles).filter((candle) => candle.time < oldest);
    if (older.length === 0) break;
    candles = normalize([...older, ...candles]);
  }

  return candles.slice(-target);
}

function normalize(candles: Candle[]): Candle[] {
  return [...new Map(candles.map((candle) => [candle.time, candle])).values()]
    .sort((a, b) => a.time - b.time);
}
