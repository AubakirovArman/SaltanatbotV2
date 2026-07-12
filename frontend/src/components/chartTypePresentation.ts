import {
  Activity,
  AreaChart,
  BarChart3,
  Blocks,
  CandlestickChart,
  ChartSpline,
  GitCommitVertical,
  Grid3X3,
  LineChart,
  Rows3,
  Square,
  type LucideIcon
} from "lucide-react";
import type { Locale } from "../i18n";
import type { ChartType } from "../types";
import { DEFAULT_PRICE_REPRESENTATION_SETTINGS, type PriceRepresentationSettings } from "../chart/priceRepresentationSettings";

export const chartTypeIcons: Record<ChartType, LucideIcon> = {
  candles: CandlestickChart,
  hollow: Square,
  heikin: Activity,
  bars: BarChart3,
  line: LineChart,
  step: GitCommitVertical,
  area: AreaChart,
  baseline: GitCommitVertical,
  renko: Blocks,
  linebreak: Rows3,
  kagi: ChartSpline,
  pnf: Grid3X3
};

const labels: Record<Locale, Record<ChartType, string>> = {
  en: {
    candles: "Candles", hollow: "Hollow candles", heikin: "Heikin Ashi", bars: "Bars",
    line: "Line", step: "Step line", area: "Area", baseline: "Baseline", renko: "Renko",
    linebreak: "Three Line Break", kagi: "Kagi", pnf: "Point & Figure"
  },
  ru: {
    candles: "Свечи", hollow: "Пустые свечи", heikin: "Хейкин Аши", bars: "Бары",
    line: "Линия", step: "Ступенчатая линия", area: "Область", baseline: "Базовая линия", renko: "Ренко",
    linebreak: "Трёхлинейный прорыв", kagi: "Каги", pnf: "Крестики-нолики"
  }
};

export function chartTypeLabel(locale: Locale, type: ChartType): string {
  return labels[locale][type] ?? labels.en[type];
}

export function chartTypeAriaLabel(locale: Locale, type: ChartType, symbol: string, timeframe: string, settings: PriceRepresentationSettings = DEFAULT_PRICE_REPRESENTATION_SETTINGS): string {
  const title = chartTypeLabel(locale, type);
  if (type === "linebreak") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые линии только по цене закрытия, глубина разворота ${settings.lineBreakDepth}.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only lines with a ${settings.lineBreakDepth}-line reversal.`;
  if (type === "renko") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые close-only кирпичи фиксированного размера ${percent(locale, settings.renkoBrickPercent)} с двухкирпичным разворотом.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only fixed ${percent(locale, settings.renkoBrickPercent)} bricks with a two-brick reversal.`;
  if (type === "kagi") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые close-only линии с фиксированным разворотом ${percent(locale, settings.kagiReversalPercent)}, плечами и талиями.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only lines with a fixed ${percent(locale, settings.kagiReversalPercent)} reversal, shoulders and waists.`;
  if (type === "pnf") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые close-only X/O-колонки, клетка ${percent(locale, settings.pnfBoxPercent)}, разворот ${settings.pnfReversalBoxes} клетки.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only X/O columns with ${percent(locale, settings.pnfBoxPercent)} boxes and a ${settings.pnfReversalBoxes}-box reversal.`;
  return locale === "ru" ? `${symbol}: ${title}, интервал ${timeframe}` : `${symbol} ${title} chart on ${timeframe}`;
}

function percent(locale: Locale, value: number) {
  const formatted = value.toFixed(2);
  return `${locale === "ru" ? formatted.replace(".", ",") : formatted}%`;
}
