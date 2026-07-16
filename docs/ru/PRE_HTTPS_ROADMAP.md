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

### 2.1. Формат исполнения и актуальный статус

Этот документ является не списком пожеланий, а release ledger. Для каждого
релиза в issue/PR/коммите фиксируются шесть полей:

1. **Baseline** — что уже существует и на каком evidence level.
2. **Remaining delta** — только ещё не реализованная работа.
3. **Dependencies** — схема, worker, данные и предыдущие release gates.
4. **Evidence** — тест, миграция, screenshot, load artifact, restore drill или
   runbook, подтверждающий результат.
5. **Exit criteria** — измеримое условие завершения без формулировки «вроде
   работает».
6. **Status** — `done`, `active`, `pending` или `blocked` с причиной.

Нельзя переносить уже существующую функцию в колонку новой разработки и повторно
оценивать её как greenfield. Нельзя считать browser-delivered прототип готовым
серверным контуром, а research-only engine — paper execution.

| Релиз | Статус | Реализованный baseline | Главный remaining delta | Обязательное evidence |
| --- | --- | --- | --- | --- |
| R0 | done | Research/Paper hard gate | только сопровождение | security suites + runtime diagnostics |
| R1 | done | permits, execution ledger, bounded PostgreSQL queue, retention, ADR | future-live blockers остаются вне pre-HTTPS | migration/backup/restore + green CI |
| R2 | active | компактная mobile navigation, полностью закрываемый Volume Profile, безопасная price axis, collapsed screener до 760 px и полноширинный Strategy Studio | завершить drawing-tools, gestures, landscape и полную 320–1440/browser matrix | Chromium touch E2E + Firefox journeys + visual comparison |
| R3 | pending | auth/registration/admin roles и PostgreSQL owner-scoped workspace CRUD/revisions/409/rollback | полный user lifecycle, frontend workflow payload, quotas, import/export и onboarding | two-tenant isolation + migration + recovery CLI |
| R4 | pending | browser Running/portfolio center и owner-scoped paper/dormant legacy records | канонический paper-account, capital reservation, PnL/reconciliation и journal UX | golden ledger + restart/partial-fill tests |
| R5 | pending | research alert/outbox slices, arbitrage screener, canonical indicators | unified alerts, technical screener MVP, notification worker и Telegram | scheduler/outbox crash tests + alert/chart parity |
| R6 | pending | общий paper execution foundation частично существует | общий paper contract + DCA | deterministic replay + capital invariants |
| R7 | pending | foundation R6 | Grid на том же ledger/state machine | gap/restart/golden replay |
| R8 | pending | богатый read-only spread/arbitrage research baseline | durable multi-leg paper intent, leg risk и unwind | two-leg/multi-leg replay + clock/freshness gates |
| R9 | pending | parameter GA, structural generator и pure multi-market ranker | server multi-market evaluation, Pareto/OOS promotion, checkpoints | seeded reproducibility + owner-fair queue |
| R10A | pending | upload/in-memory L2 ML research baseline | online collector, bounded storage, funding/OI/MTF и календарный soak | bytes/sec/disk forecast + retained replay corpus |
| R10B | pending | baseline model/features | durable dataset/model registry, promotion/rollback, drift UI | champion/challenger + replayable inference |
| R11 | pending | bounded API/worker/auth foundations | измеримый integrated 100-user proof и failure drills | load report + RPO/RTO + 30% headroom |
| R12 | pending | текущие self-hosting и backup docs | fresh clone, coordinated restore, upgrade compatibility и итоговый audit | clean-host smoke artifacts |

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

Статус: фундамент 1A-1E реализован и протестирован. Production-подключение
private/live намеренно отсутствует: routes и adapters используют deny-only authorizer,
а текущая сборка отклоняет `private-live` до любых startup side effects. Это не
заявление о готовности live.

### 1A. Типизированная конфигурация

Задачи:

- один immutable-объект конфигурации для сервера и фоновых процессов;
- строгий разбор boolean, integer, URL, origin, proxy trust, путей и TTL;
- неизвестное или противоречивое значение останавливает запуск;
- секреты никогда не попадают в diagnostics/logs;
- типы и чистая проверка будущей HTTPS-границы `private-live` сохранены, но
  операторского пути активации нет: текущий loader всегда отклоняет это значение.

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
- каждый точный шаг резервируется в durable owner-scoped ledger до handoff и
  consume выполняется до сетевого callback;
- disarm, отключение пользователя, смена роли/аккаунта или revision отзывают permit;
- emergency разрешает только cancel и доказуемый reduce-only;
- в `public-http-paper` risk-increasing permit не выдаётся вообще.

Критерий: forged, expired, reused, cross-owner и wrong-capability permit дают ноль
сетевых вызовов. Фундамент интегрирован и протестирован, но production routes/adapters
намеренно не подключены к нему и остаются deny-only.

Обязательные security blockers будущего `private-live`:

- отзыв полномочий либо сначала завершает durable cancel/reduce-only de-risking, либо передаёт его
  отдельному аутентифицированному owner-scoped системному emergency principal;
- archive/partition lookup для replay keys сохраняет проверку exact-step duplicate и гарантирует,
  что lifetime cap владельца не исчерпает возможность emergency или reconciliation.

На текущий `public-http-paper` эти блокеры не влияют: `private-live` отклоняется до startup side
effects, а все production signed adapters остаются deny-only. До будущего live activation оба
блокера должны быть реализованы и пройти отдельный security review.

### 1E. Минимальный worker/queue foundation

До серверных алертов и тяжёлых исследований вводятся:

- отдельный ограниченный worker process для jobs, а не вычисления в HTTP handler;
- durable queue/lease, idempotency key, retry/backoff и graceful recovery;
- per-owner concurrency, timeout, result-size, CPU и memory quotas;
- request/job correlation id, queue depth, duration и failure counters;
- полные terminal-артефакты ограничены первым достигнутым лимитом: 30 дней,
  200 jobs или 256 MiB на владельца; exact-request tombstone — 90 дней и
  максимум 1 000 на владельца;
- применить уже принятое ADR: PostgreSQL хранит identity, sessions, workspaces,
  jobs и tenant alert/outbox; единственный fenced executor владеет защищённой
  SQLite с accounts/credentials/bots/execution journals; cross-store команды
  проходят через durable PostgreSQL command ID и идемпотентный SQLite ACK.

Решение зафиксировано в [ADR по полномочиям исполнения и system of record](ADR_EXECUTION_AUTHORITY.md).

Критерий: worker crash не сбрасывает job и не останавливает login/chart API;
второй запуск одного job не создаёт второй результат.

## 6. R2 — мобильный график и компактная навигация

Статус: active.

Baseline: профиль объёма больше не включён по умолчанию, полностью закрывается и
удаляется; indicator strip зарезервировал область price axis; верхняя мобильная
навигация компактна; режимы скринера имеют collapsible trigger с contained
labels до 760 px; coarse-pointer controls имеют размер не меньше 44×44 px;
Strategy Studio использует одну полноширинную панель. Remaining delta: завершить
drawing-tools sheet, orientation/gesture state machine, dense mobile cards и
полную device/browser матрицу без регрессии уже исправленной геометрии.

Оставшиеся задачи UI:

- заменить скрытый drawing rail кнопкой **Инструменты** не меньше 44×44 px;
- открыть все desktop-инструменты в bottom sheet с поиском/группами;
- рядом с графиком оставить active tool, undo, redo, delete и object list;
- добавить режимы жестов: pan, long-press inspect/crosshair, draw и pinch;
- корректно обрабатывать `pointercancel` и смену ориентации;
- добавить `viewport-fit=cover` и safe-area для верхней/нижней панели;
- data-dense таблицы превращаются в карточки; полная таблица доступна отдельно.

Матрица проверки:

- 320×568, 360×800, 390×844, 430×932;
- граничные CSS-ширины 600, 760 и 761 px;
- mobile landscape;
- 768×1024 и 1024×768;
- 1440×900;
- Android Chromium touch context и ручной Opera smoke;
- клавиатура, screen reader smoke и масштаб текста 200%;
- нулевой horizontal page overflow, полный dismiss editor/dialog, доступность
  последней кнопки indicator strip и touch targets не меньше 44×44 px.

Критерий: на каждом размере доступны цена, управление индикаторами, рисунками и
стратегией; ни один control не лежит поверх шкалы цены или другого control.

## 7. R3 — жизненный цикл пользователя, рабочие пространства и первый запуск

Статус: pending hardening. Baseline: PostgreSQL auth, pending registration,
admin activation/role management, а также owner-scoped PostgreSQL workspace
CRUD, optimistic revision conflicts, `409`, rollback и максимум 20 revisions уже
существуют. Remaining delta: завершить единый frontend workflow document,
полный жизненный цикл пользователя, quotas/import/export UX и onboarding без
доступа администратора к tenant-owned product data.

### Жизненный цикл пользователя и администратора

- состояния `pending → active → disabled`, безопасная reactivation и отдельные
  роли `read-only`/`paper-trade`; live-permission в pre-HTTPS UI отсутствует;
- активация не даёт пользователю доступ к чужим paper accounts, workspaces,
  jobs, alerts, journals или Telegram bindings;
- список owner sessions, принудительный logout и отзыв всех sessions при disable
  или смене роли; останавливается только работа этого owner;
- guarded CLI для сброса admin password, защита последнего администратора и
  обязательная смена bootstrap password;
- export/archive/delete пользователя с retention policy и отдельным подтверждением;
- audit всех admin actions; оператор видит агрегированные метрики и состояние
  квот, но не содержимое приватного workspace пользователя.

### Сохранённый workflow

- owner-scoped workspace: layout, символы, timeframe, timezone, индикаторы,
  параметры, рисунки, панели и выбранная стратегия;
- автосохранение с version/revision и явным состоянием `Сохранено/Ошибка`;
- список, rename, duplicate, archive, import/export;
- восстановление последней рабочей области после входа;
- conflict-safe обновление между двумя вкладками;
- шаблоны `Мониторинг`, `Исследование`, `Backtest`, `Paper robot`.
- schema version, optimistic concurrency и понятный conflict-resolution UX;
- одноразовый owner-scoped перенос local storage без удаления исходника до ACK;
- строгая проверка import-файла, лимит размера workspace, числа revisions и
  общего storage на owner;
- определённое поведение autosave при offline, 409 conflict, quota и server error.

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

## 8. R4 — экран «Запущено» и paper-портфель

Статус: pending. Baseline: browser Running center, owner-scoped bots/accounts,
portfolio reads и explicit empty/loading/error states уже есть. Remaining delta:
каноническая paper-account модель и доказуемая аналитика поверх общего ledger.

Paper-account contract:

- initial capital, accounting currency, available/reserved capital и owner limits;
- несколько paper-ботов не могут дважды зарезервировать один капитал;
- paper account не содержит exchange API keys и не смешивается с live account;
- manual paper order, DCA, Grid и spread используют один order/fill/state contract;
- формулы PnL/funding/fees versioned; reconciliation сверяет orders, fills,
  reservations и snapshots после restart/partial fill/unknown evidence;
- при incomplete evidence операция и метрика маркируются `Недоступно`, а не нулём.

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

Критерий: totals до и после restart совпадают, каждая метрика имеет определённую
формулу, evidence и время, а второй tenant или администратор не может прочитать
или изменить чужой paper-портфель.

## 9. R5 — алерты, технический скринер MVP и уведомления

Статус: pending integration. Baseline: отдельные research/arbitrage alert rules,
durable at-least-once outbox, canonical candle/indicator engines и read-only
арбитражный скринер уже существуют. Remaining delta: technical screener MVP,
одна canonical tenant alert model, общий scheduler и отдельная
capability-separated доставка.

### Технический скринер MVP

Фильтры:

- price, volume, change и liquidity;
- RSI, moving-average cross, MACD, ATR и market structure;
- позже funding, OI и ML/order-book signals после R10A/R10B.

Архитектура:

- один canonical candle/indicator engine с графиком;
- bounded universe и server batches вместо socket на каждую пару;
- owner-scoped presets, sorting, pagination и run history;
- freshness/unavailable не проходят фильтр как обычное значение;
- клик открывает тот же symbol/timeframe/indicator context на графике;
- сохранённый screen превращается в серверный alert;
- расписание запуска ограничено квотами.

### Алерты и доставка

Типы:

- цена выше/ниже и пересечение уровня;
- RSI, MACD, EMA/SMA cross и составные условия;
- пересечение trend line/horizontal line;
- stale data, остановка paper-бота, drawdown и исчерпание paper-капитала;
- результат сохранённого technical screen.

Backend:

- одна каноническая модель alert rule/version/state;
- вычисление по закрытой свече по умолчанию;
- durable scheduler + outbox + lease + retry/backoff;
- dedupe key на переход состояния;
- source venue, event time, receive time, freshness и provenance;
- квоты числа правил, символов, timeframe и вычислений на пользователя;
- in-app history и Telegram; Web Push отложен до HTTPS;
- Telegram credentials не передаются research-worker. Доставку выполняет
  отдельный project-owned notification worker без публичного HTTP listener; он
  читает только PostgreSQL outbox, минимальный owner/channel scope и секрет из
  собственного защищённого environment file;
- revoke binding проверяется перед каждой попыткой; payload содержит event ID и
  deduplication ID; transport остаётся at-least-once, поэтому после crash внешний
  Telegram API теоретически может получить повторную доставку.

Telegram в paper-only режиме:

- owner-scoped привязка chat через одноразовый код, просмотр привязок и немедленный
  revoke из веб-интерфейса;
- `/balance` возвращает только paper balance; также доступны `/daily`, `/profit`,
  `/performance`, `/trades`, `/alerts`;
- `/pause`, `/resume`, `/stop` только для своих paper-ботов и с подтверждением;
- никакой передачи токенов, ключей или приватной биржевой телеметрии.

Критерий: значение скринера совпадает с графиком на той же закрытой свече; алерт
работает с закрытым браузером, переживает рестарт, создаёт одну логическую
event/outbox запись на переход и не раскрывает чужие presets, rules или
доставки. Повтор внешней Telegram-доставки после crash допустим только с тем же
deduplication ID.

## 9.1. Общий paper execution gate для DCA, Grid и spread

До релиза любого нового paper-робота должны быть готовы:

- единый durable ledger и versioned state machine;
- capital reservation/release и owner/global concurrency limits;
- deterministic fee/slippage/fill model и golden replay fixtures;
- idempotent restart, partial fill и unknown/reconciliation transitions;
- одна event schema для Running, analytics, alerts и export.

## 10. R6 — DCA paper-робот

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

## 11. R7 — Grid paper-робот

- arithmetic/geometric grid, bounds и число уровней;
- neutral/long/short paper modes;
- inventory, capital и order-count limits;
- recenter, outside-range pause, stop conditions и cooldown;
- partial fill, gap, fee и restart handling;
- отдельные realized grid PnL, inventory PnL и total drawdown;
- preview уровней на графике до запуска.

Критерий: ценовой gap не создаёт бесконечный каскад, рестарт не дублирует уровни и
резервы, а worst-case capital виден до подтверждения.

## 12. R8 — торговля спредом и поиск неэффективностей (paper)

Статус: pending delta поверх delivered read-only baseline. Уже существуют
spot/perpetual, triangular, native spread, funding/options research, freshness,
depth/economics и paper-ledger slices. Не считается готовым: durable объединённое
multi-leg paper исполнение, общий capital reservation, partial-fill leg risk и
unwind/reconciliation.

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

## 13. R9 — генератор стратегий и генетический оптимизатор

Статус: pending delta. Уже реализованы bounded seeded parameter GA, structural
IR generator, mutation/crossover/deduplication и pure multi-market ranker на
caller-supplied metrics. Remaining delta: server-owned candle evaluation,
portfolio capital pool, Pareto/OOS promotion, lineage storage и checkpoint/resume.

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

## 14. R10A — корпус L2, funding/OI/ликвидации и MTF

Статус: pending delta. Baseline: admin-only upload/in-memory L2 reconstruction,
quality gates и отдельные public sequence/checksum-aware adapters уже существуют.
Нет online collector, durable corpus и принятого календарного soak.

### Сбор корпуса L2

- sequence-aware L2 snapshots/deltas и trades;
- gap detection, reconnect boundaries и clock calibration;
- bounded retention, compression и downsampling;
- venue/symbol/market schema и quality score;
- лицензирование и политика хранения для каждого источника.
- до включения ingest фиксируются bytes/sec, network и прогноз disk/day/month;
- данные пишутся только в project-owned path с soft/hard high-watermarks;
- hard watermark автоматически останавливает ingest до заполнения общего диска;
- retention/downsampling проверяются restore/replay тестом, а не только config;
- отдельный календарный soak нужен для накопления репрезентативных режимов рынка;
  его нельзя заменить параллельным CPU.

### Funding, OI, ликвидации и MTF

- публичные Binance/Bybit funding history/countdown;
- open interest в нормализованных contract/base/quote units;
- liquidation feed с фильтром минимального размера;
- venue/event/receive timestamps, provenance и freshness;
- reconnect gaps и unavailable states;
- выбор source timeframe для EMA/SMA/RSI и других индикаторов;
- только завершённые higher-timeframe candles, без lookahead;
- тяжёлые series считаются вне UI thread;
- retention/downsampling ограничены.

Критерий: retained window воспроизводимо replay-ится, каждый gap виден машине,
storage остаётся в configured bounds, MTF совпадает с offline reference, а stale
derivatives data визуально и в API отличается от нормального нуля.

## 15. R10B — ML-анализ поведения участников в стакане

Статус: pending после принятого R10A corpus. Baseline: admin-only in-memory
research уже имеет past-only features, purged chronological split, ridge
baseline и exact-scope inference. Нет durable dataset/model registry,
promotion/rollback, drift UI и production inference loop.

Первый релиз — только исследовательская классификация, без обещаний определить
реальную личность участника и без автоматической live-торговли.

### Признаки, baseline и модель

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
- label/ground-truth policy, durable dataset/model registry и immutable lineage;
- champion/challenger promotion, rollback и operator approval;
- inference-latency/drift SLO и автоматический переход в abstain/degraded;

UI:

- heatmap/лента событий рядом со стаканом;
- confidence, horizon, quality и объясняющие признаки;
- фильтр по типу поведения;
- воспроизводимый replay исследовательского окна.

Критерий: gap/stale data не порождает сигнал; модель не маркирует событие как факт,
если это только вероятностная интерпретация.

## 16. R11 — архитектура и operational proof для примерно 100 активных пользователей

Хранилища:

- выполнить принятое ADR без повторного выбора: PostgreSQL — identity, sessions,
  workspaces, jobs, alerts/outbox и durable commands; один fenced executor —
  единственный владелец защищённой SQLite accounts/credentials/bots/journals;
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

- зафиксированный mix для 100 active sessions: число shared market subscriptions,
  открытых charts/WS, alert rules, scheduled screens, paper bots и submissions/min;
- отдельно steady state, 5–10 minute burst и не менее 2 часов soak;
- global caps для WS clients/buffers, queued/running jobs, paper bots, alerts,
  technical screens и L2 ingest; per-owner limit не заменяет global limit;
- weighted fairness между interactive, backtest, optimizer и ML;
- PostgreSQL pool budget суммирует API + workers и оставляет operator reserve;
- фиксируются WAL/database growth, network traffic и backup duration;
- рабочая цель API p95 < 300 мс, жёсткий release gate ≤ 400 мс; p95 внутренней доставки
  chart update после ingest ≤ 500 мс, error rate приложения < 1% без ошибок
  upstream, p95 event-loop lag ≤ 50 мс;
- p95 ожидания интерактивного job ≤ 5 с, тяжёлого backtest/optimizer ≤ 30 с при
  целевом mix; индивидуальные CPU/memory/time limits фиксируются в конфигурации;
- фиксируются также p50/p99, RAM, CPU, disk growth и queue saturation;
- worker crash и restart не влияют на login/chart;
- второй API instance не раздваивает состояние;
- после теста остаётся не менее 30% RAM/disk и устойчивого CPU headroom, а не
  только прохождение среднего load.
- документируются RPO/RTO и drills: worker kill, PostgreSQL restart, upstream
  outage, slow WS client, disk high-watermark и coordinated PostgreSQL+SQLite restore;
- второй API разрешён только после extraction singleton executor, durable
  lease/fencing и cross-process event fan-out.

## 17. R12 — документация, воспроизводимый self-hosting и итоговый аудит

Статус: pending final pre-HTTPS consolidation. Baseline: EN/RU/KK документация,
generated API references, migrations, backup/restore, release packaging,
secret scan и rollback tooling уже существуют.

Remaining delta:

- синхронизировать API, architecture, configuration, security, threat model,
  self-hosting, user guides и screenshots с реально отгруженными R2–R11 contracts;
- описать все quotas, workers, retention policies, at-least-once delivery
  boundary, L2/model gates, capacity results и recovery decisions;
- выполнить fresh clone → project-owned PostgreSQL → bootstrap admin →
  mandatory password change → migrations → sample workspace/screener/backtest/
  paper robot → backup → isolated restore → upgrade;
- проверить Docker Compose и direct-host paths без изменения чужих портов, БД,
  контейнеров или сервисов;
- опубликовать migration/rollback note и machine-readable evidence index.

Критерий: новый оператор воспроизводит Research/Paper систему и её восстановление
только по документации; SSL/TLS, HTTPS и live activation отсутствуют и не
заявляются.

## 18. Порядок релизов и зависимости

Оценка относится только к remaining delta, а не повторно к уже реализованному
baseline. После каждого release она пересматривается по фактической скорости и
обнаруженным migration/soak рискам.

| Релиз | Remaining scope | Зависит от | Первичная оценка delta, person-weeks | Exit gate |
| --- | --- | --- | ---: | --- |
| R2 | mobile chart/navigation/Strategy Studio remaining matrix | R1 | 2–3 | 320–1440 + touch + visual green |
| R3 | user lifecycle, server workspaces, onboarding/PWA boundary | R1–R2 | 3–5 | two-tenant isolation + fresh account journey |
| R4 | Running, paper account/portfolio, metrics/journal | R1–R3 | 3–5 | golden ledger + restart reconciliation |
| R5 | unified alerts, technical screener MVP, notification worker/Telegram | R3–R4 | 5–7 | chart parity + at-least-once outbox drill |
| R6 | common paper engine completion + DCA | R4–R5 | 3–4 | deterministic DCA replay |
| R7 | Grid на общем paper engine | R4–R6 | 4–5 | gap/restart/capital proof |
| R8 | durable spread/multi-leg paper execution | R4–R5 | 4–6 | leg-risk/unwind replay |
| R9 | multi-market generator/genetic server pipeline | R1 + canonical IR/dataset/backtest | 5–8 | seeded OOS/Pareto promotion |
| R10A | funding/OI/MTF + bounded L2 collector/storage | R1 + public data contracts | 3–5 + 4–8 календарных недель soak | storage forecast + corpus quality |
| R10B | ML registry/model/UI | R10A corpus | 5–8 | promotion/rollback/drift proof |
| R11 | integrated 100-user capacity proof | accepted workload contracts | 5–9 | SLO/headroom/RPO/RTO report |
| R12 | fresh clone, coordinated restore, upgrade, docs/final audit | R2–R11 | 2–4 | clean-host self-host smoke |

R9 и подготовку R10A можно вести параллельно после общих worker/data contracts.
Нельзя параллельно менять одну state machine или одну migration chain без
назначенного integration owner. HTTPS/live остаются отдельным будущим проектом.

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
