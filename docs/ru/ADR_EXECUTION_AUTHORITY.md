# ADR: полномочия исполнения и system of record

Статус: принято
Дата: 2026-07-16

## Контекст

PostgreSQL хранит пользователей, сессии, рабочие пространства и исследовательские задачи. Один
торговый executor владеет защищённой SQLite с аккаунтами бирж, credentials, роботами и журналами.
Между двумя БД нет общей атомарной транзакции, поэтому это нельзя скрывать условным boolean-флагом.
Развёрнутый профиль остаётся `public-http-paper`: это решение не включает private/live.

## Решение

1. PostgreSQL — system of record для пользователей, сессий, монотонной authorization revision,
   workspaces, research jobs и будущих tenant alert policies/outbox.
2. Защищённая SQLite — system of record для exchange accounts/credentials, account и credential
   revisions, owner arm epoch, роботов и execution journals. Ей владеет ровно один процесс под
   существующей coordination lock.
3. Прямые dual writes запрещены. Cross-store команда сначала получает durable command ID в
   PostgreSQL. Единственный executor идемпотентно применяет её в SQLite, сохраняет тот же ID в
   журнале и лишь затем подтверждает PostgreSQL.
4. Execution permit — внутренний, короткоживущий и process-local. Broker хранит только hash токена,
   связывает его с ревизиями обеих БД, а restart уничтожает все незавершённые permits.
5. Каждый точный signed network step получает отдельный permit. Handoff engine→adapter и атомарный
   consume непосредственно перед I/O — разные переходы. Универсального permit на compound order нет.
6. Отзыв роли сначала синхронно увеличивает process authorization epoch. Account mutation,
   credential rotation и arm/disarm увеличивают SQLite revisions внутри `BEGIN IMMEDIATE`. Final
   consume повторно проверяет все ревизии и при неопределённости запрещает сеть.
7. Emergency operation разрешает только private-read, cancel и доказуемый reduce-only. Entry,
   создание protection, account settings и debt increase запрещены.
8. Research worker работает только с PostgreSQL, не открывает trading SQLite и не получает ключи
   бирж или Telegram.
9. Старые alert blobs в SQLite считаются legacy single-operator state. Multi-user policies/outbox
   переносятся в PostgreSQL однократно и идемпотентно; исходные строки не удаляются до сверки.
10. До любого будущего включения `private-live` отзыв полномочий обязан иметь durable-контракт
    снижения риска. Либо cancel/reduce-only завершаются до того, как owner теряет необходимые
    полномочия, либо отдельный аутентифицированный owner-scoped системный emergency principal
    выполняет только доказуемо снижающие риск действия. Отозванная browser session или роль
    пользователя не может оставаться единственным полномочием для закрытия уже существующей
    экспозиции.
11. Durable replay key обязан запрещать повторное использование exact-step identity всё время, пока
    этот identity может появиться снова. До live activation archive/partition lookup должен
    сохранять эту проверку и не позволять lifetime cap владельца блокировать emergency или
    reconciliation.

## Контракт восстановления

- Crash до consume: сетевой запрос не разрешён, permit истекает.
- Crash после consume без доказанного ответа: intent получает `unknown`, permit не используется
  повторно, перед новым intent обязательна reconciliation.
- Команда есть в PostgreSQL, но нет SQLite ACK: executor сверяет тот же command ID и применяет её
  идемпотентно.
- SQLite ACK есть, а PostgreSQL ACK потерян: подтверждается существующий результат без повторного
  исполнения.
- Внешнее уведомление может повториться после crash между отправкой и ACK; доставка at-least-once,
  payload содержит deduplication ID.

## Следствия

- Второй API-процесс не может становиться вторым trading executor без отдельного durable fencing.
- Redis и новый сетевой порт пока не нужны: durable queue остаётся в PostgreSQL.
- Backup должен сохранять согласованные по времени поколения PostgreSQL и защищённой SQLite.
- HTTPS, secure cookies, private exchange connectivity и live activation остаются отдельным будущим
  release gate.
- De-risk-before-revoke/system emergency authority и archive/partition lookup для replay keys —
  обязательные блокеры этого будущего live gate. Это не дефекты текущего `public-http-paper`:
  данная сборка отклоняет `private-live` до startup side effects, а production signed adapters
  остаются deny-only.
