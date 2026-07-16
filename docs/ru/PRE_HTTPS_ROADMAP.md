# Подробный план разработки до появления HTTPS

Статус документа: рабочий план публичного развёртывания SaltanatbotV2 в режиме
**Research / Paper**. HTTPS, ввод биржевых API-ключей, приватные потоки аккаунта и
отправка реальных ордеров в этот план не входят.

> Важно: HTTP не защищает логин, пароль и session cookie от перехвата. До HTTPS
> экземпляр нельзя считать безопасным для доступа через недоверенную публичную
> сеть. Используйте private network/VPN/IP allowlist либо отдельные тестовые
> пароли, которые нигде больше не применяются. Research/Paper блокирует реальные
> ордера, но не шифрует транспорт.

Каноническая краткая версия: [PRE_HTTPS_ROADMAP.md](../PRE_HTTPS_ROADMAP.md).

## 1. Жёсткая граница безопасности

До отдельного релиза с HTTPS сервер работает только с
`RUNTIME_PROFILE=public-http-paper`.

Разрешено:

- регистрация, вход, активация администратором и изоляция пользователей;
- публичные котировки, графики, индикаторы и стакан;
- сохранённые рабочие пространства, стратегии, бэктест и оптимизация;
- paper-роботы, paper-портфель, исследовательские алерты и Telegram-уведомления;
- скринеры, анализ спредов и ML-исследования на публичных данных.

Текущий baseline уже включает PostgreSQL-аутентификацию, регистрацию, активацию
администратором и owner-scoped сессии. Администратор управляет активацией и
ролями, но это не даёт ему автоматического доступа к workspace, журналу,
paper-портфелю или Telegram-каналу пользователя.

Запрещено независимо от роли пользователя:

- ввод, изменение и проверка биржевых API-ключей;
- подписанные REST-запросы и приватные WebSocket-потоки;
- реальные ордера, займы, погашения, collateral, leverage/margin/position mode;
- отображение приватного баланса, маржи или позиций биржевого аккаунта;
- обход запрета через UI, Telegram, восстановление после перезапуска или прямой
  вызов адаптера.

Существующие зашифрованные данные не удаляются. Они остаются сохранёнными, но не
используются до отдельного HTTPS-релиза и нового security review.

## 2. Правила выполнения каждого этапа

Каждый этап считается законченным только после выполнения всех пунктов:

1. Перед изменением схемы создаётся проверяемая резервная копия только данных
   этого проекта.
2. Все tenant-owned записи имеют `ownerId`; запросы и фоновые задачи проверяются
   тестами на межпользовательскую изоляцию. Общие публичные market-data/cache и
   reference rows безопасно переиспользуются между пользователями.
3. Миграции только добавляющие или обратимые; пользовательские данные не
   удаляются автоматически.
4. Публичные API имеют схемы входа/выхода, лимиты размера, rate limit и стабильные
   коды ошибок.
5. Тяжёлая работа выполняется в ограниченной очереди, а не в HTTP-процессе.
6. Пользовательский интерфейс поддерживает RU/EN/KK, клавиатуру, 200% текста и
   основные мобильные размеры.
7. Проходят typecheck, lint, unit/integration, build, docs, architecture, PWA,
   performance и secret scan; для UI также Chromium E2E, Firefox journeys и
   visual regression.
8. Обновляются self-hosting, backup/restore и rollback-инструкции.
9. Не создаются новые порты, контейнеры или базы вне ресурсов SaltanatbotV2.
10. Готовый этап фиксируется отдельным понятным коммитом в `main` после зелёных
    локальных проверок и затем проверяется GitHub Actions.
11. Fresh-clone smoke подтверждает install → project-owned PostgreSQL/bootstrap
    admin → обязательную смену пароля → migrations → health → sample paper run →
    backup → restore → upgrade. Перед запуском проверяются занятые порты; чужие
    БД, контейнеры и сервисы не изменяются.

## 3. Целевая схема продукта до HTTPS

Пользователь видит четыре понятных верхнеуровневых раздела:

1. **Мониторинг** — графики, индикаторы, рисунки, сохранённые рабочие пространства.
2. **Автоматизация** — Strategy Studio, генератор, бэктест, оптимизатор и paper-боты.
3. **Скринеры** — технический, спредовый/арбитражный и ML-анализ стакана.
4. **Запущено** — активные paper-стратегии, PnL, капитал, риск, журнал и управление.

На мобильном показываются компактные вкладки или одна кнопка текущего раздела с
bottom sheet. Большие панели фильтров и вариантов по умолчанию свёрнуты.

Поток данных:

```text
Публичные биржевые данные
        ↓
Нормализация + контроль свежести
        ↓
График / индикаторы / скринеры / ML-признаки
        ↓
Стратегия → детерминированный backtest/replay
        ↓
Paper execution → журнал → метрики → алерты/Telegram
```

## 4. Этап 0 — принудительный Research / Paper режим

Статус: реализован.

Результат:

- профиль запуска неизменяем и загружается до БД и listener;
- создание, запуск, возобновление и восстановление live-ботов блокируются;
- блокировка стоит в HTTP, Telegram, engine и у последней сетевой границы;
- публичные данные, график, бэктест и paper-боты продолжают работать;
- UI явно показывает `Research / Paper`, а форма робота не предлагает live;
- ранее сохранённые live-флаги обезвреживаются без удаления записей.

## 5. Этап 1 — фундамент исполнения без включения live

Статус: 1A-1C реализованы в текущем релизе; 1D-1E остаются в плане. Поэтому
профиль по-прежнему только `public-http-paper`, это не заявление о готовности live.

### 1A. Типизированная конфигурация

Задачи:

- один immutable-объект конфигурации для сервера и фоновых процессов;
- строгий разбор boolean, integer, URL, origin, proxy trust, путей и TTL;
- неизвестное или противоречивое значение останавливает запуск;
- секреты никогда не попадают в diagnostics/logs;
- будущий `private-live` описан, но не может активироваться без HTTPS-условий.

Критерий: изменение `process.env` после загрузки не меняет поведение процесса, а
ошибка конфигурации возникает до открытия БД, создания файлов и порта.

### 1B. Fail-stop master key

Задачи:

- ключ создаётся атомарно только для действительно новой торговой БД;
- существующая БД без корректного ключа не запускается и не получает новый ключ;
- запрещены symlink, directory, чужой владелец и открытые group/other permissions;
- до записи проверяется расшифровка каждой существующей encrypted-строки;
- backup с encrypted-строками невозможен без соответствующего `.secret`;
- команда inventory показывает только количество записей, без секретов.

Критерий: потеря или подмена ключа оставляет БД неизменной и выдаёт оператору
понятную инструкцию восстановления.

### 1C. Проверенные правила инструмента

Задачи:

- точное сопоставление native symbol и проверка торгового статуса;
- min/max quantity, market quantity, step, tick, min/max notional и price bounds;
- точная десятичная арифметика без потери малых шагов;
- ограниченный TTL-кэш и fingerprint набора правил;
- полная подготовка entry, SL и всех TP до первой биржевой мутации;
- отсутствие, неполнота или устаревание правил приводит к fail-closed.

Критерий: некорректные правила дают ноль подписанных запросов; paper-исполнение
использует ту же нормализацию, но не требует live-permit.

### 1D. Capabilities и одноразовые execution permits

Задачи:

- разделить public read, private read, entry, protection, reduce-only, cancel,
  account settings и debt actions;
- короткоживущий одноразовый permit связывает owner, account, credential revision,
  bot/emergency operation, venue, market, symbol, действие, risk effect, intent,
  authorization epoch, rules fingerprint, nonce и expiry;
- permit проверяется на engine→adapter и непосредственно перед signed I/O;
- disarm, отключение пользователя, смена роли/аккаунта или revision отзывают permit;
- emergency разрешает только cancel и доказуемый reduce-only;
- в `public-http-paper` risk-increasing permit не выдаётся вообще.

Критерий: forged, expired, reused, cross-owner и wrong-capability permit дают ноль
сетевых вызовов. Этот этап укрепляет будущий live-контур, но не включает его.

### 1E. Минимальный worker/queue foundation

До серверных алертов и тяжёлых исследований вводятся:

- отдельный ограниченный worker process для jobs, а не вычисления в HTTP handler;
- durable queue/lease, idempotency key, retry/backoff и graceful recovery;
- per-owner concurrency, timeout, result-size, CPU и memory quotas;
- request/job correlation id, queue depth, duration и failure counters;
- ADR с окончательным решением: единый PostgreSQL system of record либо
  PostgreSQL outbox + формально описанная reconciliation с legacy SQLite.

Критерий: worker crash не сбрасывает job и не останавливает login/chart API;
второй запуск одного job не создаёт второй результат.

## 6. Этап 2 — мобильный график и компактная навигация

Задачи UI:

- заменить скрытый drawing rail кнопкой **Инструменты** не меньше 44×44 px;
- открыть все desktop-инструменты в bottom sheet с поиском/группами;
- рядом с графиком оставить active tool, undo, redo, delete и object list;
- добавить режимы жестов: pan, long-press inspect/crosshair, draw и pinch;
- корректно обрабатывать `pointercancel` и смену ориентации;
- добавить `viewport-fit=cover` и safe-area для верхней/нижней панели;
- индикаторные чипы, сравнение, timezone и шкала цены не перекрывают друг друга;
- профиль объёма закрывается целиком и открывается из общего меню индикаторов;
- крупные панели скринера сворачиваются стрелкой/кнопкой **Параметры**;
- окно Strategy Studio на телефоне занимает полную ширину, без обрезанной половины;
- data-dense таблицы превращаются в карточки; полная таблица доступна отдельно.

Матрица проверки:

- 360×800, 390×844, 430×932;
- mobile landscape;
- 768×1024 и 1024×768;
- 1440×900;
- клавиатура, screen reader smoke и масштаб текста 200%.

Критерий: на каждом размере доступны цена, управление индикаторами, рисунками и
стратегией; ни один control не лежит поверх шкалы цены или другого control.

## 7. Этап 3 — рабочие пространства и первый запуск

### Сохранённый workflow

- owner-scoped workspace: layout, символы, timeframe, timezone, индикаторы,
  параметры, рисунки, панели и выбранная стратегия;
- автосохранение с version/revision и явным состоянием `Сохранено/Ошибка`;
- список, rename, duplicate, archive, import/export;
- восстановление последней рабочей области после входа;
- conflict-safe обновление между двумя вкладками;
- шаблоны `Мониторинг`, `Исследование`, `Backtest`, `Paper robot`.

### Онбординг

- выбор цели пользователя;
- короткий маршрут до первого графика, алерта, backtest или paper-робота;
- empty states с одним следующим действием и ссылкой на документацию;
- прогресс хранится на сервере по ownerId;
- ни на одном шаге не запрашиваются API-ключи.

### PWA

- 192×192, 512×512, maskable и Apple touch icons;
- строгая CI-проверка manifest;
- install/update UX только при поддержке браузера и secure context;
- на публичном IP по HTTP не показывать неработающую установку;
- offline research bundle только на `localhost` или в secure context; на
  публичном HTTP остаётся обычный экспорт файла без обещания PWA/offline.

Критерий: новый пользователь без инструкции создаёт первое полезное research/paper
действие, а после перезапуска возвращается в свой workspace.

## 8. Этап 4 — серверные алерты

Типы:

- цена выше/ниже и пересечение уровня;
- RSI, MACD, EMA/SMA cross и составные условия;
- пересечение trend line/horizontal line;
- stale data, остановка paper-бота, drawdown и исчерпание paper-капитала;
- результат сохранённого скринера после появления технического скринера на
  этапе 12; до этого алерт поддерживает только уже существующие research rules.

Backend:

- одна каноническая модель alert rule/version/state;
- вычисление по закрытой свече по умолчанию;
- durable scheduler + outbox + lease + retry/backoff;
- dedupe key на переход состояния;
- source venue, event time, receive time, freshness и provenance;
- квоты числа правил, символов, timeframe и вычислений на пользователя;
- in-app history и Telegram; Web Push отложен до HTTPS.

Критерий: алерт работает с закрытым браузером, переживает рестарт и не дублирует
одно событие; пользователь не видит чужие правила и доставки.

## 9. Этап 5 — экран «Запущено», аналитика и Telegram

Экран **Запущено**:

- честное пустое состояние: «У вас пока нет запущенных paper-стратегий»;
- фильтры по paper-портфелю, workspace, стратегии, символу и состоянию;
- status, uptime, paper balance/equity/margin, realized/unrealized PnL, fees,
  simulated funding, exposure, reserved capital, drawdown и последняя ошибка;
- быстрые pause/resume/stop с подтверждением;
- detail: equity curve, fills, orders, events, warnings и параметры версии;
- mobile cards + sticky summary; desktop table + detail drawer.

Метрики:

- versioned formulas для win rate, profit factor, expectancy, max drawdown;
- расчёт только из durable fills/snapshots;
- idempotent backfill;
- неполные данные показываются как `Недоступно`, а не как ложный ноль;
- сверка с golden ledgers и restart tests.

Telegram в paper-only режиме:

- owner-scoped привязка chat через одноразовый код, просмотр привязок и немедленный
  revoke из веб-интерфейса;
- `/balance` возвращает только paper balance; также доступны `/daily`, `/profit`,
  `/performance`, `/trades`, `/alerts`;
- `/pause`, `/resume`, `/stop` только для своих paper-ботов и с подтверждением;
- никакой передачи токенов, ключей или приватной биржевой телеметрии.

## 10. Этап 6 — DCA paper-робот

Параметры:

- base order, safety orders, price deviation;
- step scale, volume scale и максимальное число safety orders;
- TP, SL, trailing exit, cooldown и лимит длительности;
- лимит общего и зарезервированного paper-капитала;
- long/short только в рамках поддерживаемой paper-модели.

Реализация:

- одна явная state machine для backtest, replay и paper execution;
- до запуска — maximum-capital и worst-case summary;
- deterministic fill/fee/slippage model;
- idempotency key на каждый переход и восстановление после рестарта;
- события и метрики попадают в общий журнал роботов.

Критерий: один price path даёт одинаковый replay/paper результат; лимиты и правила
инструмента невозможно превысить.

## 11. Этап 7 — Grid paper-робот

- arithmetic/geometric grid, bounds и число уровней;
- neutral/long/short paper modes;
- inventory, capital и order-count limits;
- recenter, outside-range pause, stop conditions и cooldown;
- partial fill, gap, fee и restart handling;
- отдельные realized grid PnL, inventory PnL и total drawdown;
- preview уровней на графике до запуска.

Критерий: ценовой gap не создаёт бесконечный каскад, рестарт не дублирует уровни и
резервы, а worst-case capital виден до подтверждения.

## 12. Этап 8 — торговля спредом и поиск неэффективностей (paper)

Исследовательские модели:

- spot↔perpetual одного инструмента;
- cross-exchange spot/perpetual;
- native exchange spreads;
- triangular routes;
- funding scenarios;
- options parity как отдельный research-модуль;
- live-маршруты только наблюдаются, ордера не отправляются.

Нормализация:

- bid/ask, depth, fees, funding, borrow assumptions, transfer/network cost;
- exchange/event/receive timestamps и clock quality;
- executable size, slippage ladder и stale/gap state;
- gross spread отдельно от net forecast;
- confidence и причина отбраковки каждой строки.

Paper spread execution:

- две ноги создаются одной durable intent-группой;
- моделируются leg risk, partial fill, latency и unwind;
- лимит капитала, venue, symbol и одновременных попыток;
- kill switch только paper;
- результат входит в общий журнал и аналитику.

UI:

- компактная кнопка выбора типа скринера;
- панель параметров свёрнута по умолчанию на мобильном;
- результат показывает не только процент, но объём, свежесть, качество времени,
  комиссии и причины недоступности.

Критерий: ни одна возможность не называется исполнимой без достаточной глубины и
свежести; paper PnL включает обе ноги и все смоделированные расходы.

## 13. Этап 9 — генератор стратегий и генетический оптимизатор

Представление кандидата:

- только валидный versioned Strategy IR, без произвольного кода;
- алгоритмический генератор является базовым и не требует OpenAI или другого
  внешнего AI-сервиса; возможная AI-подсказка позже подключается только как
  необязательный BYO-провайдер и обязана пройти ту же IR-валидацию;
- индикаторы, параметры, entry/exit, risk, timeframe и universe;
- жёсткие constraints на глубину дерева, число условий и вычислительный бюджет.
- до первого evolutionary run фиксируются canonical Strategy IR, versioned
  dataset contract и воспроизводимый backtest engine.

Генетические операции:

- mutation параметров, индикатора, оператора, timeframe и risk rule;
- crossover совместимых поддеревьев;
- add/remove condition с обязательной повторной валидацией;
- repair invalid candidate или явное отклонение;
- seeded PRNG для полной воспроизводимости.

Отбор:

- multi-objective: return, drawdown, Sharpe/Sortino, stability, turnover и
  complexity penalty;
- walk-forward и out-of-sample обязательны;
- защита от lookahead, leakage и duplicate candidates;
- Pareto frontier вместо одного «магического» score;
- сохраняются seed, dataset fingerprint, engine version и lineage.

Мультивалютность:

- один общий capital pool;
- лимиты корреляции, symbol exposure и portfolio drawdown;
- train/validation/test делятся по времени, а не случайно;
- survivorship и delisted-symbol policy документируются.

Очереди:

- отдельные workers;
- per-owner concurrency, CPU time, memory, population и generation quotas;
- cancel/timeout/checkpoint/resume;
- interactive API и график не блокируются оптимизацией.

Критерий: одинаковый seed и dataset дают одинаковый результат; лучший кандидат не
может быть опубликован без out-of-sample отчёта и признаков переобучения.

## 14. Этап 10 — ML-анализ поведения участников в стакане

Первый релиз — только исследовательская классификация, без обещаний определить
реальную личность участника и без автоматической live-торговли.

### 10A. Сбор корпуса данных

- sequence-aware L2 snapshots/deltas и trades;
- gap detection, reconnect boundaries и clock calibration;
- bounded retention, compression и downsampling;
- venue/symbol/market schema и quality score;
- лицензирование и политика хранения для каждого источника.
- отдельный календарный soak нужен для накопления репрезентативных режимов рынка;
  его нельзя заменить параллельным CPU.

### 10B. Признаки, baseline и модель

- imbalance по нескольким уровням;
- microprice, spread, depth slope и replenishment;
- add/cancel/trade intensity;
- absorption, sweep, spoof-like и iceberg-like patterns как вероятностные сигналы;
- regime, volatility и liquidity context.

Модельный контур:

- baseline rules и статистическая модель до сложного ML;
- time-based validation, calibration, drift monitoring;
- precision/recall по классам, false-positive rate и confidence;
- versioned feature schema/model/dataset fingerprint;
- explainable evidence window для каждого события;
- abstain/unknown при плохих данных или низкой уверенности.

UI:

- heatmap/лента событий рядом со стаканом;
- confidence, horizon, quality и объясняющие признаки;
- фильтр по типу поведения;
- воспроизводимый replay исследовательского окна.

Критерий: gap/stale data не порождает сигнал; модель не маркирует событие как факт,
если это только вероятностная интерпретация.

## 15. Этап 11 — funding, OI, ликвидации и MTF

- публичные Binance/Bybit funding history/countdown;
- open interest в нормализованных contract/base/quote units;
- liquidation feed с фильтром минимального размера;
- venue/event/receive timestamps, provenance и freshness;
- reconnect gaps и unavailable states;
- выбор source timeframe для EMA/SMA/RSI и других индикаторов;
- только завершённые higher-timeframe candles, без lookahead;
- тяжёлые series считаются вне UI thread;
- retention/downsampling ограничены.

Критерий: MTF совпадает с offline reference, stale derivatives data визуально и в
API отличается от нормального нуля.

## 16. Этап 12 — технический скринер и автоматизация

Фильтры:

- price, volume, change и liquidity;
- RSI, moving-average cross, MACD, ATR;
- market structure;
- позже funding, OI и ML/order-book signals.

Архитектура:

- один canonical candle/indicator engine с графиком;
- bounded universe и server batches вместо socket на каждую пару;
- owner-scoped presets, sorting, pagination и run history;
- freshness/unavailable не проходят фильтр как обычное значение;
- клик открывает тот же symbol/timeframe/indicator context на графике;
- сохранённый screen превращается в серверный alert;
- расписание запуска ограничено квотами.

Критерий: значение скринера совпадает со значением на графике на той же закрытой
свече; пресеты и результаты изолированы между пользователями.

## 17. Этап 13 — архитектура для примерно 100 активных пользователей

Хранилища:

- выполнить принятое на этапе 1E ADR: один transactional system of record либо
  PostgreSQL outbox + формальная reconciliation с legacy SQLite;
- до миграции — WAL, busy timeout, integrity checks и bounded retention;
- ownerId, revision, idempotency key и audit event на денежных/роботных переходах;
- проверяемые миграции и restore drills.

Процессы:

- API/login/chart traffic отдельно от backtest/optimizer/ML workers;
- очередь с per-owner fairness, concurrency, timeout, memory и result-size quota;
- backpressure вместо неограниченного накопления;
- graceful shutdown, lease recovery и idempotent retry;
- общий resilient public WebSocket primitive.

Наблюдаемость:

- structured logs с request/job/bot correlation id;
- latency, error rate, queue depth, worker saturation, stream freshness;
- health/readiness и отдельные degraded состояния;
- retention для логов/метрик без секретов и персональных данных;
- операторский runbook для overload, stuck job и recovery.

Capacity-проверка:

- профиль примерно 100 активных пользователей;
- mix: chart streams, screeners, alerts, paper bots и тяжёлые backtests;
- начальные SLO для проверки: p95 обычного API ≤ 400 мс, p95 внутренней доставки
  chart update после ingest ≤ 500 мс, error rate приложения < 1% без ошибок
  upstream, p95 event-loop lag ≤ 50 мс;
- p95 ожидания интерактивного job ≤ 5 с, тяжёлого backtest/optimizer ≤ 30 с при
  целевом mix; индивидуальные CPU/memory/time limits фиксируются в конфигурации;
- фиксируются также p50/p99, RAM, CPU, disk growth и queue saturation;
- worker crash и restart не влияют на login/chart;
- второй API instance не раздваивает состояние;
- после теста остаётся не менее 30% RAM/disk и устойчивого CPU headroom, а не
  только прохождение среднего load.

## 18. Порядок релизов и зависимости

| Релиз | Состав | Зависит от | Оценка, person-weeks |
| --- | --- | --- | ---: |
| R1 | Этап 1: safety + minimal workers/ADR | Этап 0 (готов) | 1–3 |
| R2 | Этапы 2–3: mobile, navigation, workspace, PWA/onboarding | R1 | 3–5 |
| R3 | Этапы 4–5: alerts, «Запущено», analytics, Telegram | R1–R2 | 5–7 |
| R4 | Этап 6: DCA paper | R3 | 3–4 |
| R5 | Этап 7: Grid paper | R3–R4 | 4–5 |
| R6 | Этап 8: spreads/inefficiencies paper | R3 | 4–6 |
| R7 | Этап 9: generator/genetic optimizer | R1 + canonical IR/backtest | 5–8 |
| R8 | Этап 10A: L2 capture/storage/quality | R1 + data contracts | 3–5 + 4–8 календарных недель soak |
| R9 | Этап 10B: ML baseline/model/UI | R8 corpus | 5–8 |
| R10 | Этап 11: derivatives/MTF | data normalization | 5–7 |
| R11 | Этап 12: technical screener/automation | alerts + canonical indicators | 4–6 |
| R12 | Этап 13: consolidation/capacity proof | ADR + все нагрузки | 5–9 |

Оценки включают реализацию, тесты, документацию, миграции и стабилизацию. Части R6,
R7 и R8 можно вести параллельно после появления общих worker/data contracts, но
нельзя параллельно менять одну и ту же state machine или схему без отдельного
интеграционного этапа.

## 19. Что сознательно отложено до HTTPS

В этом плане нет задач «временно включить live». После появления HTTPS потребуется
отдельный план и отдельное решение владельца проекта:

- TLS termination, домен, HSTS и secure-cookie deployment review;
- закрытая форма API-ключей, rotation/revocation и redaction audit;
- приватные WebSocket и signed REST conformance;
- testnet soak 7–14 дней;
- incident/kill-switch drill;
- минимальные live-лимиты и ручное разрешение на аккаунт;
- только после этого — отдельное обсуждение mainnet.

До завершения этих работ весь пользовательский продукт остаётся полезным и
самодостаточным как open-source платформа мониторинга, исследований, бэктеста,
оптимизации и paper-автоматизации.
