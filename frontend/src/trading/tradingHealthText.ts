import type { Locale } from "../i18n";

const messages = {
  en: {
    live: "Trading updates connected",
    connecting: "Connecting trading updates",
    degraded: "Trading updates degraded",
    stale: "Trading data is stale. Actions remain available, but values below may be outdated.",
    invalidEvent: "Invalid trading event received",
    socketClosed: "Trading event stream disconnected; reconnecting",
    loadFailed: "Could not refresh trading data",
    lastUpdate: "last successful refresh"
  },
  ru: {
    live: "Обновления торговли подключены",
    connecting: "Подключение обновлений торговли",
    degraded: "Обновления торговли работают с ошибками",
    stale: "Торговые данные устарели. Действия доступны, но значения ниже могут быть неактуальны.",
    invalidEvent: "Получено некорректное торговое событие",
    socketClosed: "Поток торговых событий отключён; переподключение",
    loadFailed: "Не удалось обновить торговые данные",
    lastUpdate: "последнее успешное обновление"
  },
  kk: {
    live: "Сауда жаңартулары қосылды",
    connecting: "Сауда жаңартулары қосылуда",
    degraded: "Сауда жаңартулары қателермен жұмыс істеуде",
    stale: "Сауда деректері ескірген. Әрекеттер қолжетімді, бірақ төмендегі мәндер ескі болуы мүмкін.",
    invalidEvent: "Жарамсыз сауда оқиғасы алынды",
    socketClosed: "Сауда оқиғалары ағыны үзілді; қайта қосылуда",
    loadFailed: "Сауда деректерін жаңарту мүмкін болмады",
    lastUpdate: "соңғы сәтті жаңарту"
  }
} as const;

export function tradingHealthText(locale: Locale, key: keyof typeof messages.en) {
  return messages[locale][key];
}
