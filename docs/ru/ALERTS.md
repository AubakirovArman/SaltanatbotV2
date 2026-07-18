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

## Скринер-алерты (R5.3a)

R5.3a добавляет второй серверный rule kind — `screener`: сохранённый
[технический скан](./SCREENER.md) превращается в долговечный алерт «по
изменению». Инкремент принят и задеплоен без миграции схемы; запись приёмки
и cutover — [R5.3a evidence](../evidence/R5_3A_SCREENER_ALERTS.md).
Как и любой алерт, это исключительно исследовательское уведомление:
`researchOnly: true`, `executionPermission: false`, выставить ордер нельзя.

Screener-правило встраивает полный документ `screener-definition-v1` по
значению. Встроенный скан неизменяем вместе с revision правила;
редактирование создаёт новую revision со своим определением. Новой PostgreSQL
schema нет: правило, его durable state и receipts помещаются в существующие
таблицы алертов schema 14.

### Семантика «по изменению»

Worker оценивает встроенный скан только по закрытым свечам и сравнивает
полный набор совпавших символов (до усечения результата) с долговечным
предыдущим набором:

- первая оценка инициализирует baseline без срабатывания;
- trigger требует, чтобы эффективный набор отличался от предыдущего;
- вошедшие и вышедшие символы перечисляются в summary события, максимум 12
  символов в тексте;
- title envelope — `Screen match changed: <name>`; body перечисляет
  вошедшие/вышедшие символы и число совпадений;
- после срабатывания правило **остаётся активным** и продолжает оцениваться;
  rearm не нужен. `POST /api/alerts/:id/rearm` остаётся только для
  price-правил и отвечает `409 alert_rearm_unsupported` для screener-правила.

Недоступные символы — **неизвестные, а не вышедшие**: прежний участник,
недоступный в этом запуске, остаётся участником, а прежний неучастник —
неучастником. Если недоступно больше 30% запрошенной вселенной, оценка
переносится без продвижения state (`screener-availability-floor`).

`cooldownSeconds` (0–86 400; браузерное значение по умолчанию при превращении
— 3600) устанавливает `cooldown_until` при каждом срабатывании. Во время
cooldown наблюдаемое изменение переносится без продвижения state, поэтому
после окончания cooldown изменение всё равно срабатывает, а не проглатывается
молча.

### Каденция, worker lane и доставка

Каденция оценки выводится из таймфрейма скана (`5m` → 300 с, `15m` → 900 с,
`1h` → 3600 с, `4h` → 14 400 с, `1d` → 86 400 с) с ограничением 300–86 400
секунд. Research worker допускает не более одной оценки screener-алерта за
sweep под lease 300 секунд с бюджетом сбора данных 90 секунд и публикует
отдельный блок метрик screener-alert lane. Completion записывает неизменяемый
receipt (producer `screener-alert-worker`), событие, outbox и pre-delivered
in-app строку в одной транзакции; transition key дедуплицирует повторы.

В принятом релизе R5.3a доставка — только `in-app`: screener-правило с
каналом `telegram` отклоняется явным `400`, как и любой другой
неподдерживаемый канал. Инкремент R5.3b-1 (в работе, см. ниже) расширяет эту
проверку: канал `telegram` принимается и для price-threshold, и для
screener-правил.

### Квоты screener-алертов

| Граница | Лимит |
| --- | ---: |
| Включённые screener-правила владельца | 5 |
| Глобально активные screener-правила | 40 |

Screener-правила также считаются внутри общих лимитов R5.1 (100/200/480);
действуют оба ограничения. Превышение отображается в
`429 screener_alert_quota_exceeded` и
`429 screener_alert_capacity_exhausted`.

## Доставка в Telegram и привязка чата (R5.3b-1, в работе)

R5.3b-1 добавляет отдельный notification worker, который доставляет
уведомления алертов в Telegram и привязывает один приватный чат к одному
владельцу через одноразовые коды. Инкремент **в работе и не является принятым
релизом**: production по-прежнему выполняет принятый слот R5.3a, где канал
`telegram` отвечает `400`. Как и вся система алертов, это исключительно
исследовательские уведомления: worker не открывает HTTP-listener, никогда не
открывает торговый SQLite и не может выставить ордер. Команды бота, кроме
`/start`, `/bind` и статичного ответа-заглушки, относятся к R5.3b-2.

### Жизненный цикл привязки

1. Владелец запрашивает одноразовый код
   (`POST /api/alerts/bindings/codes`). Сырой код из 26 символов base32
   возвращается ровно один раз вместе со сроком действия; хранится только его
   SHA-256, код никогда не логируется. Код живёт 10 минут; одновременно не
   больше 3 неиспользованных кодов на владельца
   (`429 binding_code_quota_exceeded`) и не больше 10 кодов за 10 минут
   (`429 binding_code_rate_limited`).
2. Владелец отправляет `/start <код>` или `/bind <код>` боту оператора в
   **приватном** чате. Worker потребляет код под блокировкой строки и
   активирует привязку в той же транзакции. Потребление одноразовое:
   неизвестный, просроченный или уже использованный код получает статичный
   ответ об ошибке и учитывается в лимите попыток чата.
3. У владельца не больше одной активной привязки. Потребление нового кода при
   активной привязке отзывает старую и активирует новую в одной транзакции.
4. `POST /api/alerts/bindings/:id/revoke` с `{"expectedRevision": n}`
   отзывает привязку и отменяет её очереди/retry Telegram-доставки в той же
   транзакции. Устаревшая revision получает `409 binding_revision_conflict`.

`GET /api/alerts/bindings` возвращает привязки владельца с хэшированным
идентификатором получателя из 8 символов, статусом, revision и временными
метками. Ответы, projection и логи никогда не содержат сырой chat id, сырой
код или токен бота. Сама строка привязки хранит chat id (он нужен для
отправки) и его SHA-256-отпечаток; ни то, ни другое не покидает сервер.
Маршруты привязок работают под тем же стеком
session/CSRF/`X-SBV2-Expected-User`, что и `/api/alerts`, возвращают
`Cache-Control: no-store`, тело запроса ограничено 4 096 байтами.

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/alerts/bindings` | Привязки владельца (только хэшированные идентификаторы) |
| `POST` | `/api/alerts/bindings/codes` | Одноразовый код; сырой код возвращается один раз |
| `POST` | `/api/alerts/bindings/:id/revoke` | Отзыв с `expectedRevision`; отменяет ожидающие доставки |

### Семантика доставки

Если каналы доставки правила включают `telegram` и на момент completion у
владельца есть активная привязка, транзакция completion вставляет очередную
Telegram-доставку рядом с pre-delivered in-app строкой. Без активной привязки
Telegram-доставка молча пропускается (только счётчик), in-app строка всё
равно доставляется. Worker забирает готовые строки через существующий lease
fence (`FOR UPDATE SKIP LOCKED`, одна отправляемая строка на владельца),
повторно проверяет точную revision привязки непосредственно перед отправкой
и отправляет обычный текст **без parse mode**: title и body envelope плюс
подпись «SaltanatbotV2 research/paper notification». Исходы: `delivered`
(receipt с message id провайдера), `retrying` (backoff 30 с × 2^attempt с
потолком 15 минут) или `dead_letter`; отозванная привязка отменяет строку как
`binding_revoked`.

Внешняя доставка — **at-least-once**: падение между отправкой в Telegram и
долговечным подтверждением может повторить сообщение после истечения lease.
Retry использует тот же deduplication key, а доставки остаются уникальными по
(owner, channel, deduplication key).

### Worker, ingress и приватность

Worker — третий, необязательный supervised-процесс (см.
[Self-hosting](../SELF_HOSTING.md)). Токен бота читается только из
owner-only файла `TELEGRAM_BOT_TOKEN_FILE`, проверяемого как торговый
master key (обычный файл без symlink, владелец — service uid, режим
`0600`/`0400`). Отсутствующий или некорректный файл оставляет worker в idle с
живым heartbeat — перепроверка раз в минуту, без crash-loop; readiness API на
хостах без worker не меняется, пока не установлен
`OPERATIONS_REQUIRE_NOTIFICATION_WORKER=1`. Токен никогда не попадает в
логи, метрики и ошибки; во всех остальных местах бот идентифицируется
SHA-256-отпечатком токена. Worker никогда не выполняет миграции: при
несовпадении версии схемы он остаётся в idle и сообщает об этом.

Входящие обновления используют только исходящий long-poll `getUpdates` — без
webhook и без нового listener. Fenced-lease единственного потребителя (60 с,
монотонная generation при перехвате) гарантирует один poller на бота, а
долговечный cursor `(bot, update_id)` продвигается в той же транзакции, что и
исходы батча, поэтому повтор батча — no-op. Разбираются только текстовые
сообщения приватных чатов; групповые чаты и не-message обновления
записываются как ignored, а любое другое приватное сообщение получает
статичный ответ «команды появятся в R5.3b-2». Хранимые ingress-строки только
нормализованы — хэшированный отпечаток чата, kind и outcome — никогда текст
сообщения или сырой chat id.

### Лимиты Telegram

| Граница | Лимит |
| --- | ---: |
| Неиспользованные коды владельца | 3 |
| Создание кодов владельцем | 10 / 10 мин |
| TTL кода | 10 мин |
| Активные привязки владельца | 1 |
| Отправки, весь бот | 25 / с |
| Отправки в один чат | 1 / с |
| Отправки одного владельца | 10 / мин |
| Обработанные команды из чата | 6 / мин |
| Попытки кода привязки из чата | 5 / 10 мин |

Администраторы эти лимиты не обходят. Ответ Telegram `429 retry_after`
откладывает отправку с ограниченным backoff.

### PostgreSQL schema 15 (кандидат)

Миграция 15 `telegram_notification_ingress` аддитивна: добавляются
`notification_bindings.recipient_chat_id`, таблица хэшированных одноразовых
кодов `notification_binding_codes`, fenced-строка lease/cursor
`telegram_ingress_consumers` и нормализованный dedup-журнал
`telegram_updates`. Миграция выполняется только в процессе API внутри
существующей checksum-locked цепочки под advisory lock; приёмка проходит ту
же процедуру backup/isolated-restore/cutover, что schema 13 и 14.

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

R5.2.1 добавляет отдельный [технический скринер по запросу](./SCREENER.md);
он выполняет сканы по запросу, а R5.3a превращает скан в описанный выше rule
kind `screener`. Отдельный notification worker и Telegram
binding/revoke/delivery — это описанный выше инкремент R5.3b-1 (в работе);
расширенные входящие команды бота остаются в R5.3b-2.
