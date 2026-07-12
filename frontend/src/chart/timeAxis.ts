import type { Locale } from "../i18n";
import { localeTag } from "../i18n";

export const CHART_TIME_ZONES = [
  "exchange",
  "local",
  "UTC",
  "Asia/Almaty",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Hong_Kong"
] as const;

export type ChartTimeZone = typeof CHART_TIME_ZONES[number];

export const DEFAULT_CHART_TIME_ZONE: ChartTimeZone = "exchange";
export const LEGACY_CHART_TIME_ZONE: ChartTimeZone = "local";

export function normalizeChartTimeZone(value: unknown, fallback: ChartTimeZone = DEFAULT_CHART_TIME_ZONE): ChartTimeZone {
  return CHART_TIME_ZONES.includes(value as ChartTimeZone) && supportsTimeZone(value as ChartTimeZone)
    ? value as ChartTimeZone
    : fallback;
}

export function resolvedChartTimeZone(value: ChartTimeZone): string | undefined {
  if (value === "local") return undefined;
  return value === "exchange" ? "UTC" : value;
}

export interface ChartTimeFormatter {
  tick(time: number, previousTime: number | undefined, barTimeMs: number): string;
  dateTime(time: number): string;
  time(time: number): string;
}

const formatterCache = new Map<string, ChartTimeFormatter>();

export function createChartTimeFormatter(locale: Locale, timeZone: ChartTimeZone): ChartTimeFormatter {
  const safeTimeZone = normalizeChartTimeZone(timeZone);
  const cacheKey = `${locale}:${safeTimeZone}`;
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const resolved = resolvedChartTimeZone(safeTimeZone);
  const common = resolved ? { timeZone: resolved } : {};
  const tag = localeTag(locale);
  const date = new Intl.DateTimeFormat(tag, { ...common, month: "short", day: "numeric" });
  const year = new Intl.DateTimeFormat(tag, { ...common, year: "numeric" });
  const time = new Intl.DateTimeFormat(tag, { ...common, hour: "2-digit", minute: "2-digit" });
  const dateTime = new Intl.DateTimeFormat(tag, { ...common, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const dateKey = new Intl.DateTimeFormat("en-CA", { ...common, year: "numeric", month: "2-digit", day: "2-digit" });
  const yearKey = new Intl.DateTimeFormat("en", { ...common, year: "numeric" });
  const formatter: ChartTimeFormatter = {
    tick(value, previous, barTimeMs) {
      if (barTimeMs >= 86_400_000) {
        return previous === undefined || yearKey.format(previous) !== yearKey.format(value)
          ? year.format(value)
          : date.format(value);
      }
      return previous === undefined || dateKey.format(previous) !== dateKey.format(value)
        ? date.format(value)
        : time.format(value);
    },
    dateTime: (value) => dateTime.format(value),
    time: (value) => time.format(value)
  };
  formatterCache.set(cacheKey, formatter);
  return formatter;
}

function supportsTimeZone(value: ChartTimeZone): boolean {
  const resolved = resolvedChartTimeZone(value);
  if (!resolved) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: resolved }).format(0);
    return true;
  } catch {
    return false;
  }
}
