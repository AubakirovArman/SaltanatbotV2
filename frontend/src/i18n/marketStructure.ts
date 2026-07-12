import type { Locale } from ".";

const en = {
  marketStructure: "Confirmed market structure",
  toggleStructure: "Toggle confirmed swings and BOS / CHOCH",
  toggleFvg: "Toggle closed-candle fair value gaps",
  swingStrength: "Swing confirmation strength",
  trend: "Trend",
  bullish: "bullish",
  bearish: "bearish",
  neutral: "neutral",
  confirmedSwings: "confirmed swings",
  structureBreaks: "structure breaks",
  openFvg: "open fair value gaps",
  latestEvent: "Latest event",
  noEvents: "No confirmed structure events",
  utcMapTimeframes: "UTC session map is available on 1-minute through 4-hour charts"
} as const;

export type MarketStructureMessageKey = keyof typeof en;

const ru: Record<MarketStructureMessageKey, string> = {
  marketStructure: "Подтверждённая структура рынка",
  toggleStructure: "Показать или скрыть подтверждённые свинги и BOS / CHOCH",
  toggleFvg: "Показать или скрыть FVG по закрытым свечам",
  swingStrength: "Сила подтверждения свинга",
  trend: "Тренд",
  bullish: "бычий",
  bearish: "медвежий",
  neutral: "нейтральный",
  confirmedSwings: "подтверждённых свингов",
  structureBreaks: "сломов структуры",
  openFvg: "открытых FVG",
  latestEvent: "Последнее событие",
  noEvents: "Подтверждённых событий структуры пока нет",
  utcMapTimeframes: "Карта UTC-сессии доступна на графиках от 1 минуты до 4 часов"
};

const messages: Record<Locale, Record<MarketStructureMessageKey, string>> = { en, ru };

export function marketStructureText(locale: Locale, key: MarketStructureMessageKey): string {
  return messages[locale][key] ?? en[key];
}
