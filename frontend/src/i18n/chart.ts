import type { ChartMarker, ChartTrade } from "../chart/types";
import { localeTag, localized, type Locale } from ".";
import { kkChart } from "./kk/chart";

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
  volumeProfile: "Volume profile",
  volumeProfileSource: "Profile timeframe",
  volumeProfileAsChart: "As chart",
  volumeProfileChartReady: "Using chart candles",
  volumeProfileLoading: "Loading real source candles…",
  volumeProfileReady: "Source candles ready",
  volumeProfileFallback: "Profile hidden: the server returned fallback or synthetic data.",
  volumeProfileIncomplete: "Profile hidden: source candles do not cover the visible range.",
  volumeProfileNoData: "Profile hidden: there are no source candles in the visible range.",
  volumeProfileRangeTooWide: "Profile hidden: choose a narrower range or a larger source timeframe.",
  volumeProfileRequestError: "Profile hidden: source candle request failed.",
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
  volumeProfile: "Профиль объёма",
  volumeProfileSource: "Таймфрейм профиля",
  volumeProfileAsChart: "Как на графике",
  volumeProfileChartReady: "Используются свечи графика",
  volumeProfileLoading: "Загружаются реальные свечи источника…",
  volumeProfileReady: "Свечи источника готовы",
  volumeProfileFallback: "Профиль скрыт: сервер вернул подменённые или синтетические данные.",
  volumeProfileIncomplete: "Профиль скрыт: свечи источника не покрывают видимый диапазон.",
  volumeProfileNoData: "Профиль скрыт: в видимом диапазоне нет свечей источника.",
  volumeProfileRangeTooWide: "Профиль скрыт: сузьте диапазон или выберите больший таймфрейм источника.",
  volumeProfileRequestError: "Профиль скрыт: не удалось загрузить свечи источника.",
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

const messages: Record<Locale, Record<ChartMessageKey, string>> = { en, ru, kk: kkChart };

export function chartText(locale: Locale, key: ChartMessageKey) {
  return messages[locale][key];
}

export function chartSummary(locale: Locale, input: { symbol: string; timeframe: string; close?: string; signals: number; trades: number }) {
  if (input.close === undefined) {
    return localized(locale, {
      en: `${input.symbol} ${input.timeframe}. Chart data is loading.`,
      ru: `${input.symbol} ${input.timeframe}. Данные графика загружаются.`,
      kk: `${input.symbol} ${input.timeframe}. График деректері жүктелуде.`
    });
  }
  return localized(locale, {
    en: `${input.symbol} ${input.timeframe}. Focused candle close ${input.close}. ${input.signals} signals and ${input.trades} trades.`,
    ru: `${input.symbol} ${input.timeframe}. Закрытие выбранной свечи: ${input.close}. Сигналов: ${input.signals}, сделок: ${input.trades}.`,
    kk: `${input.symbol} ${input.timeframe}. Таңдалған шамның жабылуы: ${input.close}. Сигналдар: ${input.signals}, мәмілелер: ${input.trades}.`
  });
}

export function recentCandlesCaption(locale: Locale, limit: number) {
  return localized(locale, { en: `Recent candles (newest first, up to ${limit})`, ru: `Последние свечи (сначала новые, до ${limit})`, kk: `Соңғы шамдар (жаңалары алдымен, ${limit} дейін)` });
}

export function strategySignalsCaption(locale: Locale, total: number, limit: number) {
  return localized(locale, { en: `Strategy signals (${total} total; newest ${limit} shown)`, ru: `Сигналы стратегии (всего ${total}; показаны последние ${limit})`, kk: `Стратегия сигналдары (барлығы ${total}; соңғы ${limit} көрсетілді)` });
}

export function executedTradesCaption(locale: Locale, total: number, limit: number) {
  return localized(locale, { en: `Executed trades (${total} total; newest ${limit} shown)`, ru: `Исполненные сделки (всего ${total}; показаны последние ${limit})`, kk: `Орындалған мәмілелер (барлығы ${total}; соңғы ${limit} көрсетілді)` });
}

const terms = {
  en: { buy: "Buy", sell: "Sell", exit: "Exit", marker: "Marker", long: "Long", short: "Short", signal: "Signal", stop: "Stop", target: "Target", close: "Close", liquidation: "Liquidation" },
  ru: { buy: "Покупка", sell: "Продажа", exit: "Выход", marker: "Метка", long: "Лонг", short: "Шорт", signal: "Сигнал", stop: "Стоп", target: "Цель", close: "Закрытие", liquidation: "Ликвидация" },
  kk: { buy: "Сатып алу", sell: "Сату", exit: "Шығу", marker: "Белгі", long: "Лонг", short: "Шорт", signal: "Сигнал", stop: "Стоп", target: "Мақсат", close: "Жабу", liquidation: "Ликвидация" }
} satisfies Record<Locale, Record<ChartMarker["kind"] | ChartTrade["direction"] | ChartTrade["reason"], string>>;

export function chartTerm(locale: Locale, value: ChartMarker["kind"] | ChartTrade["direction"] | ChartTrade["reason"]) {
  return terms[locale][value];
}

export function intlLocale(locale: Locale) {
  return localeTag(locale);
}
