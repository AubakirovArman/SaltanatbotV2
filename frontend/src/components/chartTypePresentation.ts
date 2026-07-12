import {
  Activity,
  AreaChart,
  BarChart3,
  Blocks,
  CandlestickChart,
  ChartSpline,
  GitCommitVertical,
  LineChart,
  Rows3,
  Square,
  type LucideIcon
} from "lucide-react";
import type { Locale } from "../i18n";
import type { ChartType } from "../types";

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
  kagi: ChartSpline
};

const labels: Record<Locale, Record<ChartType, string>> = {
  en: {
    candles: "Candles", hollow: "Hollow candles", heikin: "Heikin Ashi", bars: "Bars",
    line: "Line", step: "Step line", area: "Area", baseline: "Baseline", renko: "Renko",
    linebreak: "Three Line Break", kagi: "Kagi"
  },
  ru: {
    candles: "Свечи", hollow: "Пустые свечи", heikin: "Хейкин Аши", bars: "Бары",
    line: "Линия", step: "Ступенчатая линия", area: "Область", baseline: "Базовая линия", renko: "Ренко",
    linebreak: "Трёхлинейный прорыв", kagi: "Каги"
  }
};

export function chartTypeLabel(locale: Locale, type: ChartType): string {
  return labels[locale][type] ?? labels.en[type];
}

export function chartTypeAriaLabel(locale: Locale, type: ChartType, symbol: string, timeframe: string): string {
  const title = chartTypeLabel(locale, type);
  if (type === "linebreak") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые линии только по цене закрытия, разворот после трёх линий.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only lines with a three-line reversal.`;
  if (type === "renko") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые close-only кирпичи фиксированного размера 0,05% с двухкирпичным разворотом.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only fixed 0.05% bricks with a two-brick reversal.`;
  if (type === "kagi") return locale === "ru"
    ? `${symbol}: график «${title}» на ${timeframe}. Подтверждённые close-only линии с фиксированным разворотом 0,10%, плечами и талиями.`
    : `${symbol} ${title} chart on ${timeframe}. Confirmed close-only lines with a fixed 0.10% reversal, shoulders and waists.`;
  return locale === "ru" ? `${symbol}: ${title}, интервал ${timeframe}` : `${symbol} ${title} chart on ${timeframe}`;
}
