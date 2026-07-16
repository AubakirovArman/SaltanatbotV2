import { kkCore } from "./kk";

export type Locale = "en" | "ru" | "kk";
export type TextDirection = "ltr" | "rtl";

export const supportedLocales: readonly Locale[] = ["en", "ru", "kk"];
export const localeNames: Record<Locale, string> = { en: "English", ru: "Русский", kk: "Қазақша" };

/** Central direction metadata keeps future RTL locales out of component logic. */
export function localeDirection(_locale: Locale): TextDirection {
  return "ltr";
}

const en = {
  chart: "Chart",
  strategy: "Strategy",
  trade: "Trade",
  screener: "Screener",
  toggleMarkets: "Toggle markets panel",
  toggleInstrument: "Toggle instrument panel",
  openPalette: "Open command palette",
  toggleTheme: "Toggle light or dark theme",
  switchToRussian: "Switch interface language to Russian",
  switchToKazakh: "Switch interface language to Kazakh",
  switchToEnglish: "Switch interface language to English",
  statusConnected: "live",
  statusFallback: "synth",
  statusError: "offline",
  statusPaused: "paused",
  statusConnecting: "sync"
} as const;

export type MessageKey = keyof typeof en;

const ru: Record<MessageKey, string> = {
  chart: "График",
  strategy: "Стратегия",
  trade: "Торговля",
  screener: "Скринер",
  toggleMarkets: "Показать или скрыть панель рынков",
  toggleInstrument: "Показать или скрыть панель инструмента",
  openPalette: "Открыть палитру команд",
  toggleTheme: "Переключить светлую или тёмную тему",
  switchToRussian: "Переключить язык интерфейса на русский",
  switchToKazakh: "Переключить язык интерфейса на казахский",
  switchToEnglish: "Переключить язык интерфейса на английский",
  statusConnected: "онлайн",
  statusFallback: "синт.",
  statusError: "офлайн",
  statusPaused: "пауза",
  statusConnecting: "синхр."
};

const messages: Record<Locale, Record<MessageKey, string>> = { en, ru, kk: kkCore };

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key] ?? en[key];
}

export function loadLocale(): Locale {
  try {
    const saved = window.localStorage.getItem("sbv2:locale");
    if (supportedLocales.includes(saved as Locale)) return saved as Locale;
  } catch {
    // Browser storage may be unavailable in private/restricted contexts.
  }
  if (typeof navigator !== "undefined") {
    const language = navigator.language.toLowerCase();
    if (language.startsWith("kk")) return "kk";
    if (language.startsWith("ru")) return "ru";
  }
  return "en";
}

export function nextLocale(locale: Locale): Locale {
  return supportedLocales[(supportedLocales.indexOf(locale) + 1) % supportedLocales.length];
}

export function localeTag(locale: Locale): string {
  return locale === "kk" ? "kk-KZ" : locale === "ru" ? "ru-RU" : "en-US";
}

export function localized<T>(locale: Locale, values: Record<Locale, T>): T {
  return values[locale];
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem("sbv2:locale", locale);
  } catch {
    // The active locale still works for this session.
  }
}
