import type { ChartMarker, ChartTrade } from "../chart/types";
import type { Locale } from ".";

const en = {
  chartData: "Chart data",
  hideChartData: "Hide chart data",
  semanticAlternative: "Semantic alternative to the visual chart",
  latestCandle: "Latest candle",
  focusedCandle: "Focused candle",
  time: "Time",
  open: "Open",
  high: "High",
  low: "Low",
  close: "Close",
  volume: "Volume",
  marketDataLoading: "Market data is loading.",
  type: "Type",
  price: "Price",
  label: "Label",
  entry: "Entry",
  exit: "Exit",
  side: "Side",
  entryPrice: "Entry price",
  exitPrice: "Exit price",
  pnl: "P&L",
  reason: "Reason",
  noSignals: "No strategy signals.",
  noTrades: "No executed trades."
} as const;

export type ChartMessageKey = keyof typeof en;

const ru: Record<ChartMessageKey, string> = {
  chartData: "Данные графика",
  hideChartData: "Скрыть данные графика",
  semanticAlternative: "Табличное представление визуального графика",
  latestCandle: "Последняя свеча",
  focusedCandle: "Выбранная свеча",
  time: "Время",
  open: "Открытие",
  high: "Максимум",
  low: "Минимум",
  close: "Закрытие",
  volume: "Объём",
  marketDataLoading: "Рыночные данные загружаются.",
  type: "Тип",
  price: "Цена",
  label: "Метка",
  entry: "Вход",
  exit: "Выход",
  side: "Направление",
  entryPrice: "Цена входа",
  exitPrice: "Цена выхода",
  pnl: "Прибыль/убыток",
  reason: "Причина",
  noSignals: "Сигналов стратегии нет.",
  noTrades: "Исполненных сделок нет."
};

const messages: Record<Locale, Record<ChartMessageKey, string>> = { en, ru };

export function chartText(locale: Locale, key: ChartMessageKey) {
  return messages[locale][key];
}

export function chartSummary(locale: Locale, input: { symbol: string; timeframe: string; close?: string; signals: number; trades: number }) {
  if (input.close === undefined) {
    return locale === "ru" ? `${input.symbol} ${input.timeframe}. Данные графика загружаются.` : `${input.symbol} ${input.timeframe}. Chart data is loading.`;
  }
  return locale === "ru" ? `${input.symbol} ${input.timeframe}. Закрытие выбранной свечи: ${input.close}. Сигналов: ${input.signals}, сделок: ${input.trades}.` : `${input.symbol} ${input.timeframe}. Focused candle close ${input.close}. ${input.signals} signals and ${input.trades} trades.`;
}

export function recentCandlesCaption(locale: Locale, limit: number) {
  return locale === "ru" ? `Последние свечи (сначала новые, до ${limit})` : `Recent candles (newest first, up to ${limit})`;
}

export function strategySignalsCaption(locale: Locale, total: number, limit: number) {
  return locale === "ru" ? `Сигналы стратегии (всего ${total}; показаны последние ${limit})` : `Strategy signals (${total} total; newest ${limit} shown)`;
}

export function executedTradesCaption(locale: Locale, total: number, limit: number) {
  return locale === "ru" ? `Исполненные сделки (всего ${total}; показаны последние ${limit})` : `Executed trades (${total} total; newest ${limit} shown)`;
}

const terms = {
  en: { buy: "Buy", sell: "Sell", exit: "Exit", marker: "Marker", long: "Long", short: "Short", signal: "Signal", stop: "Stop", target: "Target", close: "Close", liquidation: "Liquidation" },
  ru: { buy: "Покупка", sell: "Продажа", exit: "Выход", marker: "Метка", long: "Лонг", short: "Шорт", signal: "Сигнал", stop: "Стоп", target: "Цель", close: "Закрытие", liquidation: "Ликвидация" }
} satisfies Record<Locale, Record<ChartMarker["kind"] | ChartTrade["direction"] | ChartTrade["reason"], string>>;

export function chartTerm(locale: Locale, value: ChartMarker["kind"] | ChartTrade["direction"] | ChartTrade["reason"]) {
  return terms[locale][value];
}

export function intlLocale(locale: Locale) {
  return locale === "ru" ? "ru-RU" : "en-US";
}
