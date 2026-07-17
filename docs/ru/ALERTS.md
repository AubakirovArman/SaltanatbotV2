# Серверные алерты с изоляцией пользователей

English reference: [ALERTS.md](../ALERTS.md).
Қазақша нұсқа: [kk/ALERTS.md](../kk/ALERTS.md).

Документ описывает контур алертов R5.1, добавляемый PostgreSQL schema 13. Это
исключительно исследовательская система уведомлений. Она не может выставить
ордер, занять актив, изменить маржу, подписать запрос биржи или выдать торговую
роль.

## Что входит в R5.1

Сервер умеет оценивать один тип правила:

- `price-threshold`;
- публичные данные Binance или Bybit;
- идентичность рынка `spot`, `linear` или `inverse`;
- только last price;
- таймфреймы `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `1w`;
- включительное условие `above`/`below`;
- одно срабатывание до явного повторного взведения;
- долговечная история внутри приложения.

Календарный месяц `1M` исключён: его нельзя однозначно представить фиксированным
числом миллисекунд. Telegram тоже не входит в R5.1. Наличие заготовок таблиц не
включает Telegram: привязка, отзыв, provider ACK и retry-доставка относятся к
R5.3.

Evaluator не читает ключи биржи. Он использует прямые публичные REST-свечи и
отклоняет синтетические, приватные, кэшированные или подменённые данные.

## Граница HTTP без HTTPS

Текущий pre-HTTPS релиз намеренно не настраивает TLS. Пароль и session cookie
должны передаваться только внутри доверенной локальной сети, приватного VPN или
SSH-туннеля. Нельзя выставлять эту сборку как общедоступный login-сервис в
Интернет и нельзя добавлять в неё приватные ключи биржи. HTTPS — отдельный
release gate.

## Поток данных

```text
авторизованный браузер
  -> локальный durable intent
  -> owner-scoped mutation /api/alerts
  -> PostgreSQL rule + неизменяемая revision
  -> lease исследовательского worker
  -> точная публичная закрытая свеча
  -> fenced state revision + неизменяемый receipt
  -> event + outbox + in-app delivery
  -> owner-forward cursor
  -> история/toast браузера
```

До сетевого запроса браузер сохраняет идемпотентный `clientId`. Сервер сначала
создаёт выключенный draft. Только после долговечной остановки браузерного
evaluator reconciliation включает серверную revision. Поэтому один сохранённый
алерт не оценивается одновременно вкладкой и сервером.

## Семантика закрытых свечей

Сервер оценивает только окончательно закрытые свечи. Алерт может оставаться
взведённым до закрытия выбранного таймфрейма.

Первая точная свеча, содержащая серверное время взведения, задаёт исходное
состояние условия и не может быть подделана в trigger. Уведомление требует
следующего доказанного перехода `false -> true`. Один completion двигает ровно
одну свечу и одну state revision. После долгой остановки worker запрашивает
историческую свечу взведения и догоняет историю по одной закрытой свече, ничего
не перескакивая.

Threshold сравнивается как точное десятичное значение с кратчайшим десятичным
представлением наблюдаемой JavaScript-цены. Более точный threshold не округляется
до double. Например, `64703.52` меньше `64703.520000000001`.

Формирующиеся, будущие, stale, неполные, разорванные, слишком большие и
повреждённые окна свечей fail closed. Ещё не закрытая здоровая свеча
переносится на ожидаемое время закрытия и не считается ошибкой.

## Изоляция и авторизация

Владелец каждого чтения и mutation берётся из database-session. Клиент также
обязан передать `X-SBV2-Expected-User` с тем же ID. Так смена аккаунта в открытой
вкладке обнаруживается до синхронизации локального состояния с другим tenant.

Для mutations действует обычный CSRF header. В транзакции повторно проверяются:

- активный статус пользователя;
- `must_change_password = false`;
- текущая authorization revision;
- actor совпадает с owner;
- ожидаемая revision правила;
- owner/token/generation/expiry worker lease.

У администратора нет обходного API для чтения или изменения чужих алертов.
Публичные projection не содержат destination, credential, password, lease token
или authorization revision.

## Lifecycle и восстановление браузера

В интерфейсе используются состояния:

1. **в очереди** — локальный intent сохранён и ждёт sync;
2. **синхронизация** — выключенный серверный draft существует, браузерная копия
   инертна;
3. **взведён** — evaluator принадлежит серверу;
4. **сработал** — переход зафиксирован, правило выключено до rearm;
5. **stale/error** — доказательство отклонено; уведомление и торговое действие не
   подразумеваются;
6. **архив** — правило больше не оценивается и уйдёт через bounded retention.

Удаление оставляет инертный локальный tombstone. Если delete гоняется с create,
вернувшийся выключенный draft архивируется и не появляется снова. Если после
серверного archive ломается localStorage, локальная запись остаётся suspended и
не может снова начать браузерную оценку после reload.

Вкладки одного владельца объединяют локальные Lamport revision через `storage`
event и `BroadcastChannel`. Перед каждым браузерным переходом price feed ещё раз
читает durable snapshot — это последний барьер от устаревшей in-memory копии.

## API

Все пути требуют database-auth, rate limit и возвращают `Cache-Control:
no-store`.

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/alerts?limit=200` | Управляемые правила; сначала неархивные |
| `POST` | `/api/alerts` | Идемпотентное создание по `clientId` |
| `GET` | `/api/alerts/:id` | Одно правило владельца |
| `PUT` | `/api/alerts/:id` | Новая definition с `expectedRevision` |
| `POST` | `/api/alerts/:id/archive` | Архивирование |
| `DELETE` | `/api/alerts/:id` | Совместимый alias архивирования |
| `POST` | `/api/alerts/:id/rearm` | Новая взведённая revision |
| `GET` | `/api/alerts/events?limit=200&cursor=…` | Durable forward event stream |
| `GET` | `/api/alerts/outbox?limit=200` | Состояние in-app delivery |

Ответ событий имеет schema `alert-event-page-v1` и всегда содержит непрозрачный
owner-bound `nextCursor`, `hasMore`, `generatedAt` и не более 200 событий. До
сохранения watermark клиент обязан прочитать все страницы `hasMore=true`.
Cursor другого владельца отклоняется. Cursor, оказавшийся впереди восстановленной
БД, возвращает `alert_event_cursor_ahead` и требует нового baseline.

Тело запроса ограничено 65 536 байтами. Неизвестные поля, неподдерживаемые
delivery channel, неканонические envelope и limit больше 200 отклоняются.

## At-least-once in-app delivery

У каждого owner есть транзакционный счётчик событий. Trigger сериализует выдачу
sequence одному владельцу: более поздняя транзакция не может закоммитить видимую
sequence впереди незавершённого раннего события. Разные владельцы друг друга не
блокируют.

Браузер сначала показывает новую cursor-page и только затем сохраняет checkpoint.
Падение может повторить toast, но не может подтвердить невидимое уведомление.
Это намеренная семантика at-least-once. Event ID и transition key позволяют
дедуплицировать retry.

Для канала `in-app` статус `delivered` означает «доступно в приложении», а не
«человек прочитал toast». Именно так статус подписан в R5.1. Provider ACK
Telegram имеет другую семантику и пока не активен.

Cursor хранится отдельно для владельца. Если localStorage недоступен, UI
показывает ошибку sync и не двигает cursor; следующий retry может повторить
уведомление.

## Квоты и admission

Консервативные beta-границы R5.1:

| Граница | Лимит |
| --- | ---: |
| Активные правила владельца | 100 |
| Неархивные правила владельца | 200 |
| Все rule/history записи владельца | 400 |
| Глобально активные правила | 480 |
| Claim за sweep | обычно 100, максимум 500 |
| Одновременные публичные scope | 4 |
| Уникальные public reads за sweep | 16 |
| Reads одной биржи за sweep | 8 |
| Свечи initial/continuation read | 1 |

Переход в глобально active сериализован отдельным PostgreSQL advisory
transaction lock. Потолок 480 соответствует восьми уникальным минутным
evaluation в секунду в худшем случае одной биржи. Одинаковые scope/cursor reads
объединяются. Насыщение одной биржи не блокирует вторую: её правило освобождается
с bounded retry.

Поднимать границы или обещать SLA на 100 пользователей можно только после
отдельного R11 soak из [CAPACITY_100_USERS.md](../CAPACITY_100_USERS.md).

## Retention и метрики

Research worker запускает alert compaction существующим retention timer:

- evaluation receipts — 2 дня;
- events, outbox, terminal deliveries, старые states/revisions — 30 дней;
- archived rules — 30 дней после удаления зависимостей.

Один run использует неблокирующий advisory lock, `SKIP LOCKED`, batch 1000,
потолок 6000 строк и time budget 2 секунды. Сначала удаляются дочерние строки,
потом неизменяемые parents.

Structured logs показывают active/due/leased/archived/error rules, возраст самого
старого due, свежие evaluations/triggers, reads/coalescing, admission deferral и
ошибки scheduler. Owner ID, destination и secret в логи не попадают.

## PostgreSQL schema 13

Добавляются таблицы:

- `alert_rules`;
- `alert_rule_revisions`;
- `alert_rule_states`;
- `alert_evaluation_receipts`;
- `alert_event_sequences`;
- `alert_rule_events`;
- `notification_bindings`;
- `notification_outbox`;
- `notification_deliveries`;
- `alert_rule_import_receipts`.

Revision, receipt, event и outbox запрещено обновлять. Composite owner foreign
keys не допускают cross-tenant связи. Retention удаляет immutable history в
заданном порядке зависимостей.

## Upgrade и rollback

Перед переходом с schema 12:

1. собрать и проверить exact commit;
2. остановить research worker;
3. создать и проверить paired project backup;
4. восстановить backup в отдельную маркированную БД и выполнить drill;
5. остановить API;
6. запустить exact API release и checksum-locked migration schema 13;
7. проверить health/readiness, owner isolation и no-op restart миграции;
8. запустить research worker и проверить метрики alert lane;
9. создать post-upgrade backup и повторить isolated restore.

Нельзя удалять строки schema 13 или уменьшать `schema_migrations` ради rollback.
Нужно восстановить pre-upgrade PostgreSQL backup в новую project-marked БД,
вернуть парные runtime data и запустить защищённый R4 release slot. Неудачную
schema 13 БД сохраняют как evidence инцидента.

См. [MIGRATIONS.md](../MIGRATIONS.md),
[BACKUP_RESTORE.md](../BACKUP_RESTORE.md),
[STARTUP_RECOVERY.md](../STARTUP_RECOVERY.md) и
[RELEASING.md](../RELEASING.md).

## Проверка релиза

Release gate включает:

- generated contract check;
- route/auth/CSRF/owner-change tests;
- real unprivileged PostgreSQL migration, repository, capacity, retention и
  forward-cursor tests;
- forged trigger, skipped cursor, stale revision, duplicate receipt и
  cross-revision replay;
- localStorage failure, create/delete race, multi-tab convergence и first-poll
  notification;
- browser-closed restart/dedup acceptance;
- desktop/mobile accessibility и visual regression;
- exact-commit GitHub CI и backup/restore/rollback evidence.

R5.2.1 добавляет отдельный [технический скринер по запросу](./SCREENER.md); он
выполняет сканы, а не алерты, и зарезервированный rule kind `screener` остаётся
заготовкой до появления превращения скана в алерт. R5.3 добавит отдельный
notification worker и Telegram binding/revoke/delivery.
