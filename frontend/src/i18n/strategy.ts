import type { Locale } from ".";

const en = {
  editorFailed: "Strategy editor did not start",
  indicator: "Indicator", strategy: "Strategy", gallery: "Gallery", import: "Import", pine: "Pine",
  browseTemplates: "Browse ready-made strategy templates", importStrategy: "Import a .strategy file",
  convertPine: "Convert a TradingView Pine Script into an indicator or strategy",
  invalidStrategy: "Not a valid .strategy file.", unreadableFile: "Could not read that file.",
  indicators: "Indicators", strategies: "Strategies", exportStrategy: "Export as .strategy file",
  galleryLabel: "Strategy template gallery", strategyGallery: "Strategy Gallery", close: "Close", closeGallery: "Close gallery", use: "Use",
  trend: "Trend", meanReversion: "Mean reversion", breakout: "Breakout", momentum: "Momentum",
  strategyLab: "Strategy Lab", example: "e.g.", loadingHistory: "Loading history…", runBacktest: "Run backtest",
  addNumericInput: "Add a numeric input block to enable optimization", optimizeParameters: "Optimize parameters",
  copyShareLink: "Copy share link", save: "Save", noNumericInputs: "This strategy has no numeric inputs to optimize. Add an input block first.",
  shareCopied: "Share link copied to clipboard", preview: "Preview", bytes: "bytes", connectBlocks: "Connect blocks to compile a strategy.",
  changesAutosave: "Changes autosave locally.", autosaved: "Autosaved",
  market: "Market", interval: "Interval", bars: "Bars", capital: "Capital", costPreset: "Cost preset", shorts: "Shorts",
  fee: "Fee %", slippage: "Slippage %", funding: "Funding %/8h", fundingHelp: "Perp funding / borrow cost per 8h a position is held (pro-rated to each bar)",
  fills: "Fills", nextOpen: "Next open", sameClose: "Same close", majorsTaker: "Majors / taker", altcoin: "Altcoin", custom: "Custom",
  optimizer: "Optimizer", combo: "combo", combos: "combos", min: "min", max: "max", step: "step", maxParameters: "Up to 3 parameters at once",
  objective: "Objective", trainPercent: "Train %", walkForwardShort: "Walk-fwd", folds: "Folds", walkForwardMode: "Mode", rolling: "Rolling", anchored: "Anchored", parameterStability: "Parameter stability", stable: "Stable", unstable: "Unstable", runOptimizer: "Run optimizer", optimizing: "Optimizing…",
  ranked: "Ranked", capped: "capped", params: "params", inSampleScore: "In-sample objective score", outSampleScore: "Out-of-sample objective score", apply: "Apply",
  insufficientWalkForward: "Not enough history to build walk-forward folds. Increase bars or reduce folds.", walkForward: "Walk-forward",
  outSampleNet: "OOS net", outSampleNetHelp: "Out-of-sample net profit", trades: "Trades", outSampleTrades: "Out-of-sample trades",
  winPercent: "Win%", outSampleWinRate: "Out-of-sample win rate", oosTrades: "OOS trades", win: "Win", maxDrawdownShort: "Max DD", final: "Final", finalEquity: "Final stitched OOS equity",
  objectiveNetProfit: "Net profit", objectiveProfitFactor: "Profit factor", objectiveSharpe: "Sharpe", objectiveReturnOverDd: "Return / MaxDD",
  backtest: "Backtest", showOnChart: "Show on chart", liquidated: "Account was liquidated — the run stopped early. Results below are truncated.",
  netProfit: "Net profit", winRate: "Win rate", profitFactor: "Profit factor", maxDrawdown: "Max drawdown", sharpe: "Sharpe", avgTrade: "Avg trade", timeInMarket: "Time in market", avgMae: "Avg MAE", avgMfe: "Avg MFE", fundingPaid: "Funding paid",
  variablesFinal: "Variables · final bar", tested: "Tested", warmup: "warm-up", testedHelp: "Bars measured after indicator warm-up", feeShort: "Fee", slipShort: "slip", maxShort: "max", nextOpenFills: "next-open fills", closeFills: "close fills", data: "Data", chartBars: "chart", securityBars: "security", warning: "warning", warnings: "warnings",
  provenanceFallback: "Synthetic or fallback market data was used. Performance claims are not valid for this run.",
  provenanceMixed: "Mixed or partially unverified market data was used. Performance claims are not valid for this run.",
  provenanceUnknown: "Market-data provenance is unknown. Performance claims are not valid for this run.", noCandleSources: "No candle sources were recorded",
  monteCarlo: "Monte Carlo", paths: "paths", riskOfRuin: "Risk of ruin", riskOfHalf: "Risk of -50%", start: "Start",
  noTrades: "No trades were triggered on this history. Check your entry condition.", direction: "Dir", long: "long", short: "short", entry: "Entry", exit: "Exit", reason: "Reason", equity: "Equity", equityCurve: "Equity curve", drawdown: "Drawdown", underwaterDrawdown: "Underwater drawdown",
  importPine: "Import Pine Script", pineHint: "Paste a TradingView Pine Script (v4–v6) or upload .pine files, then convert it. Each indicator() becomes an indicator and each strategy() becomes an editable strategy. Unsupported constructs are rejected with a clear reason.",
  loadPineFiles: "Load .pine file(s)", pastedScript: "Pasted script", convert: "Convert", artifact: "artifact", artifacts: "artifacts", add: "Add", converted: "converted", rejected: "rejected", approximations: "Compatibility diagnostics — review before trusting with money:", fidelity: "Fidelity", exact: "exact", approximation: "approximation", displayOnly: "display-only", profile: "profile", sourceLine: "line", remediation: "Action", pineSource: "Pine source", generatedBlocks: "Generated blocks", originalPineSource: "Original import evidence. Editing blocks does not rewrite this Pine source.", exportReport: "Export report", partialHistory: "Partially loaded history", dataGaps: "Missing bars", barReplay: "Bar replay", previousBar: "Previous bar", nextBar: "Next bar", replayPosition: "Replay position", jumpToEvent: "Jump to", eventFrame: "Signal / trade event", noEvents: "No events", someFilesUnreadable: "Some files could not be read.", skippedTooLarge: "skipped (too large)", couldNotRead: "could not read", skippedMaxFiles: "skipped (file limit)", remove: "Remove"
} as const;

export type StrategyMessageKey = keyof typeof en;

const ru: Record<StrategyMessageKey, string> = {
  editorFailed: "Редактор стратегий не запустился",
  indicator: "Индикатор", strategy: "Стратегия", gallery: "Галерея", import: "Импорт", pine: "Pine",
  browseTemplates: "Открыть готовые шаблоны стратегий", importStrategy: "Импортировать файл .strategy", convertPine: "Преобразовать TradingView Pine Script в индикатор или стратегию",
  invalidStrategy: "Это некорректный файл .strategy.", unreadableFile: "Не удалось прочитать файл.", indicators: "Индикаторы", strategies: "Стратегии", exportStrategy: "Экспортировать файл .strategy",
  galleryLabel: "Галерея шаблонов стратегий", strategyGallery: "Галерея стратегий", close: "Закрыть", closeGallery: "Закрыть галерею", use: "Использовать",
  trend: "Тренд", meanReversion: "Возврат к среднему", breakout: "Пробой", momentum: "Импульс",
  strategyLab: "Студия стратегий", example: "например", loadingHistory: "Загрузка истории…", runBacktest: "Запустить бэктест", addNumericInput: "Добавьте числовой входной блок, чтобы включить оптимизацию", optimizeParameters: "Оптимизировать параметры", copyShareLink: "Скопировать ссылку", save: "Сохранить", noNumericInputs: "В этой стратегии нет числовых входов для оптимизации. Сначала добавьте входной блок.", shareCopied: "Ссылка скопирована", preview: "Предпросмотр", bytes: "байт", connectBlocks: "Соедините блоки, чтобы скомпилировать стратегию.", changesAutosave: "Изменения сохраняются локально автоматически.", autosaved: "Автосохранение",
  market: "Рынок", interval: "Интервал", bars: "Свечи", capital: "Капитал", costPreset: "Профиль издержек", shorts: "Шорты", fee: "Комиссия %", slippage: "Проскальзывание %", funding: "Фандинг %/8ч", fundingHelp: "Фандинг бессрочного контракта или стоимость займа за 8 часов с пересчётом на каждую свечу", fills: "Исполнение", nextOpen: "Следующее открытие", sameClose: "То же закрытие", majorsTaker: "Основные пары / taker", altcoin: "Альткоины", custom: "Свой",
  optimizer: "Оптимизатор", combo: "комбинация", combos: "комбинаций", min: "мин.", max: "макс.", step: "шаг", maxParameters: "Одновременно можно выбрать до 3 параметров", objective: "Целевая метрика", trainPercent: "Обучение %", walkForwardShort: "Walk-forward", folds: "Фолды", walkForwardMode: "Режим", rolling: "Скользящий", anchored: "Расширяющийся", parameterStability: "Устойчивость параметров", stable: "Устойчиво", unstable: "Неустойчиво", runOptimizer: "Запустить оптимизацию", optimizing: "Оптимизация…", ranked: "Рейтинг", capped: "ограничено", params: "параметры", inSampleScore: "Значение метрики на обучающей выборке", outSampleScore: "Значение метрики вне выборки", apply: "Применить", insufficientWalkForward: "Недостаточно истории для walk-forward-фолдов. Увеличьте число свечей или уменьшите число фолдов.", walkForward: "Walk-forward", outSampleNet: "OOS результат", outSampleNetHelp: "Чистая прибыль вне выборки", trades: "Сделки", outSampleTrades: "Сделки вне выборки", winPercent: "Победы %", outSampleWinRate: "Доля прибыльных сделок вне выборки", oosTrades: "OOS-сделки", win: "Победы", maxDrawdownShort: "Макс. просадка", final: "Итог", finalEquity: "Итоговый объединённый OOS-капитал",
  objectiveNetProfit: "Чистая прибыль", objectiveProfitFactor: "Профит-фактор", objectiveSharpe: "Коэффициент Шарпа", objectiveReturnOverDd: "Доходность / макс. просадка",
  backtest: "Бэктест", showOnChart: "Показать на графике", liquidated: "Счёт ликвидирован — тест завершён досрочно. Результаты ниже обрезаны.", netProfit: "Чистая прибыль", winRate: "Доля прибыльных", profitFactor: "Профит-фактор", maxDrawdown: "Макс. просадка", sharpe: "Шарп", avgTrade: "Средняя сделка", timeInMarket: "Время в рынке", avgMae: "Средний MAE", avgMfe: "Средний MFE", fundingPaid: "Уплаченный фандинг", variablesFinal: "Переменные · последняя свеча", tested: "Проверено", warmup: "прогрев", testedHelp: "Свечи после прогрева индикаторов", feeShort: "Комиссия", slipShort: "проскальзывание", maxShort: "макс.", nextOpenFills: "исполнение на следующем открытии", closeFills: "исполнение на закрытии", data: "Данные", chartBars: "график", securityBars: "security", warning: "предупреждение", warnings: "предупреждений",
  provenanceFallback: "Использованы синтетические или резервные рыночные данные. Оценивать доходность по этому запуску нельзя.", provenanceMixed: "Использованы смешанные или частично непроверенные данные. Оценивать доходность по этому запуску нельзя.", provenanceUnknown: "Происхождение рыночных данных неизвестно. Оценивать доходность по этому запуску нельзя.", noCandleSources: "Источники свечей не зафиксированы",
  monteCarlo: "Монте-Карло", paths: "траекторий", riskOfRuin: "Риск разорения", riskOfHalf: "Риск потери 50%", start: "Старт", noTrades: "На этой истории сделок нет. Проверьте условие входа.", direction: "Напр.", long: "лонг", short: "шорт", entry: "Вход", exit: "Выход", reason: "Причина", equity: "Капитал", equityCurve: "Кривая капитала", drawdown: "Просадка", underwaterDrawdown: "График просадки",
  importPine: "Импорт Pine Script", pineHint: "Вставьте TradingView Pine Script (v4–v6) или загрузите файлы .pine. Каждый indicator() станет индикатором, а strategy() — редактируемой стратегией. Неподдерживаемые конструкции отклоняются с понятной причиной.", loadPineFiles: "Загрузить файл(ы) .pine", pastedScript: "Вставленный скрипт", convert: "Преобразовать", artifact: "артефакт", artifacts: "артефакта(ов)", add: "Добавить", converted: "преобразовано", rejected: "отклонено", approximations: "Диагностика совместимости — проверьте перед использованием с реальными средствами:", fidelity: "Точность", exact: "точно", approximation: "приближённо", displayOnly: "только отображение", profile: "профиль", sourceLine: "строка", remediation: "Что сделать", pineSource: "Исходный Pine", generatedBlocks: "Созданные блоки", originalPineSource: "Исходник импорта сохранён как подтверждение. Изменение блоков не переписывает Pine-код.", exportReport: "Экспорт отчёта", partialHistory: "История загружена частично", dataGaps: "Пропущенные свечи", barReplay: "Повтор по свечам", previousBar: "Предыдущая свеча", nextBar: "Следующая свеча", replayPosition: "Позиция повтора", jumpToEvent: "Перейти к", eventFrame: "Сигналу / сделке", noEvents: "Нет событий", someFilesUnreadable: "Некоторые файлы не удалось прочитать.", skippedTooLarge: "пропущено (слишком большой размер)", couldNotRead: "не удалось прочитать", skippedMaxFiles: "пропущено (лимит файлов)", remove: "Удалить"
};

const messages: Record<Locale, Record<StrategyMessageKey, string>> = { en, ru };

export function strategyText(locale: Locale, key: StrategyMessageKey): string {
  return messages[locale][key] ?? en[key];
}

export function strategyNumber(locale: Locale, value: number): string {
  return value.toLocaleString(locale === "ru" ? "ru-RU" : "en-US");
}

export function strategyCategory(locale: Locale, category: string): string {
  const keys: Record<string, StrategyMessageKey> = { Trend: "trend", "Mean reversion": "meanReversion", Breakout: "breakout", Momentum: "momentum" };
  return keys[category] ? strategyText(locale, keys[category]) : category;
}

export function strategyObjective(locale: Locale, objective: string): string {
  const keys: Record<string, StrategyMessageKey> = { netProfit: "objectiveNetProfit", profitFactor: "objectiveProfitFactor", sharpe: "objectiveSharpe", returnOverDd: "objectiveReturnOverDd" };
  return keys[objective] ? strategyText(locale, keys[objective]) : objective;
}
