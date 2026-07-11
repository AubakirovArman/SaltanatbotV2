import type { Locale } from ".";

const en = {
  tradingLocked: "Trading is locked",
  accessPrompt: "Enter the admin access token to manage paper and live bots. Public charts stay open; trading controls remain locked until this token is verified.",
  accessToken: "Access token",
  invalidToken: "Invalid access token.",
  checkingAccess: "Checking access…",
  unlock: "Unlock",
  checking: "Checking…",
  livePaperTitle: "Live & paper trading",
  livePaperDescription: "Start with a saved strategy in paper mode, verify signals, then arm live execution only when keys and risk settings are ready.",
  chooseStrategy: "Choose a saved strategy",
  runPaper: "Run it on paper",
  reviewRisk: "Review logs, fills and risk",
  createPaperBot: "Create paper bot",
  newBot: "New bot",
  noBots: "No bots yet. Create one from a saved strategy.",
  settings: "Settings",
  newTradingBot: "New trading bot",
  runStrategy: "Run a strategy live or on paper",
  strategy: "Strategy",
  fromStrategy: "From strategy",
  botName: "Bot name",
  market: "Market",
  symbol: "Symbol",
  interval: "Interval",
  execution: "Execution",
  exchange: "Exchange",
  marketType: "Type",
  sizing: "Sizing",
  amount: "Amount",
  leverage: "Leverage",
  notifyMarkers: "Send a notification on signal markers",
  createBot: "Create bot",
  creating: "Creating…",
  pickStrategy: "Pick a strategy",
  strategyErrors: "Strategy has errors",
  createFailed: "Failed to create bot",
  noStrategies: "No saved strategies — build one first"
} as const;

type TradingMessageKey = keyof typeof en;

const ru: Record<TradingMessageKey, string> = {
  tradingLocked: "Торговля заблокирована",
  accessPrompt: "Введите административный токен для управления paper- и live-ботами. Публичные графики остаются доступны, а торговые действия защищены.",
  accessToken: "Токен доступа",
  invalidToken: "Неверный токен доступа.",
  checkingAccess: "Проверка доступа…",
  unlock: "Разблокировать",
  checking: "Проверка…",
  livePaperTitle: "Live и paper trading",
  livePaperDescription: "Начните с сохранённой стратегии в paper-режиме, проверьте сигналы и только затем разрешайте live-исполнение.",
  chooseStrategy: "Выберите сохранённую стратегию",
  runPaper: "Запустите её в paper-режиме",
  reviewRisk: "Проверьте журнал, сделки и риски",
  createPaperBot: "Создать paper-бота",
  newBot: "Новый бот",
  noBots: "Ботов пока нет. Создайте бота из сохранённой стратегии.",
  settings: "Настройки",
  newTradingBot: "Новый торговый бот",
  runStrategy: "Запуск стратегии в live- или paper-режиме",
  strategy: "Стратегия",
  fromStrategy: "Из стратегии",
  botName: "Название бота",
  market: "Рынок",
  symbol: "Символ",
  interval: "Интервал",
  execution: "Исполнение",
  exchange: "Биржа",
  marketType: "Тип",
  sizing: "Размер позиции",
  amount: "Объём",
  leverage: "Плечо",
  notifyMarkers: "Отправлять уведомления о сигналах",
  createBot: "Создать бота",
  creating: "Создание…",
  pickStrategy: "Выберите стратегию",
  strategyErrors: "В стратегии есть ошибки",
  createFailed: "Не удалось создать бота",
  noStrategies: "Нет сохранённых стратегий — сначала создайте стратегию"
};

const messages: Record<Locale, Record<TradingMessageKey, string>> = { en, ru };

export function tradingText(locale: Locale, key: TradingMessageKey) {
  return messages[locale][key];
}
