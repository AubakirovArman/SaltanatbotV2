# Канонические paper-портфели (R4)

Аудитория: операторы self-hosted установки, разработчики и интеграторы API
Статус: принят и развёрнут в production 2026-07-17

Принятые production evidence: commit `bb455facdfe5a1b3cabe15490c86c299ea684ee7`, GitHub Actions
run `29560112312` со всеми 6 успешными required jobs, protected slot
`r4c-schema12-bb455fa`, PostgreSQL schema 12 и trading SQLite schema 9. Для этого exact release
приняты paired backup/verify/isolated-restore/drill evidence и post-migration recovery generation.

Каноническая английская версия: [PAPER_PORTFOLIOS.md](../PAPER_PORTFOLIOS.md).

Этот runbook описывает pre-HTTPS контур paper-портфелей принятого R4 release. Он работает только с
`RUNTIME_PROFILE=public-http-paper`. Здесь нет настройки TLS, ввода биржевых API-ключей, приватных
потоков, реальных ордеров, займов или изменения настоящей маржи.

> Обычный HTTP не защищает пароль и session cookie при передаче. Держите HTTP-установку на
> loopback либо за доверенной private network/VPN и строгим IP allowlist. Paper-only профиль
> запрещает live-исполнение, но не шифрует транспорт.

## Что является каноническим

Paper-портфель принадлежит ровно одному авторизованному пользователю. Текущий snapshot имеет версию
`paper-portfolio-v1`, формулы — `paper-metrics-v1`. Singleton trading executor строит snapshot из
своего SQLite-хранилища, а не из browser state и не из реального баланса биржи.

Модель связывает:

- владельца;
- portfolio и его optimistic revision;
- монотонный ledger epoch;
- robot и неизменяемую revision робота;
- резерв капитала USDT с шестью знаками после точки;
- mutation ID, ключ идемпотентности и request hash;
- durable paper-ledger events и ограниченные по свежести valuation marks.

Значения, зависящие от рыночной отметки, содержат evidence state и время наблюдения. Отсутствующая
или протухшая отметка даёт `unavailable` либо `stale`, но не ложный ноль. Borrowing в
`paper-portfolio-v1` явно `unavailable`. Margin — значение paper-модели, а не телеметрия биржи.

## Хранилища и authority

R4 использует два хранилища и один fenced bridge:

| Хранилище | Каноническая ответственность | Schema R4 |
| --- | --- | --- |
| PostgreSQL | owner/session, authorization revision/epoch и durable очередь executor-команд | 12 |
| `backend/data/trading.db` | portfolio/epochs/reservations, robot revisions, orders/fills/events, marks, projections и terminal receipts | SQLite 9 |

Browser отправляет команду в PostgreSQL. В ней находятся нормализованная paper-конфигурация,
идентификаторы owner/target, idempotency key и hashes; JSON-ключи, похожие на секреты, отклоняются.
Singleton executor берёт по одной команде владельца под возобновляемой lease, заново проверяет
активную session и точные authorization revision/epoch, затем применяет команду в SQLite. Подтвердить
PostgreSQL-строку может только актуальная lease token/generation.

SQLite сохраняет terminal mutation receipt в одной транзакции с изменением портфеля. Если процесс
остановился после SQLite commit, но до PostgreSQL acknowledgement, следующий claim использует
только точное совпадение owner, command ID, idempotency key и request hash и подтверждает уже
применённый receipt до повторной проверки authorization. Это исключение умеет только согласовать
ранее применённую операцию: без точного receipt актуальная authorization обязательна и mutation не
выполняется. Повтор того же idempotency key с другим запросом — конфликт, а не новая команда. При
старте persisted robots полностью восстанавливаются до claim очереди и до открытия HTTP listener.

Этот bridge не разрешает несколько API/executor replicas. Для одного `trading.db` работает ровно
один API process. Research worker использует PostgreSQL и не должен открывать trading SQLite.
Shutdown сначала запрещает новую executor-работу, затем дожидается active callback либо отправляет
abort. Если callback игнорирует abort и остаётся активным, shutdown fail-closed отказывается
останавливать engine или закрывать SQLite под выполняющейся операцией.

## Lifecycle портфеля

Пользователь с ролью `paper-trade` может:

1. Создать активный USDT paper-портфель с положительным initial capital.
2. Выбрать один активный portfolio по умолчанию.
3. Переименовать его с текущими revision и ledger epoch.
4. Атомарно зарезервировать капитал при создании paper-робота.
5. Запустить, приостановить, продолжить и остановить точную revision через durable queue.
6. Архивировать portfolio только после освобождения активных allocations.
7. Сбросить flat-портфель с точным подтверждением имени.

Reset закрывает текущий epoch и создаёт следующий. Старый epoch, robot revision evidence, orders,
fills и events не удаляются. Роботов старого epoch необходимо привязать заново; сервер не переносит
старую revision на новый капитал молча.

Executor-side primitive удаления released/closed paper-робота сохраняет immutable tombstone и
журнал; database-auth compatibility HTTP delete остаётся заблокированным, пока canonical
flat-release workflow не проведён end to end. Только в legacy token mode `DELETE` может атомарно
освободить allocation и удалить обновлённого paper-робота, если replay его точного ledger
подтверждает initialized flat position, отсутствие open orders и капитал, представимый в fixed
micros; иначе возвращается conflict без изменений. Runtime status не создаёт новую revision
стратегии и не переписывает immutable evidence.

При переходе на SQLite 9 каждый найденный legacy paper-бот получает отдельный deterministic
portfolio и epoch 1. Существующий event ledger остаётся источником accounting. Если доступен только
legacy snapshot/formula, миграция создаёт deterministic initialization ledger и помечает epoch как
`legacy-incomplete`; projection обязана сохранять это ограничение evidence.

## Workflow в браузере

После активации учётной записи и выдачи paper-доступа откройте **Торговля → Запущено / Paper
портфели**. Экран содержит:

- честное пустое состояние без portfolio/robot;
- create, rename, default, archive и reset;
- сворачиваемый sticky summary на небольшом экране;
- mobile cards и desktop table/detail;
- фильтры status и symbol;
- balance, available/reserved capital, realized result и evidence-aware equity, exposure и
  unrealized result;
- подтверждаемые start, pause, resume и stop.

Для создания робота нужен активный portfolio и положительная allocation не больше свободного
капитала. После привязки поля portfolio/allocation неизменяемы; для изменения используйте новый
versioned workflow, а не правку данных за спиной ledger.

Robot detail R4 содержит bounded `paper-robot-journal-v1`. Его curve явно имеет basis
`current-epoch-realized-cash`, это не выдуманная историческая mark-to-market equity series. В curve
не больше 256 oldest-first downsampled cash points и, только при наличии current durable valuation
evidence, одна последняя current-equity point. Journal также возвращает максимум 50 newest fills и
100 newest event metadata rows с флагами `truncated`. Event payloads, idempotency keys и command
fields этот read model не раскрывает.

## DCA paper-роботы (R6, принят)

Статус R6: **принят и развёрнут**. Release gate из [RELEASING.md](../RELEASING.md) —
exact-commit CI run `29633743310` (`6/6`) на commit
`e2411ab2f0b4540200089af8128304f71d3f73e0`, защищённый слот `r6a-schema16-e2411ab`, paired
recovery rehearsal и cutover — пройден; см. записанное
[R6 acceptance evidence](../evidence/R6_DCA_PAPER_ROBOT.md). R6 не меняет схемы PostgreSQL и
SQLite: DCA-роботы используют существующие типы paper-событий и settings snapshots, а каждый
ledger до R6 воспроизводится байт-в-байт без изменений.

Конфигурация paper-робота получает необязательный дискриминатор поведения
`kind: "strategy" | "dca"`. Отсутствующий `kind` по-прежнему означает "strategy", поэтому
исторические роботы и старые payload не меняются. DCA-робот не содержит strategy IR; вместо него
он несёт версионированные параметры `dca-params-v1`. Как и любой робот в `public-http-paper`, это
research-only симуляция: без биржевых ключей, private-запросов и live-ордеров.

### Параметры (`dca-params-v1`)

| Поле | Границы | Значение |
| --- | --- | --- |
| `direction` | `long` \| `short` | сторона цикла; short полностью зеркален |
| `baseOrderQuote` | > 0 | размер первого (base) market-ордера в quote-валюте |
| `safetyOrderQuote` | > 0 | размер первого safety-ордера в quote-валюте |
| `maxSafetyOrders` | целое 0..25 | safety-ордеров на цикл; 0 отключает докупки |
| `priceDeviationPct` | > 0, ≤ 50 | расстояние safety-ордера 1 от входа цикла, процент |
| `stepScale` | 0.1..5 | множитель отклонения каждого следующего safety-ордера |
| `volumeScale` | 0.1..5 | множитель размера каждого следующего safety-ордера |
| `takeProfitPct` | > 0, ≤ 100 | расстояние take-profit от средней цены входа, процент |
| `stopLossPct` | опционально, > 0, ≤ 100 | расстояние stop-loss от средней цены входа, процент |
| `trailingTakeProfitPct` | опционально, > 0, ≤ `takeProfitPct` | trailing-дистанция после достижения TP-порога |
| `cooldownSeconds` | целое 0..86400 | пауза после завершённого цикла перед новым входом |
| `maxCycleDurationHours` | опционально, целое 1..720 | лимит возраста цикла; превышение закрывает по рынку и останавливает |

Общий парсер (`packages/contracts/dca.ts`) точный и fail-closed: неизвестные или отсутствующие
поля отклоняются, а payload обязан нести литеральный safety-конверт `researchOnly: true` и
`executionPermission: false`. Quote-размеры дополнительно ограничены диапазоном fixed
paper-money.

### Worst-case капитал

```text
worstCase = (base + Σ_{i=1..maxSafetyOrders} safety · volumeScale^(i-1)) · (1 + feePct/100)
```

с округлением **вверх** до шести знаков, чтобы резервирование всегда было консервативным. Форма
создания в браузере и сервер выполняют одну и ту же общую функцию. `paper-robot.create`
завершается ошибкой `WORST_CASE_EXCEEDS_ALLOCATION`, если worst case превышает запрошенную
шестизначную allocation; форма показывает то же значение вживую относительно доступного капитала
и блокирует отправку, а detail робота повторяет его в раскрытии параметров.

### Общая модель paper-исполнения (`paper-fill-model-v1`)

Версионированная константа `PAPER_FILL_MODEL_V1 = { feePct: 0.05, slipPct: 0.02 }`
(`packages/execution-core/fillModel.ts`) — единственный источник паритета fee/slippage для
paper engine adapter, дефолтов backtest и worst-case математики DCA. Изменение чисел — это новая
версия, а не правка на месте.

### Поведение усреднения (`averaging-v1`)

Позиционный переход paper-адаптера версионируется на робота:

- `single-position-v1` (по умолчанию): историческое поведение, байт-в-байт совместимое с каждым
  существующим ledger. Сработавший resting-ордер той же стороны теперь создаёт явное событие
  `order_cancelled` с причиной, а не исчезает молча.
- `averaging-v1` (только DCA-роботы): добавление той же стороны сливается в одну позицию с
  `qty = q1 + q2` и volume-weighted средней ценой входа; комиссия начисляется как сегодня, а
  записанное position-событие отражает объединённое состояние.

Replay ledger остаётся fail-closed: записанные fills — это данные, и reducer проверяет внутреннюю
согласованность каждого записанного события position/cash/fee. Single-position ledgers никогда не
содержат same-side add fills, поэтому расширение аддитивно и старые ledgers валидируются без
изменений.

### Машина состояний цикла (`dca-state-v1`)

DCA-робот — чистая версионированная функция переходов, управляемая только закрытыми барами и
наблюдаемыми fills собственных ордеров. Фазы: `idle → entering → position(soFilled=k) →
exiting(reason) → cooldown(until) → idle`; выход `duration` завершается в `stopped` вместо
cooldown. Правила:

- в idle после cooldown закрытый бар начинает цикл base market-ордером;
- после fill base: take-profit limit от средней цены входа плюс safety-ордер 1 на уровне
  `entry · (1 ∓ deviation)`;
- после fill safety-ордера `k`: отмена и повторная постановка take-profit от новой
  volume-weighted средней цены и постановка safety-ордера `k+1` на последней safety-цене ∓
  `deviation · stepScale^k`, пока `k < maxSafetyOrders`;
- fill take-profit завершает цикл: остальные ордера отменяются и начинается cooldown;
- stop-loss (если задан, от средней цены входа) закрывает по пересечению бара; trailing
  take-profit взводится на TP-пороге и только ужесточается;
- превышение `maxCycleDurationHours` закрывает по рынку и терминально останавливает робота.

Количества и limit-цены — точные шестизначные значения, поэтому арифметика машины повторяет
записанные paper fills бит-в-бит, а take-profit закрывает позицию целиком без «пыли». Гонка в
одном баре, когда исполняются и safety-ордер, и устаревший take-profit, оставляет остаток,
который выравнивается явным market-закрытием `tp-remainder` — он никогда не отбрасывается.

### Детерминизм, golden replay и рестарт

Golden-replay harness (`backend/src/trading/goldenReplay.ts`) прогоняет реальный order path
движка — paper adapter, order lifecycle и ledger controller — бар за баром на in-memory
хранилищах с инжектированными часами и идентификаторами из `(botId, bar, ordinal)`. Критерий
детерминизма: один и тот же путь свечей всегда даёт байт-идентичный поток событий ledger, а его
replay воспроизводит финальное состояние.

Каждый переход машины потребляет один детерминированный idempotency key
`dca:<botId>:<cycle>:<ordinal>`, который одновременно является durable `clientId` ордера.
Snapshot машины сохраняется через существующий settings-путь под ключом `dcaState:<botId>` с тем
же ключом идемпотентности. На рестарте replay ledger восстанавливает paper-счёт, fail-closed
парсер snapshot восстанавливает состояние машины, журналированные fills сверяются с машиной, а
отсутствующий или неоднозначный переход безопасно выполняется повторно, потому что адаптер
дедуплицирует команды по `clientId`. Повреждённый snapshot останавливает восстановление
fail-closed, а не продолжает с угаданного состояния.

Список роботов помечает DCA-роботов типом стратегии DCA, а detail drawer получает аддитивную
необязательную секцию runtime-метаданных `dca` (фаза цикла, safety-ордера filled/total, средняя
цена входа, следующая safety-цена, цель take-profit, cooldown) из того же durable snapshot;
старые клиенты игнорируют дополнительное поле.

## Grid paper-роботы (R7, принят)

Статус R7: **принят и развёрнут**. Release gate из [RELEASING.md](../RELEASING.md) —
exact-commit CI run `29636312303` (`6/6`) на commit
`baf42178d33043fde0965d008aee9f09462df699`, защищённый слот `r7a-schema16-baf4217`, paired
recovery rehearsal и cutover — пройден; см. записанное
[R7 acceptance evidence](../evidence/R7_GRID_PAPER_ROBOT.md). Как и R6, R7 не меняет схемы
PostgreSQL и SQLite: grid-роботы используют существующие типы paper-событий и settings
snapshots, а каждый ledger до R7 воспроизводится без изменений.

Дискриминатор конфигурации paper-робота получает третье значение
`kind: "strategy" | "dca" | "grid"`. Отсутствующий `kind` по-прежнему означает "strategy",
поэтому исторические роботы и старые payload не меняются. Grid-робот несёт версионированные
параметры `grid-params-v1` вместо strategy IR и исполняется с fill behavior `averaging-v1`,
поэтому исполненные уровни накапливаются в один signed inventory. Как и любой робот в
`public-http-paper`, это research-only симуляция: без биржевых ключей, private-запросов и
live-ордеров.

### Параметры (`grid-params-v1`)

| Поле | Границы | Значение |
| --- | --- | --- |
| `mode` | `neutral` \| `long` \| `short` | какие лестницы взводятся на якоре: обе, только buy или только sell |
| `spacing` | `arithmetic` \| `geometric` | закон расстановки уровней внутри диапазона |
| `lowerBound` | > 0, ≤ 1e9 | нижняя граница; строго ниже `upperBound` |
| `upperBound` | > 0, ≤ 1e9 | верхняя граница; для geometric отношение `upper/lower` дополнительно ограничено 1e6 |
| `gridLevels` | целое 2..50 | число уровней строго внутри `(lowerBound, upperBound)` |
| `orderQuote` | > 0, ≤ 1e9 | размер ордера на уровень в quote-валюте |
| `recenter` | опционально, только `off` | авто-recenter в v1 нет; `manual` зарезервирован и отклоняется |
| `outsideRangeAction` | `pause` \| `stop` | реакция на close бара вне диапазона |
| `stopLossPrice` | опционально, > 0 | neutral/long: строго ниже `lowerBound`; short: строго выше `upperBound` |
| `maxCycles` | опционально, целое 1..10000 | лимит завершённых round trips; достижение останавливает grid |
| `cooldownSeconds` | целое 0..86400 | задержка перед повторным взводом уровня после закрытия его пары |

Общий парсер (`packages/contracts/grid.ts`) повторяет стиль DCA: точный и fail-closed,
неизвестные или отсутствующие поля отклоняются, литеральный safety-конверт `researchOnly: true`
и `executionPermission: false` обязателен.

### Цены уровней

Детерминированная лестница, общая для предпросмотра в браузере и машины состояний, ставит
`gridLevels` цен строго внутри диапазона, для `i = 1..gridLevels` со знаменателем
`gridLevels + 1`:

```text
arithmetic: lower + i · (upper − lower) / (levels + 1)
geometric:  lower · (upper / lower) ^ (i / (levels + 1))
```

Каждая цена канонически округляется до шести знаков, поэтому replay байт-стабилен.

### Worst-case капитал

```text
worstCase = gridLevels · orderQuote · (1 + feePct/100)
```

с округлением **вверх** до шести знаков, чтобы резервирование всегда было консервативным. Оценка
моделирует все уровни, одновременно держащие исполненный ордер без парного закрытия; short-grid
резервирует идентичную quote-сумму, а margin resting-ордеров равен 0 в paper spot семантике,
поэтому оценка одинакова для всех режимов. Комиссия берётся из общей `paper-fill-model-v1`.
Форма создания показывает значение вживую, а сервер отклоняет `paper-robot.create` тем же кодом
`WORST_CASE_EXCEEDS_ALLOCATION`, что и DCA, если worst case превышает запрошенную шестизначную
allocation.

### Машина состояний лестницы (`grid-state-v1`)

Grid-робот — чистая версионированная функция переходов, управляемая только закрытыми барами и
наблюдаемыми fills собственных ордеров, с фазами `idle → active → paused → stopped`. Правила:

- **Якорь**: первый закрытый бар с close внутри `[lowerBound, upperBound]` взводит лестницу.
  Точное правило: уровни строго ниже anchor close взводят BUY limits, строго выше — SELL limits
  (neutral); `long` взводит только buy-лестницу, `short` — только sell; уровень ровно на anchor
  close не взводится никогда. Close вне диапазона оставляет grid в idle.
- **Парное закрытие**: исполненный ордер уровня ставит один парный close limit на цене соседнего
  уровня — верхний сосед для buy, нижний для sell, а для крайнего уровня — сама граница
  диапазона, поэтому все ордера остаются внутри диапазона.
- **Round trip**: fill парного закрытия реализует `(sell − buy) · qty` минус fee-модель на обеих
  ногах, засчитывает один цикл и переводит уровень в cooldown; спустя `cooldownSeconds` уровень
  повторно взводит исходный ордер на следующем закрытом баре.
- **Вне диапазона**: close, покинувший диапазон, запускает `outsideRangeAction` ровно один раз —
  `pause` ничего не отменяет, прекращает новые постановки и продолжает после возврата цены;
  `stop` отменяет resting-ордера и останавливает терминально с сохранением inventory и явной
  причиной.
- **Stop-loss**: бар, пересёкший `stopLossPrice`, отменяет все ордера, выравнивает весь inventory
  по рынку и останавливает терминально.
- **Max cycles**: достижение `maxCycles` завершённых round trips отменяет ордера и останавливает
  терминально с сохранением inventory.
- `orderQuote`, слишком маленький для шестизначного количества на цене уровня, честно отключает
  уровень вместо постановки неисполнимого нулевого ордера.

### Gap и рестарт

Бар, перепрыгнувший несколько уровней, исполняет их resting-ордера как записанные fills; машина
потребляет весь batch в одном шаге в детерминированном порядке `(price, side, key)` и ставит
консолидированные замены ровно один раз за шаг — gap никогда не каскадирует промежуточные
постановки. Gap за границы диапазона запускает `outsideRangeAction` ровно один раз.

Каждый переход потребляет один детерминированный idempotency key
`grid:<botId>:<epochCycle>:<ordinal>`, который одновременно является durable `clientId` ордера.
Snapshot машины сохраняется через существующий settings-путь под ключом `gridState:<botId>`. На
рестарте replay ledger восстанавливает paper-счёт, fail-closed парсер snapshot восстанавливает
машину, журналированные fills сверяются с ней, и повторно выполняются только переходы без durable
результата в journal — адаптер дедуплицирует по `clientId`, поэтому рестарт никогда не дублирует
ордера уровней и резервы. Snapshot чужого робота останавливает восстановление fail-closed, а
snapshot старого ledger epoch (portfolio reset) не возобновляется: машина стартует с чистого
состояния. Любая ошибка исполнения переводит робота в паузу fail-closed, а не угадывает
состояние адаптера. Grid использует тот же golden-replay harness, что и DCA.

### Realized и inventory PnL

Два результата никогда не смешиваются: `realizedGridPnl` накапливает только завершённые пары
buy→sell (или sell→buy) за вычетом комиссий, а inventory PnL — evidence-aware нереализованная
оценка удерживаемого signed inventory (`inventoryBaseQty` по volume-weighted `inventoryAvgCost`)
из durable valuation marks. Отсутствующая или протухшая отметка оставляет inventory PnL
`unavailable` либо `stale`, а не ложный ноль. Список роботов помечает grid-роботов, а detail
drawer получает аддитивную необязательную секцию runtime-метаданных `grid` (фаза, режим,
spacing, границы, счётчики уровней resting/filled/cooldown, количество и средняя цена inventory,
realized grid PnL, завершённые циклы, причина остановки и раскрытие параметров с worst case);
старые клиенты игнорируют дополнительное поле.

## HTTP-контракт first-party клиента

Канонические read routes используют authenticated trading boundary; mutations дополнительно
требуют его CSRF-защиту. Все ответы возвращают `Cache-Control: no-store`.

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| `GET` | `/api/trade/paper-portfolios` | список active/archived portfolios текущего owner |
| `GET` | `/api/trade/paper-portfolios/:portfolioId` | одна canonical projection |
| `POST` | `/api/trade/paper-portfolios` | создать portfolio |
| `PATCH` | `/api/trade/paper-portfolios/:portfolioId` | переименовать portfolio |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/default` | выбрать portfolio по умолчанию |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/archive` | архивировать после точного подтверждения |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/reset` | создать следующий ledger epoch |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/robots/:botId/actions` | start/pause/resume/stop одной revision |

Каждый запрос несёт `X-SBV2-Expected-User`, равный user ID, сохранённому клиентом в момент начала
операции. Каждая mutation также несёт стабильный `Idempotency-Key`; после timeout повтор использует
тот же ключ и идентичный body. Изменение существующего portfolio передаёт последнюю revision и
ledger epoch, robot action — ещё и точную bot revision. `409` требует refresh вместо перезаписи
нового состояния. `503 command_pending` означает, что команда durable, но не стала terminal за
синхронное окно; повторите её с тем же ключом.

Деньги передаются canonical USDT-строкой ровно с шестью знаками после точки, например
`"10000.000000"`. Клиент не должен сначала округлять сумму через binary floating point.

## Новая self-hosted установка

Следуйте [Self-hosting with account authentication](../SELF_HOSTING.md). Fresh clone запускает
отдельный project-owned PostgreSQL и отдельный SQLite data directory; приложение применяет
checked-in миграции автоматически. Не выполняйте migration SQL вручную.

До старта проверьте application/PostgreSQL ports. Documented defaults — `127.0.0.1:4180` и
`127.0.0.1:55434`. Если порт занят, выберите другой loopback port для этого проекта. Нельзя
останавливать чужой процесс, использовать посторонний PostgreSQL cluster/database или направлять
`backend/data` в другую установку.

После запуска:

1. Проверьте `/api/health` и `/api/ready` именно этого экземпляра.
2. Создайте первого администратора documented one-time командой.
3. Сразу смените generated password.
4. Активируйте тестового пользователя и выдайте только нужную paper-роль.
5. Создайте paper portfolio и одного paper robot; exchange credential не нужен.
6. Создайте и проверьте paired recovery generation до появления незаменимых данных.

## Upgrade на PostgreSQL 12 и SQLite 9

Migration chain forward-only. PostgreSQL 12 добавляет durable executor queue. SQLite 9 добавляет
portfolio/epoch/reservation/receipt/revision-evidence/valuation/projection tables и перестраивает
ключ paper events с учётом `ledgerEpoch`.

Production deployment прошёл этот порядок; self-hosted upgrade обязан повторить его для своего
exact release:

1. Подтвердите, что checkout/release, database name, loopback port, systemd units либо Compose
   project и runtime data directory относятся именно к этой установке.
2. Создайте и проверьте одну paired PostgreSQL + SQLite recovery generation по инструкции
   [Runtime backup and restore](../BACKUP_RESTORE.md). Храните её вне mutable release tree.
3. Перед cutover остановите только API и research worker этого проекта. Не останавливайте чужой
   PostgreSQL или другой сервис.
4. Установите/соберите принятый exact release существующим self-host способом.
5. Запустите ровно один API. PostgreSQL migrations применяются transactionally под migration lock,
   SQLite migrations — transactionally под singleton runtime lock.
6. Readiness должна подтвердить expected schema/checksum и paper executor. Проверьте login, owner
   isolation, список migrated legacy portfolios и одну idempotent paper mutation.
7. Запустите matching research worker только после успешной проверки API/schema.
8. Создайте и проверьте новую paired recovery generation уже migrated состояния.

Не запускайте старый binary после движения любого store вперёд. Нельзя удалять migration rows,
дропать таблицы R4, переписывать ledger epoch или очищать queue ради зелёной readiness.

Если PostgreSQL 12 применился, а SQLite 9 не завершился, оставьте приложение остановленным.
Сохраните логи и исходную recovery generation. Используйте read-only диагностику либо восстановите
полную пару; не делайте частичный down-migration одного store.

## Backup, restore и rollback

Единица восстановления — одна проверенная generation с обоими stores. PostgreSQL-only dump теряет
SQLite portfolio ledger/receipts. SQLite-only archive теряет authenticated ownership,
authorization fences и queued PostgreSQL commands. Смешивание отдельно снятых половин может
повторить уже применённую mutation или отвязать evidence от owner.

Используйте project workflows `recovery:backup`, `recovery:verify`, `recovery:restore` и
`recovery:drill` ровно по [инструкции backup/restore](../BACKUP_RESTORE.md). Restore создаёт отдельно
названную project-owned PostgreSQL database и отдельный отсутствующий/пустой runtime directory; он
не переключает systemd, Compose, `PGDATABASE`, `FRONTEND_DIST_DIR` или active data path.

Rollback с R4:

1. Остановите только API и research worker проекта.
2. Ещё раз verify retained pre-upgrade paired generation.
3. Restore обе половины в новые replacement resources.
4. Проверьте schema versions, owner inventory, count `executor_commands`, counts всех
   canonical paper tables schema 9 и SQLite integrity.
5. Направьте только остановленные units проекта на replacement database/data directory и matching
   protected pre-R4 release.
6. Запустите один API, проверьте auth/readiness/paper state, затем research worker.
7. Сохраняйте прежние resources, пока rollback evidence и retention policy не разрешат удаление.

In-place schema downgrade отсутствует. Команд, portfolios и events, созданных после выбранного
backup, после rollback не будет; заранее экспортируйте пользовательские artifacts, которые должны
пережить выбор recovery point.

## Инварианты оператора

- Оставляйте `RUNTIME_PROFILE=public-http-paper` без изменений.
- PostgreSQL остаётся loopback-only с отдельными database/role/port проекта.
- Для одного `trading.db` работает один paper executor.
- `trading.db` и `.secret` хранятся вместе; backup считается чувствительным.
- Не редактируйте totals, receipts, revisions и ledger events напрямую.
- Не копируйте работающий SQLite обычной файловой командой; используйте online backup.
- Не восстанавливайте поверх active database/data directory.
- Не применяйте broad process kill, Docker prune/down, root-systemd changes или database drop для
  решения локальной проблемы этого проекта.
- HTTPS и live/private exchange execution остаются отдельной будущей работой.
