import {
  Activity,
  AreaChart,
  BarChart3,
  Blocks,
  CandlestickChart,
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
  linebreak: Rows3
};

const labels: Record<Locale, Record<ChartType, string>> = {
  en: {
    candles: "Candles", hollow: "Hollow candles", heikin: "Heikin Ashi", bars: "Bars",
    line: "Line", step: "Step line", area: "Area", baseline: "Baseline", renko: "Renko",
    linebreak: "Three Line Break"
  },
  ru: {
    candles: "Свечи", hollow: "Пустые свечи", heikin: "Хейкин Аши", bars: "Бары",
    line: "Линия", step: "Ступенчатая линия", area: "Область", baseline: "Базовая линия", renko: "Ренко",
    linebreak: "Трёхлинейный прорыв"
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
  return locale === "ru" ? `${symbol}: ${title}, интервал ${timeframe}` : `${symbol} ${title} chart on ${timeframe}`;
}
