import type { Locale } from ".";

const en = {
  commandPalette: "Command palette", commandSearch: "Search symbols, timeframes, chart types, actions...", noCommands: "No matching commands", closeHint: "esc close",
  symbol: "Symbol", timeframe: "Timeframe", key: "key", chartType: "Chart type", view: "View", openChart: "Open Chart", openStrategy: "Open Strategy Lab", openTrading: "Open Trading", toggleTheme: "Toggle light / dark theme", indicator: "Indicator", hide: "Hide", show: "Show", alerts: "Alerts", clearAlerts: "Clear all price alerts",
  markets: "Markets", symbols: "symbols", sort: "Sort", changeSort: "Change sort. Currently", searchInstruments: "Search instruments", searchPlaceholder: "Search BTC, NASDAQ, EUR…", all: "All", crypto: "Crypto", forex: "FX", stocks: "Stocks", index: "Index", source: "Source", cryptoSource: "Crypto data source", showPricesFrom: "Show crypto prices from", pin: "Pin", unpin: "Unpin", pinTop: "Pin to top", noMatches: "No matches", noMatchesHint: "Try another symbol, venue, or asset class.", sortHighLow: "% high → low", sortLowHigh: "% low → high",
  barStatistics: "Bar statistics", open: "Open", high: "High", low: "Low", range: "Range", change: "Change", volume: "Volume", feed: "Feed", provider: "Provider", latency: "Latency", candles: "Candles", status: "Status", priceAlerts: "Price alerts", on: "on", price: "Price", alertPrice: "Alert price for", add: "Add", hit: "hit", armed: "armed", rearmAlert: "Re-arm alert", rearm: "Re-arm", removeAlert: "Remove alert", remove: "Remove", roseAbove: "rose above", fellBelow: "fell below", now: "now", dismissAlert: "Dismiss alert",
  loadingCatalog: "Loading market catalog", loadingStrategy: "Loading Strategy Lab", preparingStrategy: "Preparing Blockly blocks and strategy compiler preview."
} as const;

export type ShellMessageKey = keyof typeof en;
const ru: Record<ShellMessageKey, string> = {
  commandPalette: "Палитра команд", commandSearch: "Поиск символов, интервалов, типов графика и действий…", noCommands: "Команды не найдены", closeHint: "esc закрыть",
  symbol: "Символ", timeframe: "Интервал", key: "клавиша", chartType: "Тип графика", view: "Раздел", openChart: "Открыть график", openStrategy: "Открыть студию стратегий", openTrading: "Открыть торговлю", toggleTheme: "Переключить светлую / тёмную тему", indicator: "Индикатор", hide: "Скрыть", show: "Показать", alerts: "Алерты", clearAlerts: "Удалить все ценовые алерты",
  markets: "Рынки", symbols: "символов", sort: "Сортировка", changeSort: "Изменить сортировку. Сейчас", searchInstruments: "Поиск инструментов", searchPlaceholder: "Поиск BTC, NASDAQ, EUR…", all: "Все", crypto: "Крипто", forex: "FX", stocks: "Акции", index: "Индексы", source: "Источник", cryptoSource: "Источник криптоданных", showPricesFrom: "Показывать цены криптовалют с", pin: "Закрепить", unpin: "Открепить", pinTop: "Закрепить сверху", noMatches: "Совпадений нет", noMatchesHint: "Попробуйте другой символ, площадку или класс активов.", sortHighLow: "% по убыванию", sortLowHigh: "% по возрастанию",
  barStatistics: "Статистика свечи", open: "Открытие", high: "Максимум", low: "Минимум", range: "Диапазон", change: "Изменение", volume: "Объём", feed: "Поток данных", provider: "Провайдер", latency: "Задержка", candles: "Свечи", status: "Статус", priceAlerts: "Ценовые алерты", on: "для", price: "Цена", alertPrice: "Цена алерта для", add: "Добавить", hit: "сработал", armed: "активен", rearmAlert: "Активировать алерт снова", rearm: "Активировать снова", removeAlert: "Удалить алерт", remove: "Удалить", roseAbove: "поднялся выше", fellBelow: "опустился ниже", now: "сейчас", dismissAlert: "Закрыть алерт",
  loadingCatalog: "Загрузка каталога рынков", loadingStrategy: "Загрузка студии стратегий", preparingStrategy: "Подготовка блоков Blockly и предпросмотра компилятора."
};

const messages: Record<Locale, Record<ShellMessageKey, string>> = { en, ru };
export function shellText(locale: Locale, key: ShellMessageKey): string {
  return messages[locale][key] ?? en[key];
}
