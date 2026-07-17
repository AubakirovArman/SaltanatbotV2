# Подробный план разработки до появления HTTPS

Статус документа: рабочий план публичного развёртывания SaltanatbotV2 в режиме
**Research / Paper**. HTTPS, ввод биржевых API-ключей, приватные потоки аккаунта и
отправка реальных ордеров в этот план не входят.

Пока владелец отдельно не инициирует и не утвердит новый HTTPS/security roadmap,
сервер работает только с `RUNTIME_PROFILE=public-http-paper`. Ни один этап R0–R12
не зависит от домена, сертификата, reverse proxy или TLS.

Текущий production — принятый R5.1 на PostgreSQL schema 13 из защищённого
слота `r5a-schema13-66394fd`. Описанный ниже R5.1 принят и развёрнут; R5 в
целом остаётся active из-за pending R5.2/R5.3.

> Важно: HTTP не защищает логин, пароль и session cookie от перехвата. До HTTPS
> экземпляр нельзя считать безопасным для доступа через недоверенную публичную
> сеть. Используйте private network/VPN/IP allowlist либо отдельные тестовые
> пароли, которые нигде больше не применяются. Research/Paper блокирует реальные
> ордера, но не шифрует транспорт.

Каноническая краткая версия: [PRE_HTTPS_ROADMAP.md](../PRE_HTTPS_ROADMAP.md).

## 1. Жёсткая граница безопасности

На всём протяжении R0–R12 сервер работает только с
`RUNTIME_PROFILE=public-http-paper`.

Разрешено:

- регистрация, вход, активация администратором и изоляция пользователей;
- публичные котировки, графики, индикаторы и стакан;
- сохранённые рабочие пространства, стратегии, бэктест и оптимизация;
- paper-роботы, paper-портфель и in-app исследовательские алерты; Telegram
  остаётся разрешённым будущим scope R5.3, а не возможностью R5.1;
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
   Coverage измеряется и публикуется как release artifact: сначала фиксируется
   честный baseline, затем новые модули и изменённые authorization, worker,
   paper-ledger и notification пути не могут снижать line/branch/function
   coverage и обязаны иметь прямые failure-path тесты. Произвольный высокий
   процент без проверки критических веток не считается достаточным.
8. Обновляются self-hosting, backup/restore и rollback-инструкции.
9. Не создаются новые порты, контейнеры или базы вне ресурсов SaltanatbotV2.
10. Готовый этап фиксируется отдельным понятным коммитом в `main` после зелёных
    локальных проверок и затем проверяется GitHub Actions.
11. Fresh-clone smoke подтверждает install → project-owned PostgreSQL/bootstrap
    admin → обязательную смену пароля → migrations → health → sample paper run →
    backup → restore → upgrade. Перед запуском проверяются занятые порты; чужие
    БД, контейнеры и сервисы не изменяются.
12. Для UI-релиза геометрических скриншотов недостаточно: проверяются работа под
    потоком котировок, отсутствие ненужных подписок у скрытых панелей, long tasks,
    рост памяти и запас не менее 10% в основном и тяжёлых async bundle budgets.
13. Наблюдаемость, global admission limits, backup/restore и failure handling
    добавляются в том релизе, который создаёт новую нагрузку. R11 является
    интегральным доказательством на 100 пользователей, а не первым релизом этих
    механизмов.
14. Тестовые учётные записи создаются только через bootstrap/admin API в
    изолированной project-owned БД. Прямое SQL-назначение ролей в работающей
    среде не является допустимым способом аудита или E2E-подготовки.
15. Для `main` действует принятое решение D1: документированное owner-only
    исключение разрешает прямую публикацию только после exact-worktree local
    gates, remote-head recheck и с обязательной проверкой GitHub Actions для
    точного pushed SHA. Production cutover до green запрещён; полный контракт
    зафиксирован в [ADR 0002](../adr/0002-owner-only-direct-main-release-gate.md).
16. Каждый принятый релиз устанавливается из fresh clone без обязательной
    hosted-only зависимости. Внешние провайдеры необязательны, отключены по
    умолчанию и документируются как BYO; Monitoring, Research, Backtest и Paper
    должны работать self-hosted.
17. Перед любой изменяющей release-командой evidence фиксирует точные project
    root, user-systemd units, Compose project/container, listener ports, database
    names и data directories. При несовпадении идентичности или занятом порте
    операция прекращается. Запрещены kill-by-port, шаблонный `pkill`, глобальные
    Docker prune/down, изменение root-systemd units, `DROP/ALTER` чужих БД и
    повторное использование чужих volumes. Занятый порт заменяется свободным
    project-owned портом; чужой процесс не останавливается.

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
| R2 | active | mobile drawing sheet, gesture FSM, safe-area, компактные cards, Volume Profile/price-axis fixes, автоматизированная 320–1440 matrix, chart-only runtime ownership, lifecycle-gated subscriptions, O(1) provisional candle tail, принятый threshold-enforced soak и обязательный 10% bundle reserve | ручные Android Opera/assistive-tech smoke | 74 Chromium + 18 Firefox + 6 visual + soak `2/2` + manual artifacts |
| R3 | done | R3.1–R3.3 были развёрнуты на schema 11; lifecycle, workspace workflow, onboarding/PWA boundary и соответствующий срез O1 приняты как исторические инкременты | сопровождение; production позже перешёл на принятый R4 | [R3.1 evidence](../evidence/R3_1_IDENTITY_CONTROL_PLANE.md) + [R3.2 evidence](../evidence/R3_2_WORKSPACE_WORKFLOW.md) + [R3.3 evidence](../evidence/R3_3_ONBOARDING_OPERATIONS.md) |
| R4 | done | schema-12 fenced commands, SQLite-9 canonical portfolios/epochs/reservations, versioned metrics, bounded Running journal/curve и extended recovery inventory приняты и развёрнуты | сопровождение; production позже перешёл на принятый R5.1 | [accepted R4 evidence](../evidence/R4_PAPER_PORTFOLIOS.md) |
| R5 | active | R5.1 generic owner price alerts приняты и развёрнуты на schema 13 (слот `r5a-schema13-66394fd`) | реализовать R5.2 technical screener и R5.3 notification worker/Telegram | [R5.1 evidence](../evidence/R5_1_OWNER_ALERTS.md) + alert/chart parity + delivery drill |
| R6 | pending | общий paper execution foundation частично существует | общий paper contract + DCA | deterministic replay + capital invariants |
| R7 | pending | foundation R6 | Grid на том же ledger/state machine | gap/restart/golden replay |
| R8 | pending | богатый read-only spread/arbitrage research baseline | durable multi-leg paper intent, leg risk и unwind | two-leg/multi-leg replay + clock/freshness gates |
| R9 | pending | parameter GA, structural generator и pure multi-market ranker | server multi-market evaluation, Pareto/OOS promotion, checkpoints | seeded reproducibility + owner-fair queue |
| R10A | pending | upload/in-memory L2 ML research baseline | online collector, bounded storage, funding/OI/MTF и календарный soak | bytes/sec/disk forecast + retained replay corpus |
| R10B | pending | baseline model/features | durable dataset/model registry, promotion/rollback, drift UI | champion/challenger + replayable inference |
| R11 | pending | bounded API/worker/auth foundations | измеримый integrated 100-user proof и failure drills | load report + RPO/RTO + 30% headroom |
| R12 | pending | текущие self-hosting и backup docs | fresh clone, coordinated restore, upgrade compatibility и итоговый audit | clean-host smoke artifacts |

### 2.2. Централизованный журнал открытых решений

Открытое решение не прячется внутри реализации: owner фиксирует выбранный
вариант и evidence в ADR/issue до указанного gate. Пока статус остаётся `open`,
действует fail-closed fallback; он не разрешает пропустить зависимость или
включить HTTPS/live.

| ID | Статус | Решение | Owner | Decide-by gate | Fail-closed fallback |
| --- | --- | --- | --- | --- | --- |
| D1 | decided | [ADR 0002: owner-only direct-main release gate](../adr/0002-owner-only-direct-main-release-gate.md) — прямой push только после exact-worktree local gates, remote-head/fast-forward recheck и без force | владелец проекта + release maintainer | принято 2026-07-17; применяется к R3.3 и каждому direct-main release | production cutover заблокирован до green Actions точного SHA; failure исправляется gated fix-forward или новым `git revert`, ADR supersede-ится required-check ruleset |
| D2 | open | Канонические версии Strategy IR, dataset schema/fingerprint/split и детерминированного backtest engine для R9 | R9 technical owner + architecture maintainer | до schema/job API R9.1 и первого server evolutionary run | server GA/generator остаётся выключен; доступен только текущий browser research baseline, promotion/gallery запрещены |
| D3 | open | Точный лицензированный R10A scope: venues, native symbols/markets, условия источников, hot/warm retention, downsampling и deletion policy | владелец проекта + market-data/ML maintainer | до включения online ingest R10A.2 и начала corpus soak | online collector выключен; остаются только bounded uploads/read-only adapters для документированно разрешённых источников, R10B заблокирован |

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
удаляется; indicator strip резервирует область price axis; mobile drawing
catalog доступен через bottom sheet с поиском/группами, active tool,
undo/redo/delete и object list; pan, long-press inspect, draw и pinch проходят
через явную touch state machine с `pointercancel`, lost capture и orientation
reset; добавлены `viewport-fit=cover`, safe-area, compact arbitrage cards и
отдельный full-table view. Strategy Studio, short landscape и coarse tablets
проверены без half-width и horizontal document overflow. Bundle checker теперь
оставляет обязательные 10% резерва относительно круглых reviewed caps вместо
порогов, выставленных почти байт в байт. Высокочастотные candle/compare/position
и видимые watchlist resources перенесены в `ChartWorkspaceRuntime`, который
существует только в Monitoring. Скрытые/maximized panes и закрытая markets panel
отключают hooks и освобождают sockets/timers/polling. Отдельный
`PriceAlertFeed` вне chart runtime сохраняет quote subscription только для
уникальных не сработавших/armed alerts и не открывает socket при пустом наборе.
Обновление формирующейся свечи с тем же timestamp coalesce-ится до одного
React commit за 250 мс и использует O(1) provisional tail поверх неизменяемой
structural history; полное копирование остаётся для snapshot, нового timestamp
или явного prepend истории.

Текущий автоматизированный evidence: 74 Chromium E2E, 18 Firefox critical
journeys, 6 container visual snapshots, 2 231 unit/integration tests и зелёные
type/lint/build/docs/architecture gates. Отдельный synthetic desktop/mobile
Chromium soak harness использует 12 000 candles, tick каждые 100 мс,
Monitoring → Strategy → Monitoring, CDP heap/DOM/task counters и обязательную
render/stream instrumentation. Авторитетный запуск 2026-07-16 прошёл оба
пятиминутных профиля без retry (`2/2` за `11.7 min`); все strict summary checks
равны `true`. Точные метрики и SHA-256 записаны в
[R2 stream/render soak evidence](../evidence/R2_STREAM_RENDER_SOAK.md).

Оставшийся R2.3:

- выполнить ручной Opera smoke на реальном Android/Opera окружении и
  VoiceOver/NVDA/TalkBack smoke с записью версий и результата.

Матрица проверки:

- 320×568, 360×800, 390×844, 430×932;
- граничные CSS-ширины 600, 760 и 761 px;
- mobile landscape;
- 768×1024 и 1024×768;
- 1440×900;
- Playwright Chromium touch/coarse эмуляция выполнена; реальный Android Opera
  smoke остаётся в R2.3;
- автоматизированные keyboard/axe и масштаб текста 200% выполнены; ручной
  VoiceOver/NVDA/TalkBack smoke остаётся в R2.3;
- принятый полный soak 2026-07-16 использовал пять минут на каждый
  mobile/desktop профиль и проверил: после ограниченного GC warm-up стабильность трёх
  paused/frame-settled/post-GC замеров
  retained JS heap, консервативный retained growth `<= max(8 MiB, 10%)`,
  retained growth rate `<= 1 MiB/min`, long task `<= 150 ms`, total blocking `<= 250 ms`,
  event-loop delay `<= 250 ms`, task duty `<= 0.35` desktop / `<= 0.45`
  mobile, DOM delta `<= 0 documents / 50 nodes / 10 listeners`, candle copy
  pressure `<= 64` элементов на message, каждая копия классифицирована как
  snapshot/new bar/finalization/prepend, и App render ratio `<= 0.01`;
- OLS slope обычных raw V8 heap samples сохраняется только как диагностика:
  GC-driven «пила» не используется как доказательство retained leak;
- в no-alert fixture visible subscriptions равны одному chart stream и одной
  desktop/нулю mobile watchlist quote subscription; в Strategy workspace обе
  равны нулю и после возврата восстанавливаются ровно один раз;
- нулевой horizontal page overflow, полный dismiss editor/dialog, доступность
  последней кнопки indicator strip и touch targets не меньше 44×44 px.

Критерий: на каждом размере доступны цена, управление индикаторами, рисунками и
стратегией; ни один control не лежит поверх шкалы цены или другого control;
полный soak artifact прошёл review; ручные Android Opera и
VoiceOver/NVDA/TalkBack gates завершены. До этого R2 остаётся `active`.

## 7. R3 — жизненный цикл пользователя, рабочие пространства и первый запуск

Статус: завершён и был развёрнут на schema 11; R3.1, R3.2 и R3.3 с
соответствующим срезом O1 остаются принятыми историческими инкрементами.
Production позже перешёл на принятый R4 schema 12/schema 9, а затем на
принятый R5.1 schema 13; R5.2/R5.3 остаются
pending. Baseline: PostgreSQL auth,
pending registration, atomic admin lifecycle/role management, owner/admin
sessions, audit, guarded recovery и owner-scoped PostgreSQL workspace CRUD,
optimistic revision conflicts, `409`, rollback и максимум 20 revisions уже
существуют. R3.2 добавляет единый frontend document, quotas/import-export,
archive/purge, явное разрешение конфликтов, schema 10 и защищённую статическую
release boundary. R3.3 добавил owner-scoped onboarding, HTTP-safe PWA boundary,
readiness/admission и recovery evidence без доступа администратора к
tenant-owned product data. Evidence:
[R3.1 identity control plane](../evidence/R3_1_IDENTITY_CONTROL_PLANE.md) и
[R3.2 workspace workflow](../evidence/R3_2_WORKSPACE_WORKFLOW.md), а также
[R3.3 onboarding и operations](../evidence/R3_3_ONBOARDING_OPERATIONS.md).

### R3.1 — жизненный цикл пользователя и администратора

Статус: завершён.

- состояния `pending → active → disabled`, безопасная reactivation и отдельные
  роли `read-only`/`paper-trade`; live-permission в pre-HTTPS UI отсутствует;
- активация не даёт пользователю доступ к чужим paper accounts, workspaces,
  jobs, alerts, journals или Telegram bindings;
- список owner sessions, принудительный logout и отзыв всех sessions при disable
  или смене роли; останавливается только работа этого owner;
- guarded CLI для сброса admin password, защита последнего администратора и
  обязательная смена bootstrap password;
- audit всех admin actions; оператор видит агрегированные метрики и состояние
  квот, но не содержимое приватного workspace пользователя.
- privileged mutation требует reason и expected authorization revision, а
  before/after состояние, request ID, IP и user agent пишутся атомарно с
  изменением;
- uppercase UUID не обходит self-guards; отзыв текущей сессии очищает cookies и
  немедленно синхронизирует UI;
- migration v9 понижает сохранённые non-admin `live-trade` до `paper-trade`,
  отзывает их sessions/tickets и запрещает повторную выдачу live-роли constraint.

### R3.2 — сохранённый workflow

Статус: завершён и развёрнут на schema 10.

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

### R3.3 — онбординг

Статус: завершён и развёрнут; полные build/browser/PostgreSQL/recovery gates,
fix-forward CI и production cutover зафиксированы в R3.3 evidence.

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

### R3.3 + O1 — исполнимый порядок реализации

R3.3 принят одним совместимым инкрементом и был выполнен внутри него в следующем
порядке:

1. **Конфигурация и миграция schema 11.**
   - новые лимиты, watermarks и TTL строго разбираются до подключения к БД,
     файловой системе и listener;
   - аддитивная owner-scoped таблица хранит одну конечную цель, timestamps
     milestones, вычисляемый status и optimistic `revision`;
   - отдельная ограниченная таблица heartbeat хранит только состояние
     обязательного `research-worker`, generation ID, schema/release version и
     время последнего сигнала;
   - существующие пользователи не теряют workspace и не вынуждены повторять
     уже фактически завершённый первый запуск.
2. **Owner-scoped onboarding API.**
   - `GET /api/onboarding` возвращает только состояние текущего principal;
   - `PUT /api/onboarding/goal` выбирает конечную цель, а
     `POST /api/onboarding/milestones`, `/dismiss` и `/restart` изменяют то же
     revisioned owner-состояние;
   - stale update получает стабильный `409 onboarding_conflict`;
   - ответы имеют `Cache-Control: no-store`, строгий body limit и не
     содержат credential/account/private-exchange полей.
3. **Первый полезный пользовательский маршрут.**
   - выбор одной из целей: Monitoring, Price alert, Backtest или Paper robot;
   - создание существующего server-synced workspace template;
   - одно следующее действие в каждом empty state вместо набора конкурирующих
     кнопок;
   - RU/EN/KK, клавиатура, 200% текста и mobile bottom sheet;
   - после reload пользователь возвращается в тот же workspace и продолжает
     незавершённый шаг.
4. **HTTP-safe PWA boundary.**
   - единая capability-проверка разрешает Service Worker, install/update и
     offline bundle только в browser secure context либо на
     `localhost`/loopback;
   - на `http://public-ip:4180` PWA launcher полностью отсутствует, Service
     Worker не регистрируется, но обычные workspace/strategy/report
     import/export продолжают работать;
   - install prompt показывается только после реального
     `beforeinstallprompt`; update не вызывает `skipWaiting`, а сообщает о
     необходимости закрыть все вкладки;
   - manifest получает отдельные 192, 512, maskable 512 и Apple 180 icons;
     `/arbitrage-stream` и все runtime transport paths фиксируются как
     network-only;
   - ожидание `navigator.serviceWorker.ready` ограничено timeout, а
     PWA-specific recovery controls скрыты на публичном HTTP.
5. **Первый global admission controller.**
   - начальные проверяемые defaults: 128 active API requests всего, из них 16
     зарезервированы для control traffic; обычная работа использует до 112
     active slots, очередь 256 и ожидание до 2 секунд;
   - admission выполняется до крупных body parsers, включая research job
     payload;
   - дешёвый health остаётся вне admission; dependency-heavy readiness идёт
     через ограниченный ordinary lane и при saturation возвращает not-ready,
     а login/session/password, cancel job и pause/stop уже запущенной
     paper-работы сохраняют отдельный reserve вне тяжёлой очереди;
   - затем readiness проходит отдельный bounded per-IP bucket; принятые
     пересекающиеся вызовы делят один process-wide dependency scan и его
     короткий typed-TTL результат, поэтому множество источников не умножает
     PostgreSQL/statfs работу;
   - migration и heartbeat probes выполняются последовательно, минимальный
     поддерживаемый API pool равен двум, а полный IP store сообщает реальный
     срок до prune;
   - переполнение возвращает стабильный
     `503 global_admission_exhausted` и `Retry-After`; slot освобождается при
     finish, close, abort и exception;
   - defaults остаются конфигурируемыми и пересматриваются по load evidence,
     но не могут отключаться неоднозначным значением environment.
6. **Readiness и минимальная операционная телеметрия.**
   - `/api/health` остаётся дешёвым liveness endpoint;
   - `/api/ready` versioned-проверяет migration checksum, PostgreSQL/pool,
     singleton paper executor, свежесть worker heartbeat, disk soft/hard
     watermark и admission saturation;
   - bounds/counters readiness limiter доступны только в admin metrics и не
     раскрываются в публичном readiness response;
   - hard failure даёт `503 unready`, soft watermark/saturation —
     `200 degraded`, нормальное состояние — `200 ready`;
   - публичный ответ содержит только категориальные состояния компонентов и не
     раскрывает DB name/path, PID, owner ID, migration/checksum, latency,
     heartbeat age, disk capacity, admission counts или секреты;
   - admin-only metrics показывают fixed latency/status buckets, pool,
     admission, queue/worker freshness, executor state, disk и последнюю
     проверенную recovery generation.
7. **Парная recovery generation PostgreSQL + SQLite.**
   - операторский CLI `backup/verify/restore/drill`, без HTTP restore endpoint;
   - manifest связывает один PostgreSQL custom dump и существующий проверяемый
     SQLite runtime backup, checksums, schema versions, release commit,
     capture interval и агрегированные counts;
   - restore разрешён только в новую пустую project-owned PostgreSQL database
     и новый отсутствующий/пустой data directory;
   - current target, non-empty target, symlink, повреждённая половина backup и
     чрезмерный capture skew приводят к fail-closed;
   - CLI не меняет systemd/Compose, `PGDATABASE` или runtime path и не удаляет
     чужие либо исходные ресурсы.
8. **Приёмка и публикация.**
   - two-owner isolation, stale revision и четыре fresh-account journeys;
   - real insecure-origin browser test подтверждает отсутствие PWA controls и
     сохранение обычного экспорта;
   - readiness failure matrix, public DTO redaction, no-store admission
     rejection, sequential two-connection pool reserve,
     single-flight/TTL expiry/error-retry, bounded per-IP store/prune-horizon
     tests, admission saturation/abort tests и worker heartbeat recovery;
   - повреждение каждой половины backup и isolated replacement restore drill;
   - schema checksum, backup hashes, failure matrix и доказательство
     `public-http-paper` записываются в human-readable и machine-readable
     evidence;
   - после зелёных локальных gates обновляются self-hosting/rollback docs,
     выполняются commit в `main`, GitHub Actions и cutover только project-owned
     сервисов.

Критерий: новый пользователь без инструкции создаёт первое полезное research/paper
действие, а после перезапуска возвращается в свой workspace.

### Сквозной operational-пакет, начинающийся в R3

Эти задачи не ждут R11 и поставляются малыми совместимыми инкрементами:

- WAL, `busy_timeout`, integrity checks и bounded retention для project-owned
  SQLite-хранилищ;
- structured logs и метрики API, PostgreSQL pool, очередей, workers, paper
  executor, WebSocket, market freshness, filesystem и backup;
- расширенная readiness: migration state, PostgreSQL, singleton executor,
  обязательные workers и disk hard watermark;
- global admission limits поверх per-owner quotas; health, login и управление
  уже запущенной работой не ставятся за тяжёлой очередью;
- paired PostgreSQL+SQLite backup generation с manifest, checksum и restore
  только в новую replacement database/data directory;
- единый public WebSocket transport с fan-out, reconnect/gap handling,
  backpressure и запретом новых прямых socket-клиентов вне transport layer;
- намеренно подавленная ошибка в auth, paper execution, workers, notifications
  или market adapters обязана иметь structured log/counter и определённый
  degraded/fail-closed state; пустые `.catch(() => {})` в денежных и
  authorization-путях запрещены;
- ограниченная HTTP-компрессия JSON и статических текстовых ресурсов с
  измерением wire-size и CPU; WebSocket, streaming и уже сжатые файлы повторно
  не сжимаются;
- migration compatibility note и machine-readable evidence для каждого
  schema-релиза.

Критерий пакета развивается поэтапно: каждый новый workload имеет лимит,
метрику, readiness/degraded state, backup scope и failure test до принятия
создавшего его релиза.

## 8. R4 — экран «Запущено» и paper-портфель

Статус: завершён, принят и был развёрнут. Production использовал PostgreSQL
schema 12 и trading SQLite schema 9 из защищённого слота
`r4c-schema12-bb455fa` на коммите
`bb455facdfe5a1b3cabe15490c86c299ea684ee7`; exact-SHA GitHub Actions
run `29560112312` прошёл 6/6 jobs. Production позже перешёл на принятый R5.1
schema 13 (слот `r5a-schema13-66394fd`). Runtime остаётся
`public-http-paper`. Операторский runbook:
[Канонические paper-портфели](./PAPER_PORTFOLIOS.md).

Paper-account contract:

- initial capital, accounting currency, available/reserved capital и owner limits;
- полный owner-scoped lifecycle: создать, выбрать portfolio по умолчанию,
  переименовать и архивировать; reset требует явного подтверждения, создаёт
  новый versioned ledger epoch и никогда не стирает старый журнал или evidence;
- несколько paper-ботов не могут дважды зарезервировать один капитал;
- paper account не содержит exchange API keys и не смешивается с live account;
- manual paper order, DCA, Grid и spread используют один order/fill/state contract;
- формулы PnL/funding/fees versioned; reconciliation сверяет orders, fills,
  reservations и snapshots после restart/partial fill/unknown evidence;
- при incomplete evidence операция и метрика маркируются `Недоступно`, а не нулём.

Принятый baseline:

- PostgreSQL schema 12 хранит bounded durable executor-command queue с
  owner/session authorization fences, leases и idempotent terminal outcomes;
- trading SQLite schema 9 хранит owner-scoped portfolios, monotonic ledger
  epochs, capital reservations, mutation receipts, immutable robot-revision
  evidence, valuation marks и append-only portfolio events;
- `paper-portfolio-v1`/`paper-metrics-v1` строит fixed-decimal balances и
  evidence-aware metrics только из durable ledgers/marks;
- create/default/rename/archive/reset и robot create/control проходят через
  один fenced bridge; reset сохраняет старые epochs и требует rebind;
- UI уже имеет honest loading/error/empty states, collapsible sticky summary,
  mobile cards, desktop table/detail, filters и confirmed controls;
- robot detail уже содержит bounded realized-cash curve, evidence-aware
  performance/risk metrics, recent fills и recent ledger events без выдуманной
  истории marks.

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

Evidence приёмки:

- journal/curve, golden ledgers, restart boundaries, stale marks, concurrent
  commands и two-owner authorization прошли проверку;
- real isolated paired restore/migration/rollback drill проверил
  `executor_commands` и все canonical paper tables schema 9;
- backend/frontend, migration, browser, accessibility, visual, docs и
  protected production-smoke gates прошли;
- exact-SHA GitHub Actions были зелёными до cutover, а по ADR 0002 изменялись
  только заявленные resources проекта.

Критерий: totals до и после restart совпадают, каждая метрика имеет определённую
формулу, evidence и время, а второй tenant или администратор не может прочитать
или изменить чужой paper-портфель.

Accepted evidence: [R4 canonical paper portfolios](../evidence/R4_PAPER_PORTFOLIOS.md).

## 9. R5 — алерты, технический скринер MVP и уведомления

Статус: R5.1 принят и развёрнут; production работает на PostgreSQL schema 13
из защищённого слота `r5a-schema13-66394fd`
([R5.1 evidence](../evidence/R5_1_OWNER_ALERTS.md)). R5.2 и R5.3 не
реализованы и остаются pending, поэтому R5 в целом остаётся active.

Отдельные старые account-aware research/arbitrage alert rules и bounded outbox
не являются generic R5.1 price alerts: их engine-owned producers кандидатов и
экономики всё ещё не подключены. Общими baseline остаются canonical
candle/indicator engines и read-only арбитражный скринер.

### R5.1 — generic owner price alerts (принят)

- PostgreSQL schema 13 хранит owner-scoped rules, immutable revisions, state,
  evaluation receipts, forward-sequenced events, in-app outbox evidence и
  bounded retention; production мигрировал с schema 12 на schema 13;
- единственный server-evaluated вид — `price-threshold` на публичных закрытых
  last-price свечах Binance/Bybit. Контур только уведомляет, не читает
  credentials, не ставит ордер, не занимает актив, не меняет margin и не выдаёт
  торговую роль;
- beta limits: 100 active и 200 non-archived rules на owner, 400 total
  rule/history rows на owner и 480 globally active rules;
- один sweep берёт обычно 100, максимум 500 claims; одновременно выполняется не
  более четырёх public reads, 16 unique reads за sweep и восемь на provider.
  Одинаковые scope/cursor объединяются, насыщение одной биржи не блокирует другую;
- evaluation receipts хранятся 2 дня; events, in-app outbox, terminal delivery
  evidence, старые states/revisions и archived rules — 30 дней с bounded
  child-first compaction;
- owner-bound forward cursor `alert-event-page-v1` публикуется до сохранения
  browser checkpoint, поэтому in-app семантика намеренно at-least-once: toast
  может повториться, но невидимый event не подтверждается;
- вкладки одного owner сходятся через локальные revisions, `storage` и
  `BroadcastChannel`; сбой local storage и create/delete race fail closed;
- до принятия были обязательны и пройдены exact upgrade/recovery,
  browser-closed, multi-tab, forward-cursor, desktop/mobile accessibility и
  visual gates.

Каноническое описание: [owner-scoped server alerts](../ALERTS.md),
[русская версия](ALERTS.md) и [казахская версия](../kk/ALERTS.md).

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

Исследовательские инструменты графика:

- текстовые заметки с data-space якорем, author/time metadata и сохранением в
  owner-scoped workspace;
- parallel channel как производная двух линий с единым перемещением и
  измеряемой шириной;
- horizontal/trend/channel geometry использует один canonical contract для
  canvas, workspace export/import и серверного alert evaluator;
- mobile entry остаётся в общем bottom sheet инструментов, без отдельного
  урезанного набора.

### Remaining R5.2 alert types и R5.3 delivery

Следующие типы не входят в R5.1 и остаются pending:

- RSI, MACD, EMA/SMA cross и составные условия;
- пересечение trend line/horizontal line;
- stale data, остановка paper-бота, drawdown и исчерпание paper-капитала;
- результат сохранённого technical screen.

Remaining backend:

- расширять принятую schema 13 дальше generic price threshold можно только
  после canonical evidence contracts для indicator/drawing/screener и
  paper-robot health/drawdown; наличие schema placeholder не означает runtime;
- legacy import не должен смешивать account-aware arbitrage policy state с
  generic owner price-alert state;
- реализованный evaluation lane остаётся вне API request path; отдельный R5.3
  delivery worker добавляет retry/backoff и dead-letter, не получая trading
  authority;
- R5.1 содержит только in-app history. Telegram относится к R5.3; Web Push
  отложен до HTTPS;
- Telegram credentials не передаются research-worker. Доставку и входящие
  команды обслуживает отдельный project-owned notification service без
  публичного HTTP listener. Его delivery lane читает только PostgreSQL outbox,
  минимальный owner/channel scope и секрет из собственного защищённого
  environment file; ingress lane пишет только нормализованные Telegram updates
  и durable command records в PostgreSQL, а trading SQLite не открывает;
- HTTPS-независимый ingress использует Telegram Bot API `getUpdates` long
  polling через исходящее соединение. Webhook, публичный callback и новый
  listener запрещены, поэтому SaltanatbotV2 не требуется домен или HTTPS;
- для каждой revision bot identity одновременно работает ровно один consumer:
  PostgreSQL lease и монотонный fencing token не позволяют старому worker после
  потери lease продвигать cursor или выдавать команды;
- уникальный `(botRevision, update_id)`, durable cursor и command idempotency key
  сохраняются до изменяющей команды. Cursor продвигается только после durable
  outcome: crash до commit приводит к безопасному replay, а crash после commit
  превращает повторно полученный update в no-op и не повторяет paper mutation;
- непосредственно перед consume команда повторно проверяет активную binding
  revision, owner status/authorization epoch, принадлежность portfolio/bot и
  действующее подтверждение. Unbound, revoked и cross-owner updates fail-closed,
  не раскрывают tenant data и дают structured audit/counter;
- ingress имеет global, per-chat и per-owner rate limits, bounded update/command
  size, allowlist команд, лимит неуспешных binding/confirmation attempts и
  retry/backoff для Telegram timeout/`429`; admin role не обходит эти лимиты;
- revoke binding проверяется перед каждой попыткой; payload содержит event ID и
  deduplication ID; transport остаётся at-least-once, поэтому после crash внешний
  Telegram API теоретически может получить повторную доставку.

Telegram в paper-only режиме:

- owner-scoped привязка chat использует криптографически случайный high-entropy
  код, который хранится только как hash, имеет короткий TTL, один consume и
  ограниченное число попыток; код не попадает в URL, logs или metrics. Доступны
  просмотр привязок и немедленный revoke из веб-интерфейса;
- `/balance` возвращает только paper balance; также доступны `/daily`, `/profit`,
  `/performance`, `/trades`, `/alerts`;
- `/pause`, `/resume`, `/stop` доступны только для своих paper-ботов. Каждое
  подтверждение является отдельным high-entropy одноразовым token, связано с
  owner/chat/action/portfolio/bot revision/authorization epoch, имеет короткий
  TTL и повторно проверяется при final consume;
- никакой передачи токенов, ключей или приватной биржевой телеметрии.

R5.1 release gate: schema 12→13/checksum/no-op migration, real unprivileged
PostgreSQL owner/quota/capacity/retention/forward-cursor tests,
browser-closed restart/dedupe, forged/stale evidence rejection, local-storage
failure, create/delete race, multi-tab convergence и desktop/mobile
accessibility/visual checks. Эти gates пройдены; acceptance и production
cutover зафиксированы в [R5.1 evidence](../evidence/R5_1_OWNER_ALERTS.md).

Полный критерий R5: R5.1 отдельно принят; значение R5.2 screener совпадает с
графиком на той же закрытой свече; алерт работает с закрытым браузером и не
раскрывает чужие presets/rules/deliveries; R5.3 допускает повтор внешней
Telegram-доставки после crash только с тем же deduplication ID. Long-poll
consumer takeover, lease loss, duplicate/replayed/out-of-order updates, crash
до/после durable cursor, Telegram timeout/`429`, истечение/перебор/replay кодов,
revoke race и cross-owner команды покрыты failure tests; один `update_id`
создаёт не более одной durable paper mutation после restart или takeover.

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
- маршруты оцениваются только по публичным рыночным данным в реальном времени;
  private/signed network calls отсутствуют, ордера не отправляются.

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
- до schema/job API R9.1 и первого evolutionary run закрывается решение D2:
  фиксируются canonical Strategy IR, versioned dataset contract и
  воспроизводимый backtest engine.

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

### R9.3 — безопасная витрина стратегий

- стратегия публикуется только явным действием владельца как immutable
  versioned artifact; приватный workspace, результаты других запусков и
  owner-identifiers не попадают в публикацию;
- карточка показывает markets/timeframes, engine/dataset fingerprints,
  in-sample и out-of-sample метрики, drawdown, complexity, дату и ограничения;
- импорт создаёт отдельную копию у получателя и требует повторной валидации,
  backtest и явного paper-запуска; публикация никогда не запускает робота;
- доступны private/unlisted/public visibility, moderation/revoke и provenance;
- рейтинг не строится только по доходности: учитываются OOS stability,
  drawdown, turnover, возраст evidence и reproducibility.

Критерий: опубликованный artifact воспроизводится по зафиксированным версиям,
не раскрывает tenant-owned данные и не может незаметно измениться после импорта.

## 14. R10A — корпус L2, funding/OI/ликвидации и MTF

Статус: pending delta. Baseline: admin-only upload/in-memory L2 reconstruction,
quality gates и отдельные public sequence/checksum-aware adapters уже существуют.
Нет online collector, durable corpus и принятого календарного soak.

### Сбор корпуса L2

- sequence-aware L2 snapshots/deltas и trades;
- gap detection, reconnect boundaries и clock calibration;
- bounded retention, compression и downsampling;
- venue/symbol/market schema и quality score;
- лицензирование и политика хранения для каждого источника;
- до online ingest закрывается решение D3 с точными venues/native symbols,
  разрешениями источников, retention/downsampling и deletion policy;
- до включения ingest фиксируются bytes/sec, network и прогноз disk/day/month;
- данные пишутся только в project-owned path с soft/hard high-watermarks;
- hard watermark автоматически останавливает ingest до заполнения общего диска;
- retention/downsampling проверяются restore/replay тестом, а не только config;
- отдельный календарный soak нужен для накопления репрезентативных режимов рынка;
  его нельзя заменить параллельным CPU.
- минимальный corpus gate: не менее четырёх календарных недель, collector uptime
  не ниже 95%, не менее 99,9% schema-valid retained events и несколько
  зафиксированных режимов волатильности/ликвидности; итоговый soak продолжается
  4–8 недель и публикует пропуски, coverage и прогноз роста хранилища.

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
derivatives data визуально и в API отличается от нормального нуля; числовой
duration/uptime/schema-quality corpus gate пройден до начала обучения модели.

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

Критерий: gap/stale data не порождает сигнал; модель не маркирует событие как
факт, если это только вероятностная интерпретация. Кандидат принимается только
если на untouched time-based test set превосходит зафиксированный baseline,
проходит calibration, leakage audit, детерминированный replay и лимиты
inference latency/CPU/RAM; rollback к предыдущему champion воспроизводим.

## 16. R11 — архитектура и operational proof для примерно 100 активных пользователей

R11 не является первым этапом operational hardening. Базовые caps, метрики,
readiness, backup generation и workload harness наращиваются в R3–R10; здесь
они объединяются в один воспроизводимый capacity/failure proof по
[плану первых 100 активных пользователей](../CAPACITY_100_USERS.md).

Принятый R5.1 уже содержит собственные beta limits 100/200/400/480,
scheduler admission 4/16/8 и retention 2/30 дней; они приняты в
production, но не имеют integrated 100-user evidence. R11 остаётся pending и не
может быть заменён размером текущего сервера или unit/integration тестами.

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

- измерить и настроить уже реализованный process-wide API admission, проверить
  принятый R5.1 alert cap под общей нагрузкой, затем добавить недостающие global
  caps для WebSocket, robots, jobs, screener и L2;
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
| R3 | user lifecycle, server workspaces, onboarding/PWA boundary | R1–R2 | завершено | schema 11 + two-tenant isolation + fresh account journey приняты |
| R4 | Running, paper account/portfolio, metrics/journal | R1–R3 | завершено | golden ledger + restart reconciliation приняты |
| R5 | unified alerts, technical screener MVP, notification worker/Telegram | R3–R4 | 5–7 | chart parity + at-least-once outbox drill |
| R6 | common paper engine completion + DCA | R4–R5 | 3–4 | deterministic DCA replay |
| R7 | Grid на общем paper engine | R4–R6 | 4–5 | gap/restart/capital proof |
| R8 | durable spread/multi-leg paper execution | R4–R5 | 4–6 | leg-risk/unwind replay |
| R9 | multi-market generator/genetic server pipeline | R1 + R4 portfolio metrics + canonical IR/dataset/backtest | 5–8 | seeded OOS/Pareto promotion |
| R10A | funding/OI/MTF + bounded L2 collector/storage | R1 + public data contracts | 3–5 + 4–8 календарных недель soak | storage forecast + corpus quality |
| R10B | ML registry/model/UI | R10A corpus | 5–8 | promotion/rollback/drift proof |
| R11 | integrated 100-user capacity proof | accepted workload contracts | 5–9 | SLO/headroom/RPO/RTO report |
| R12 | fresh clone, coordinated restore, upgrade, docs/final audit | R2–R11 | 2–4 | clean-host self-host smoke |

Порядок принятия, публикации в `main` и production cutover оставшейся работы
строго последовательный от следующего pending инкремента: R5 → R6 → R7 → R8 →
R9 → R10A → R10B → R11 →
R12. Оставшийся ручной device/AT
evidence R2 ведётся отдельно и не разрешает смешивать код будущих релизов.
HTTPS/live не входят в эту последовательность.

### 18.1. Исполнимый backlog по поставляемым инкрементам

Инкремент закрывается целиком: schema/API → backend → frontend → migration →
tests/evidence → docs/rollback → production smoke. Частично готовый инкремент не
получает статус `done`.

| Инкремент | Результат | Главный gate |
| --- | --- | --- |
| R2.1 | drawing-tools sheet, gesture FSM, safe-area и mobile dense cards | touch/rotation E2E |
| R2.2 | landscape/tablet/desktop matrix, accessibility и visual baselines | Chromium + Firefox + visual green |
| R2.3 | chart-only runtime, armed-alert-only quotes, hidden subscription release, O(1) provisional candle tail и threshold-enforced browser soak приняты; ручные Android Opera/assistive-tech smoke остаются | device/AT record |
| R3.1 | pending/active/disabled, роли только research/read-only/paper, sessions/revoke и admin audit | two-tenant lifecycle isolation |
| R3.2 | полный workspace document, explicit save/conflict/error, quotas и import/export | reload/two-tab/rollback tests |
| R3.3 | onboarding, empty states, docs links и HTTP-safe PWA boundary | fresh-account journey |
| O1 | SQLite integrity/retention, logs, metrics, readiness и global admission foundation | crash/overload/backup smoke |
| R4.1 | done: канонический paper account, reservations и versioned order/fill/event contract приняты | golden ledger + restart пройдены |
| R4.2 | done: экран «Запущено», bounded journal, equity/PnL/drawdown и mobile/desktop UX приняты | reconciliation + tenant isolation пройдены |
| R5.1 | done: PostgreSQL generic owner `price-threshold` rules/events/in-app outbox и bounded scheduler приняты и развёрнуты на schema 13 | schema-13 upgrade + cursor/multi-tab/mobile + closed-browser restart/dedupe пройдены |
| R5.2 | pending: технический скринер на canonical indicator engine | chart/screener parity |
| R5.3 | pending: notification worker, Telegram binding/revoke и paper-only команды | at-least-once delivery drill |
| R6 | DCA paper state machine и worst-case capital preview | deterministic replay |
| R7 | Grid paper state machine, gap/recenter/restart handling | capital/no-duplicate proof |
| R8.1 | единая spread normalization, freshness, depth и economics | rejected-reason/reference fixtures |
| R8.2 | owner-scoped multi-leg paper intent, leg risk и unwind | partial-fill/restart replay |
| R9.1 | generic research job registry и server multi-market evaluation | owner fairness + cancellation |
| R9.2 | GA/generator lineage, Pareto/OOS, checkpoint/resume | seeded reproducibility |
| R9.3 | versioned strategy gallery, provenance, safe import и revoke | privacy + reproducible artifact |
| R10A.1 | funding/OI/liquidations/MTF contracts и общий stream foundation | units/freshness/replay parity |
| R10A.2 | bounded L2 collector, manifests, watermarks и retention | restore/replay + disk forecast |
| R10A.3 | календарный L2 soak 4–8 недель | corpus quality report |
| R10B.1 | dataset/model registry, lineage, champion/challenger и rollback | reproducible promotion |
| R10B.2 | inference/drift/abstain и evidence UI | replay + degraded-mode proof |
| R11 | 10→25→50→100-user load, burst, overload и failure drills | SLO/RPO/RTO + ≥30% headroom |
| R12 | fresh clone, isolated restore, upgrade и полный self-hosting audit | clean-host evidence index |

### 18.2. Последовательное исполнение и внутренняя параллельность

- Код, миграции и UI следующего релиза не попадают в `main` или production до
  полного принятия предыдущего релиза.
- После фиксации контрактов внутри одного текущего инкремента параллельно могут
  выполняться repository/schema, frontend, тесты и документация.
- Незавершённые state machines и PostgreSQL migration chains разных релизов не
  смешиваются.
- Календарный soak R10A может продолжаться фоном только как сбор evidence; R10B
  не начинается и не принимается до corpus gate.
- Метрики, quotas, load fixtures и backup evidence добавляются в релизе,
  создающем нагрузку; R11 объединяет их в итоговый сценарий.

### 18.3. Ближайшая очередь работ

1. Сохранять принятый R4 schema-12/schema-9 release и его checksummed recovery
   evidence неизменяемыми; R5 переиспользует owner/paper-ledger boundaries и не
   создаёт второй system of record.
2. Выполнено: R5.1 проверен по schema-13 upgrade, owner isolation,
   forward-cursor, multi-tab, mobile и recovery gates, принят и развёрнут;
   exact-SHA acceptance/cutover evidence зафиксировано в
   [R5.1 evidence](../evidence/R5_1_OWNER_ALERTS.md).
3. Зафиксировать и реализовать pending contracts R5.2 technical screener и R5.3
   notification/Telegram, затем получить chart/screener parity, bounded delivery
   и isolated recovery evidence.
4. Не допускать R6 и более поздний код в `main` или production до полной
   приёмки R5.

Ручные Android Opera и VoiceOver/NVDA/TalkBack evidence для R2.3 остаются
отдельной проверочной задачей и не меняют последовательность продуктовых
инкрементов.

### 18.4. Покрытие ключевых выводов свежего аудита

| Вывод аудита | Где закрывается |
| --- | --- |
| Алерты умирают вместе с вкладкой; мало типов условий | Generic `price-threshold` закрыт принятым и развёрнутым R5.1. Indicator/drawing/screener alerts остаются R5.2, notification worker — R5.3 |
| Нет DCA и Grid | R6 и R7 поверх общего R4 paper ledger |
| Аналитика запущенных роботов | Закрыто принятым R4.1–R4.2: reservations, reconciliation, equity/PnL/drawdown/journal |
| Нет funding/OI/liquidations и MTF | R10A.1 |
| Нет обычного технического скринера | R5.2 |
| Нет текста/заметок и parallel channel | R5 research chart tools на общем geometry contract |
| Шаринг стратегий односторонний | R9.3: versioned gallery и безопасный import |
| Split-brain PostgreSQL/SQLite и один process executor | ADR 0001, O1, R4 и итоговый R11 fencing proof |
| Несколько несовместимых public WebSocket реализаций | O1/R11 единый resilient transport |
| Нет структурных логов, компрессии, WAL/retention и видимого coverage | O1 и правила приёмки каждого релиза |
| CI checks могут быть необязательными | release rule 15: ruleset либо документированный owner-only эквивалентный gate |
| Testnet/live execution не проверяется автоматически | намеренно вне pre-HTTPS; не является заявленной возможностью Research/Paper-релиза |

## 19. Справочная граница вне backlog: возможный будущий HTTPS/security roadmap

Перечисленные ниже условия не являются задачами, зависимостями или блокерами
R0–R12. В этом плане нет задач «временно включить live». Только если владелец
отдельно инициирует новый roadmap, ему потребуется отдельное security-решение:

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
