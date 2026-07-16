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

const formatters = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([id, definition]) => [
    id,
    new Intl.DateTimeFormat("en-US", {
      timeZone: definition.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
  ])
) as Record<MarketSessionId, Intl.DateTimeFormat>;
// The chart retains at most 12k bars; leave headroom for aligned secondary series
// without allowing long-running symbol/timeframe switches to grow the cache.
const SESSION_MEMBERSHIP_CACHE_LIMIT = 16_384;
type MarketSessionMembership = { active: boolean; dateKey: string };
type MarketSessionMemberships = Record<MarketSessionId, MarketSessionMembership>;
const sessionMembershipCache = new Map<number, MarketSessionMemberships>();

export function supportsMarketSessions(timeframe: Timeframe) {
  return timeframe === "1m" || timeframe === "5m" || timeframe === "15m" || timeframe === "30m" || timeframe === "1h";
}

export function marketSessionAt(id: MarketSessionId, time: number) {
  const membership = sessionMembershipsAt(time)[id];
  return { active: membership.active, dateKey: membership.dateKey };
}

export function buildMarketSessionRanges(candles: readonly Candle[], visibility: MarketSessionVisibility, endExclusive = candles.length): MarketSessionRange[] {
  const requestedEnd = Number.isFinite(endExclusive) ? Math.trunc(endExclusive) : candles.length;
  const end = Math.min(candles.length, Math.max(0, requestedEnd));
  const latestTime = end > 0 ? candles[end - 1].time : undefined;
  const ranges: MarketSessionRange[] = [];
  const currentRanges: Partial<Record<MarketSessionId, MarketSessionRange>> = {};
  let previousTime = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < end; index += 1) {
    const candle = candles[index];
    if (candle.time < previousTime) return buildUnorderedMarketSessionRanges(candles, visibility, end);
    previousTime = candle.time;
    const memberships = sessionMembershipsAt(candle.time);
    for (const id of MARKET_SESSION_IDS) {
      if (!visibility[id]) continue;
      const membership = memberships[id];
      if (!membership.active) continue;
      const current = currentRanges[id];
      if (current?.dateKey === membership.dateKey) {
        current.endTime = candle.time;
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
        current.active = candle.time === latestTime;
      } else {
        const next = {
          id,
          dateKey: membership.dateKey,
          startTime: candle.time,
          endTime: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          active: candle.time === latestTime
        };
        currentRanges[id] = next;
        ranges.push(next);
      }
    }
  }
  return ranges;
}

/** Patch only the forming tail over ranges built from immutable history. */
export function appendMarketSessionTail(ranges: readonly MarketSessionRange[], candle: Candle, visibility: MarketSessionVisibility): MarketSessionRange[] {
  const next = ranges.slice();
  const latestIndexes: Partial<Record<MarketSessionId, number>> = {};
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const range = next[index];
    if (latestIndexes[range.id] === undefined) latestIndexes[range.id] = index;
    if (range.active) next[index] = { ...range, active: false };
  }
  const memberships = sessionMembershipsAt(candle.time);
  for (const id of MARKET_SESSION_IDS) {
    if (!visibility[id]) continue;
    const membership = memberships[id];
    if (!membership.active) continue;
    const index = latestIndexes[id];
    if (index === undefined || next[index].dateKey !== membership.dateKey) {
      latestIndexes[id] = next.length;
      next.push({
        id,
        dateKey: membership.dateKey,
        startTime: candle.time,
        endTime: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        active: true
      });
      continue;
    }
    const current = next[index];
    next[index] = {
      ...current,
      endTime: candle.time,
      high: Math.max(current.high, candle.high),
      low: Math.min(current.low, candle.low),
      close: candle.close,
      active: true
    };
  }
  return next;
}

function sessionMembershipsAt(time: number) {
  const cached = sessionMembershipCache.get(time);
  if (cached) return cached;

  const result = {} as MarketSessionMemberships;
  for (const id of MARKET_SESSION_IDS) {
    const local = localTime(id, time);
    const definition = DEFINITIONS[id];
    result[id] = {
      active: local.minute >= definition.start && local.minute < definition.end,
      dateKey: local.dateKey
    };
  }

  if (sessionMembershipCache.size >= SESSION_MEMBERSHIP_CACHE_LIMIT) {
    const oldest = sessionMembershipCache.keys().next().value;
    if (oldest !== undefined) sessionMembershipCache.delete(oldest);
  }
  sessionMembershipCache.set(time, result);
  return result;
}

function localTime(id: MarketSessionId, time: number) {
  let year = "";
  let month = "";
  let day = "";
  let hour = 0;
  let minute = 0;
  for (const part of formatters[id].formatToParts(time)) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { dateKey: `${year}-${month}-${day}`, minute: hour * 60 + minute };
}

function buildUnorderedMarketSessionRanges(candles: readonly Candle[], visibility: MarketSessionVisibility, end: number) {
  const latestTime = end > 0 ? candles[end - 1].time : undefined;
  const ranges = new Map<string, MarketSessionRange>();
  for (let index = 0; index < end; index += 1) {
    const candle = candles[index];
    const memberships = sessionMembershipsAt(candle.time);
    for (const id of MARKET_SESSION_IDS) {
      if (!visibility[id]) continue;
      const membership = memberships[id];
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
