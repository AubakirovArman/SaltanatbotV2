export type Locale = "en" | "ru";
export type TextDirection = "ltr" | "rtl";

/** Central direction metadata keeps future RTL locales out of component logic. */
export function localeDirection(_locale: Locale): TextDirection {
  return "ltr";
}

const en = {
  chart: "Chart",
  strategy: "Strategy",
  trade: "Trade",
  toggleMarkets: "Toggle markets panel",
  toggleInstrument: "Toggle instrument panel",
  openPalette: "Open command palette",
  toggleTheme: "Toggle light or dark theme",
  switchToRussian: "Switch interface language to Russian",
  switchToEnglish: "Switch interface language to English",
  statusConnected: "live",
  statusFallback: "synth",
  statusError: "offline",
  statusConnecting: "sync"
} as const;

type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  chart: "График",
  strategy: "Стратегия",
  trade: "Торговля",
  toggleMarkets: "Показать или скрыть панель рынков",
  toggleInstrument: "Показать или скрыть панель инструмента",
  openPalette: "Открыть палитру команд",
  toggleTheme: "Переключить светлую или тёмную тему",
  switchToRussian: "Переключить язык интерфейса на русский",
  switchToEnglish: "Переключить язык интерфейса на английский",
  statusConnected: "онлайн",
  statusFallback: "синт.",
  statusError: "офлайн",
  statusConnecting: "синхр."
};

const messages: Record<Locale, Record<MessageKey, string>> = { en, ru };

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key] ?? en[key];
}

export function loadLocale(): Locale {
  try {
    const saved = window.localStorage.getItem("sbv2:locale");
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    // Browser storage may be unavailable in private/restricted contexts.
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem("sbv2:locale", locale);
  } catch {
    // The active locale still works for this session.
  }
}
