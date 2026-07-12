import type { Candle, Timeframe } from "../types";

export type MarketSessionId = "asia" | "london" | "new-york";
export type MarketSessionVisibility = Record<MarketSessionId, boolean>;
export const MARKET_SESSION_IDS: MarketSessionId[] = ["asia", "london", "new-york"];

export interface MarketSessionRange {
  id: MarketSessionId;
  dateKey: string;
  startTime: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  active: boolean;
}

export const DEFAULT_MARKET_SESSION_VISIBILITY: MarketSessionVisibility = { asia: true, london: true, "new-york": true };

const DEFINITIONS: Record<MarketSessionId, { timeZone: string; start: number; end: number }> = {
  asia: { timeZone: "Asia/Tokyo", start: 9 * 60, end: 18 * 60 },
  london: { timeZone: "Europe/London", start: 8 * 60, end: 17 * 60 },
  "new-york": { timeZone: "America/New_York", start: 9 * 60 + 30, end: 16 * 60 }
};

const formatters = Object.fromEntries(Object.entries(DEFINITIONS).map(([id, definition]) => [id, new Intl.DateTimeFormat("en-US", {
  timeZone: definition.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
})])) as Record<MarketSessionId, Intl.DateTimeFormat>;
const localTimeCache = new Map<string, { dateKey: string; minute: number }>();

export function supportsMarketSessions(timeframe: Timeframe) {
  return timeframe === "1m" || timeframe === "5m" || timeframe === "15m" || timeframe === "30m" || timeframe === "1h";
}

export function marketSessionAt(id: MarketSessionId, time: number) {
  const local = localTime(id, time);
  const definition = DEFINITIONS[id];
  return { active: local.minute >= definition.start && local.minute < definition.end, dateKey: local.dateKey };
}

export function buildMarketSessionRanges(candles: Candle[], visibility: MarketSessionVisibility): MarketSessionRange[] {
  const latestTime = candles.at(-1)?.time;
  const ranges = new Map<string, MarketSessionRange>();
  for (const candle of candles) {
    for (const id of MARKET_SESSION_IDS) {
      if (!visibility[id]) continue;
      const membership = marketSessionAt(id, candle.time);
      if (!membership.active) continue;
      const key = `${id}:${membership.dateKey}`;
      const current = ranges.get(key);
      if (current) {
        current.endTime = candle.time;
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
        current.active = candle.time === latestTime;
      } else {
        ranges.set(key, {
          id,
          dateKey: membership.dateKey,
          startTime: candle.time,
          endTime: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          active: candle.time === latestTime
        });
      }
    }
  }
  return [...ranges.values()].sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
}

function localTime(id: MarketSessionId, time: number) {
  const key = `${id}:${time}`;
  const cached = localTimeCache.get(key);
  if (cached) return cached;
  const values: Record<string, string> = {};
  for (const part of formatters[id].formatToParts(time)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  const result = {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute)
  };
  if (localTimeCache.size >= 50_000) localTimeCache.clear();
  localTimeCache.set(key, result);
  return result;
}
