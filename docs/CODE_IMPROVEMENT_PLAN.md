# Code Improvement Plan

Дата: 2026-07-10

Основание: внешний аудит из беседы "Обзор и улучшение кода" и точечная проверка текущего дерева проекта.

## Выполнено 2026-07-10

- Trading engine теперь передает в market-data layer явные route options: `exchange`, `marketType`, `priceType`, `strict`.
- Binance/Bybit public providers различают spot и futures/linear candles; Bybit futures больше не получает spot feed по умолчанию.
- Market events каждого бота обрабатываются последовательно через per-bot queue; дублирующий websocket update одного закрытого бара не запускает повторную оценку стратегии.
- Live spot стартует fail-closed без `ENABLE_LIVE_SPOT` / `liveSpotEnabled`, пока не реализован полноценный inventory model.
- Bybit futures entry с `stop` / `takeProfits` вызывает `/v5/position/trading-stop`; если защита отклонена, entry закрывается и возвращается ошибка.
- Paper slippage исправлен: buy всегда исполняется хуже вверх, sell всегда хуже вниз, включая exits.
- Backtest проверяет stop/target уже на свече входа при `next_open`.
- REST providers помечают текущую формирующуюся свечу как `final:false`, чтобы candle store не сохранял её как закрытую историю.
- Frontend history loading получил `AbortController` и generation guard, чтобы старые запросы после смены symbol/timeframe/exchange не загрязняли новый chart state.
- Trade WebSocket больше не отправляет новый token в URL query; frontend передает его через websocket subprotocol. Trading token мигрирован из persistent `localStorage` в tab-scoped `sessionStorage`.
- Chart engine кэширует расчеты индикаторов на один и тот же массив candles, поэтому crosshair/drawing redraw не пересчитывает SMA/EMA/RSI/MACD без новых свечей.
- Strategy/Indicator Studio получил artifact `version`/`hash`; сохранение связанного индикатора переносит `logicVersion`/`logicHash` обратно в chart indicator.
- Добавлен durable order journal: таблицы `orders` / `order_events`, REST endpoints и UI-блок в торговой панели бота.
- Live/manual execution теперь пишет intent/result/fill events в журнал ордеров через `clientOrderId`.
- Добавлен базовый startup reconciliation для live-ботов: при resume сверяются exchange position/open orders и локальный managed state; при расхождении бот уходит в paused/fail-safe режим.
- Binance/Bybit spot `closePct` больше не превращается в `1 / price`: adapter запрашивает base balance и закрывает процент от фактического доступного base asset.
- Browser auth переведен на HttpOnly `sbv2_session` cookie + CSRF для mutating trade endpoints; admin token больше не сохраняется в web storage.
- `/trade-stream` перешел на короткоживущий одноразовый WS ticket; token-in-query больше не принимается.
- Добавлены CSP / browser hardening headers для bundled SPA.
- Добавлены роли `read-only`, `paper-trade`, `live-trade`, `admin` с отдельными env-токенами и permission gates на trade endpoints.
- Добавлен `audit_log` для mutating trade API calls; секретные поля в body редактируются перед сохранением.
- Runtime paused/requires-action состояние теперь сохраняется в `state:<botId>` и возвращается через `liveState` как `runtimeStatus` / `pauseReason`.
- ProviderRouter теперь делает fan-out live subscriptions: один upstream stream на `(exchange, marketType, priceType, symbol, timeframe)` обслуживает несколько UI/бот subscribers.

## Короткий вывод

Проект уже выглядит как сильная alpha-версия: есть собственный canvas-график, Blockly/IR, backtest, paper/live режимы, базовая авторизация, Docker, CI, сохранение стратегий и рабочий UX вокруг графика. Но live trading нельзя позиционировать как production-ready, пока не доказаны инварианты исполнения ордеров, защиты позиции и восстановления после сбоя.

Главная цель ближайших этапов:

> Сделать платформу не просто аналогом TradingView, а воспроизводимой open-source лабораторией, где один и тот же сигнал одинаково объясняется в chart preview, backtest, replay, paper и live.

## Что уже частично закрыто

- Появилась строгая схема IR в `backend/src/trading/strategy/irSchema.ts`: неизвестные node-типы отклоняются, есть лимиты на глубину, размер и массивы. Это закрывает часть риска "произвольный JSON вместо IR", но нужно проверить, что все API-входы реально идут через `parseStrategyIR`.
- Есть `strict` режим для live data, который запрещает synthetic fallback для живых ботов.
- Есть сохранение части runtime-состояния бота: `vars`, `managed`, `lastBarTime`.
- Есть exchange-side protection для Bybit futures через `trading-stop`; следующий шаг - private/order-stream подтверждения, lifecycle статусы и reconciliation по реальным order IDs.
- Есть roadmap и тестовая база, но формулировку "safety-critical layers are done" нужно считать слишком сильной до закрытия release gates ниже.

## Release Blockers

### P0.1. Явный MarketKey во всех data и execution потоках

Текущая проверка:

- `ProviderRouter` умеет принимать `{ exchange }`.
- `TradingEngine.start()` передает только `{ strict }` в `getCandles()` и `subscribe()`.
- Если `exchange` не передан, роутер выбирает Binance по умолчанию.

Риск: Bybit-бот может принимать свечи Binance, а исполнять ордера через Bybit.

Что делаем:

- Ввести единый `MarketKey`:

```ts
interface MarketKey {
  venue: "binance" | "bybit";
  marketType: "spot" | "linear" | "inverse";
  symbol: string;
  timeframe: Timeframe;
  priceType: "last" | "mark" | "index";
}
```

- Передавать `exchange: config.exchange` и `marketType: config.market` во все market-data запросы.
- Убрать дефолт "если не указано, то Binance" из trading-контекста.
- Добавить тест: Bybit live/paper-like bot не получает Binance provider events.

Acceptance:

- В логах и тестах каждый `MarketEvent` содержит `MarketKey`.
- Бот не стартует, если `MarketKey` неполный.
- Для futures используется futures/linear feed, а не spot REST/WS.

### P0.2. Exchange-side stop/take-profit должны быть подтверждены

Текущая проверка:

- Engine проставляет `order.stop` и `order.takeProfits` для live futures.
- `BybitAdapter.createOrder()` после entry вызывает `/v5/position/trading-stop`.
- Если protection rejected, adapter пытается закрыть entry и возвращает ошибку.
- Полной state machine с private order/fill stream и проверкой exchange-side protection по order IDs еще нет.

Риск: позиция может быть открыта без защитного стопа, хотя engine думает, что защита есть.

Что делаем:

- Ввести order lifecycle:

```text
ENTRY_SUBMITTED
ENTRY_CONFIRMED
PROTECTION_SUBMITTED
PROTECTION_CONFIRMED
OPEN_PROTECTED
OPEN_UNPROTECTED
EXITING
ERROR
```

- Bybit/Binance adapters должны возвращать ID entry, SL, TP orders.
- `OPEN_PROTECTED` разрешен только после проверки активных exchange orders.
- Если protection не создана, позиция закрывается или бот уходит в fail-safe state.

Acceptance:

- Тест с fake exchange: entry accepted, stop rejected -> bot не считает позицию защищенной.
- Live/testnet dry run показывает созданные SL/TP order IDs.

### P0.3. Per-bot serial queue и idempotency

Текущая проверка:

- `onCandle()` запускает `void this.onClosedBar(...).finally(...)`.
- Пока async-обработка бара идет, следующий update той же свечи может снова увидеть старый `last`.
- `onTick()` тоже запускается async и может повторно закрывать позицию до завершения первого close.

Риск: один закрытый бар или серия тиков могут создать повторный entry/exit intent.

Что делаем:

- Каждый бот получает single-thread actor queue.
- Хранить `lastEvaluatedBarTime`, `orderInFlight`, `lastIntentId`, `lastClientOrderId`.
- Все market events проходят через очередь, а не через параллельные `void` calls.
- На timeout сначала искать order по `clientOrderId`, а не отправлять второй order.

Acceptance:

- Тест "duplicate closed candle" создает максимум один intent.
- Тест "close in flight + повторный tick" создает максимум один close.
- Повторный запуск после timeout не открывает дублирующую позицию.

### P0.4. Spot inventory model

Текущая проверка:

- `closePosition()` для spot создает `neworder` с `closePct: 100`.
- Binance/Bybit adapters теперь запрашивают base balance и превращают `closePct` в процент от доступного base asset.
- `position()` для spot все еще не восстанавливает bot-attributed lots, avg price и комиссии.

Риск: `close 100%` закрывает неправильный объем.

Что делаем:

- До готового inventory model выключить live spot отдельным feature flag.
- Для spot хранить bot-attributed lots: base quantity, avg price, fees, remaining qty.
- При закрытии запрашивать balances и фильтры symbol metadata.
- Округлять по lot size и сверять остаток после fill.

Acceptance:

- Тест: bot купил 0.25 BTC, close 100% продает 0.25 BTC с учетом step size.
- Нельзя включить live spot без `ENABLE_LIVE_SPOT=true` и подтвержденного inventory model.

### P0.5. Durable order/fill journal и real PnL

Текущая проверка:

- Добавлены таблицы `orders` / `order_events` и API/UI для durable order journal.
- Live adapters часто возвращают `fills: []`.
- Daily-loss guard считает локальные fills, но не подтвержденные private exchange fills.

Риск: лимит дневного убытка не знает реального PnL, комиссий и partial fills.

Что делаем:

- Таблицы: `orders`, `order_events`, `fills`, `positions`, `strategy_runs`.
- Сохранять `clientOrderId`, `exchangeOrderId`, status transitions, partial fills, fee asset, realized PnL.
- Добавить private user-data stream или polling fallback.
- Daily-loss guard считает только подтвержденные real fills.

Acceptance:

- Тест partial fill обновляет qty, avg price и realized PnL.
- Тест daily loss использует реальные fill events, а не локальное предположение.

### P0.6. Startup reconciliation

Текущая проверка:

- Состояние `vars` и `managed` восстанавливается.
- Добавлена базовая сверка с exchange position и open orders при resume live-бота.
- Еще нет полной сверки recent fills, order lifecycle фаз и ручного `REQUIRES_MANUAL_ACTION` статуса перед `running`.

Риск: после рестарта бот может не совпадать с биржей и открыть/закрыть не то.

Что делаем:

- Перед запуском live bot вводим фазу `SYNCING`.
- Сверяем persisted state, exchange position, open orders, recent fills.
- При расхождении переводим в `REQUIRES_MANUAL_ACTION`.

Acceptance:

- Restart во время `ENTERING`, `OPEN_UNPROTECTED`, `EXITING` восстанавливает корректный state.
- Бот не получает `running`, пока reconciliation не завершен.

## High Priority Improvements

### Backtest, paper и preview parity

- Исправить paper slippage, чтобы exit тоже ухудшал цену.
- Проверять stop/target на свече входа при `next_open`.
- Исправить preview, если он показывает сигналы из `if` без проверки условия.
- Вынести общий evaluator/fill model в shared packages.

Acceptance: один event trace дает одинаковый результат в preview explanation, backtest и paper simulation.

### Market data correctness

- Не сохранять незакрытую REST-свечу как финальную.
- Для candle store хранить `knownRemoteStart`, `fullyBackfilledUntil`, `lastVerifiedAt`.
- Выбрать один snapshot path: REST snapshot + WS updates или WS snapshot + updates.
- Добавить `AbortController` / generation ID для `loadOlder()` после смены symbol.
- Уже сделано: один upstream WS на `(exchange, marketType, priceType, symbol, timeframe)` с fan-out на UI и ботов.

### Chart performance

- Разделить renderer на слои: grid, candles, indicators, drawings, crosshair.
- Crosshair не должен пересчитывать индикаторы.
- Indicator cache должен обновляться инкрементально.
- Тяжелые TA-расчеты вынести в Web Worker.
- Watchlist перевести на quote stream и виртуализацию.

### Security для публичного доступа

- Уже сделано: trading token не хранится в `localStorage` / `sessionStorage`, browser-flow использует HttpOnly session cookie, CSRF и одноразовый WS ticket.
- Уже сделано: CSP headers для bundled SPA, audit log для state-changing endpoints, roles/permissions: read-only, paper-trade, live-trade, admin.
- В production docs явно требовать TLS reverse proxy, `COOKIE_SECURE=1`, firewall и секретный `AUTH_TOKEN`.

### Strategy and Indicator Studio

- Страница "Стратегии" должна быть не только бот-конструктором, а студией стратегий и индикаторов.
- Индикатор, добавленный на график, должен открываться в редакторе с загруженной логикой.
- Сохранение должно создавать версию: `indicatorId`, `version`, `inputs`, `style`, `irHash`.
- Для каждого встроенного индикатора нужен открываемый blueprint: SMA, EMA, Bollinger, RSI, MACD.
- Пользовательские индикаторы должны компилироваться в тот же IR и проходить те же лимиты, что стратегии.

Acceptance: пользователь открывает Bollinger с графика, меняет period/color/logic, сохраняет версию и видит обновление на графике без перезагрузки.

## Первые 12 PR

| PR | Тема | Готово, когда |
| --- | --- | --- |
| 1 | `MarketKey` в provider/router/engine/API | Bybit bot не может получить Binance candles |
| 2 | Per-bot actor queue | Один бар создает максимум один order intent |
| 3 | Exchange-side protection confirmation | `OPEN_PROTECTED` только после подтвержденных SL/TP |
| 4 | Live spot feature flag | Неполный spot execution нельзя включить случайно |
| 5 | Spot inventory accounting | `close 100%` закрывает реальный base qty |
| 6 | Durable order/fill journal | Partial fills, fees и PnL сохраняются |
| 7 | Startup reconciliation | Live bot стартует только после сверки с биржей |
| 8 | Shared `strategy-core` | Frontend/backend используют один IR/evaluator |
| 9 | Shared `execution-core` | Backtest/paper используют одну fill/slippage модель |
| 10 | MarketHub fan-out | Один upstream feed обслуживает график и ботов |
| 11 | Chart incremental indicators | Redraw не пересчитывает все индикаторы |
| 12 | Public security hardening | Session cookie, WS ticket, CSP, audit log |

## Product Positioning

Не стоит обещать "мы сразу лучше TradingView во всем". Сильное позиционирование:

> Open-source, local-first trading workstation для исследования, визуального конструирования, backtest, replay, paper/live исполнения и объяснимого аудита каждого сигнала.

Что берем как ориентир:

- У TradingView берем скорость графика, привычные drawing tools, multi-pane UX, alerts, replay.
- У Deriv Bot Builder берем понятную пошаговую структуру: market setup, conditions, purchase/entry, risk, restart/exit, analysis.
- У Blockly берем визуальное программирование, но скрываем сырой `if/else` там, где трейдеру понятнее доменные блоки: "когда RSI ниже 30", "цена пересекла SMA", "после 3 убыточных сделок остановить".

Что делаем своим преимуществом:

- Версионированный IR.
- Воспроизводимый run manifest.
- Одинаковая логика для indicator, strategy, backtest, paper и live.
- Локальное владение данными.
- Полный order/fill audit trail.

## Release Invariants

Перед публичным live-релизом тесты должны доказывать:

1. Один бар не создает два одинаковых ордера.
2. Bybit-бот не принимает Binance data events.
3. Позиция не считается защищенной без подтвержденного exchange stop.
4. После рестарта local state совпадает с биржей.
5. Daily-loss limit считается по реальным fills.
6. Timeout order submission не открывает повторную позицию.
7. Partial fill корректно меняет qty и PnL.
8. `close 100%` закрывает реальный объем.
9. Backtest и paper совпадают на одном trace.
10. Каждый run воспроизводится по сохраненному manifest.
