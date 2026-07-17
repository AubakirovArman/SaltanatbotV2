# Резервное копирование и восстановление

Проверено: 2026-07-16.

Runtime-данные находятся в `backend/data/`. Рабочая копия должна сохранять вместе `trading.db` и
`.secret`: без исходного `.secret` зашифрованные API-ключи расшифровать невозможно. `candles.db` и
`arbitrage-paper-multi-leg.sqlite` добавляются при наличии. Новые backup не добавляют устаревший
`.authtoken`; старые manifest с ним по-прежнему проверяются.

Команда `npm run data:inventory -- --data-dir backend/data` только считает зашифрованные строки через
read-only SQLite/WAL и не открывает ключ. Проверка всегда требует `.secret`, проверяет его реальный
тип, владельца и режим `0600`/`0400`, а затем в памяти доказывает расшифровку каждой зашифрованной
настройки и credential. Ключ, ciphertext и plaintext в вывод не попадают.

`.trading-runtime-lock.sqlite` не содержит пользовательских данных, не входит в backup и служит
только для запрета второго backend-процесса. При crash ОС освобождает lock; retained sidecar-файлы не
создаются. Во время restore приложение должно быть остановлено.

Учётные записи, сессии, рабочие пространства и очередь исследований находятся в PostgreSQL. Для
полного восстановления нужны и PostgreSQL dump, и SQLite backup с исходным `.secret`.

> Backup содержит секретные материалы. Не коммитьте его, не прикладывайте к issue и не загружайте
> в недоверенное облако. Инструмент проверяет целостность, но не шифрует backup.

## Предпочтительное парное recovery-поколение

Команды `recovery:*` создают и проверяют единое поколение PostgreSQL + SQLite. Экспортированный
read-only PostgreSQL snapshot удерживается через `pg_dump` и весь online SQLite backup:
migrations/counts и dump относятся к одному snapshot, а каждый SQLite `ownerUserId` до публикации
обязан существовать в этом же snapshot. Полное окно захвата не может превышать пять минут.
Реализация принимает только текущий профиль `public-http-paper`.

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 \
  /opt/saltanatbotv2-backups \
  /opt/saltanatbotv2/operations
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
npm run recovery:backup -- \
  --output "/opt/saltanatbotv2-backups/$STAMP" \
  --data-dir "/opt/saltanatbotv2/backend/data"

RECOVERY_STATUS_FILE="/opt/saltanatbotv2/operations/recovery-status.json"
npm run recovery:verify -- "/opt/saltanatbotv2-backups/$STAMP" \
  --status-file "$RECOVERY_STATUS_FILE"
exit
```

Оба parent-каталога создаются от root, но обе recovery-команды выполняются из показанного
непривилегированного shell пользователя `saltanatbotv2`. Родительский каталог output должен
существовать заранее, принадлежать этому recovery-оператору, не иметь group/world write-битов и
symlink-компонентов в пути. Сам каталог нового поколения существовать не должен.

Поколение содержит только `postgres.dump`, каталог `runtime/` и owner-only
`recovery-manifest.json`. Проверяются SHA-256, PostgreSQL archive list, SQLite `quick_check`,
`.secret`, migrations, агрегированные counts, owner-set checksum и capture span.

Необязательный `--status-file` принимает только нормализованный абсолютный путь в каталоге
recovery-оператора без group/world write-битов. Лишь после полной успешной проверки CLI атомарно
добавляет newline-committed запись в ограниченный JSON-журнал режима `0600`: version, generation ID, время проверки, release commit,
версию схемы, capture span и только basename каталога поколения. Полный путь, имя БД и владелец туда
не попадают. Failed verify не создаёт и не заменяет receipt. Тот же путь можно передать API через
`OPERATIONS_RECOVERY_STATUS_FILE`; verify следует запускать от той же непривилегированной OS-учётки,
что и API, чтобы совпали проверки владельца и защищённого parent-каталога. Пример systemd читает
точно `/opt/saltanatbotv2/operations/recovery-status.json` и не запускается, если operations-каталог
не является настоящим каталогом владельца и группы сервиса. Сам журнал эксклюзивно создаётся как
owner-only файл, удерживается открытым через pinned descriptor и принимается лишь после проверки
точных identity, содержимого и durability. У него должна быть ровно одна hard link (`nlink=1`);
любой hard-linked alias отклоняется fail-closed. Оборванный append автоматически не обрезается: API
читает последнюю newline-committed запись. После остановки всех recovery-writer процессов оператор
может проверить и обрезать только доказанный незавершённый хвост; постоянный lock-файл остаётся
нетронутым. Отсутствующий или невалидный receipt даёт `null` в admin metrics и не влияет на
`/api/ready`.

Writer-процессы сериализуют всю границу inspect/append/file-fsync/directory-fsync/final-validation
через постоянный пустой `.recovery-status.lock`. Это должен быть обычный non-symlink файл владельца
`saltanatbotv2`, режима `0600`, с `nlink=1` в том же operations-каталоге. Writer открывает и
закрепляет его с `O_NOFOLLOW`, проверяет root-owned non-writable `/usr/bin/flock` и удерживает
exclusive kernel lock до завершения публикации. Если `/usr/bin/flock` отсутствует, установите пакет
`util-linux`. Никогда не удаляйте, не переименовывайте, не копируйте и не создавайте hard link этого
lock-файла при ремонте или ротации. После crash kernel lock освобождается автоматически; постоянный
inode должен остаться на месте, поэтому удалять «stale lock file» не требуется.

Сбой между эксклюзивным созданием первого журнала и durable-записью полной строки с newline может
оставить пустой или частичный single-link файл. Это не append-tail: writer и API отклоняют такой
файл, а truncate до нулевой длины его не исправляет. Остановите все recovery-writer процессы,
проверьте, что настроенный путь — обычный non-symlink файл владельца `saltanatbotv2`, режима `0600`,
с `nlink=1` в точном доверенном operations-каталоге. Переименуйте именно этот файл в owner-only
quarantine-каталог на той же файловой системе; не удаляйте, не перезаписывайте и не копируйте его
вслепую и не трогайте `.recovery-status.lock`. Когда настроенный путь отсутствует, заново выполните
полную команду
`recovery:verify -- --status-file` и подтвердите новый receipt и admin-метрику. Если identity или
permissions нельзя доказать, оставьте файл нетронутым и разберите ситуацию вручную.

Полностью валидный журнал также может достичь лимита 1 MiB. Тогда writer под lock отклоняет следующую
запись до записи байтов, а API продолжает показывать последний валидный receipt. Для плановой ротации
остановите все recovery-writer процессы и не трогайте `.recovery-status.lock`. Проверьте, что
настроенный журнал — точный owner-only обычный файл режима `0600` с `nlink=1` в доверенном
operations-каталоге, затем переименуйте именно журнал, но не lock, в owner-only
quarantine/archive-каталог на той же файловой системе. Когда `recovery-status.json` отсутствует,
запустите полную verify-команду для создания нового журнала, подтвердите admin-метрику и храните
архивный журнал по принятой backup policy. Не обрезайте и не удаляйте полный валидный журнал на месте.

> **Переход со старого anchor-прототипа.** Журнал с `nlink=2` и соответствующим именем
> `.recovery-status-anchor-*` больше не принимается. Остановите все recovery-writer процессы,
> проверьте через `stat`, что настроенный receipt и ровно один anchor являются owner-only именами
> одного inode, затем переименуйте оба имени (не копируя и не удаляя ни одно из них) в отдельный
> owner-only quarantine-каталог на той же файловой системе. Если identity доказать нельзя, оставьте
> файлы нетронутыми и разберите ситуацию вручную. Когда настроенный путь отсутствует, заново выполните
> полную команду `recovery:verify -- --status-file` от пользователя `saltanatbotv2`: она создаст новый
> single-link receipt. До удаления карантинного прототипа по принятой backup-retention policy
> подтвердите `nlink=1`, владельца/группу, режим `0600` и recovery-метрику в admin API.

Source connection берётся из `RECOVERY_SOURCE_DATABASE_URL`, затем `DATABASE_URL`, затем обычных
`PG*`. Новый wrapper безопасно читает owner-only `PGPASSWORD_FILE` и передаёт пароль дочерней
утилите без вывода; сами raw `pg_dump`/`pg_restore` такой файл не читают. Source и operator обязаны
использовать один numeric loopback endpoint с `sslmode=disable`; DNS, proxy, remote endpoint и
согласуемые SSL modes отклоняются. Совместимые raw-бинарники `pg_dump`/`pg_restore` должны
разрешаться в root-owned non-writable executables. Единственные допустимые wrapper paths — bundled
adapters через `RECOVERY_PG_DUMP_BIN` и `RECOVERY_PG_RESTORE_BIN`.
Путь password-файла должен быть абсолютным и не может содержать symlink ни в одном каталоге.
Дочерним подключениям задаётся `PGCONNECT_TIMEOUT=10`. Стандартные process timeout: пять минут для
`pg_dump`, десять минут для restore и одна минута для archive list. Их можно изменить через
`RECOVERY_PG_DUMP_TIMEOUT_MS`, `RECOVERY_PG_RESTORE_TIMEOUT_MS` и
`RECOVERY_PG_RESTORE_LIST_TIMEOUT_MS` в проверяемом диапазоне 50–3 600 000 мс.

### Совместимые PostgreSQL-утилиты из Compose-образа проекта

Когда приложение использует описанный выше direct-host layout, а PostgreSQL запущен через Compose
этого проекта, host-only adapters берут `pg_dump`/`pg_restore` из exact immutable image digest
работающего PostgreSQL-сервиса. Этот пример по-прежнему читает direct-host runtime data из
`/opt/saltanatbotv2/backend/data`; полностью контейнерный deployment хранит их в named volume
`saltanat-data` и сначала должен использовать описанную ниже named-volume процедуру. Запускайте
recovery только из настоящего корня проекта и передавайте абсолютные пути:

```bash
cd /opt/saltanatbotv2
STAMP="<existing-generation-stamp>"
export RECOVERY_PG_DUMP_BIN="$PWD/scripts/recovery-pg-dump.mjs"
export RECOVERY_PG_RESTORE_BIN="$PWD/scripts/recovery-pg-restore.mjs"
npm run recovery:backup -- \
  --output "/opt/saltanatbotv2-backups/$STAMP" \
  --data-dir "/opt/saltanatbotv2/backend/data"
```

Adapters fail closed и требуют одновременного совпадения:

- root-owned локального `/usr/bin/docker` и локального `/var/run/docker.sock`;
- owner-controlled checkout без group/world write, точного `docker-compose.yml`, стандартного Compose project name из
  имени каталога и единственного healthy-контейнера `<project>-postgres-1`;
- образа `postgres:17.10-bookworm`, version-17 утилит, точного image digest, project named volume и
  единственного loopback binding `127.0.0.1:<published-port> -> 5432/tcp`;
- эффективных `PGHOST`, `PGPORT`, имени БД и application role recovery-процесса;
- точного owner-only bind source Compose password secret, найденного у запущенного контейнера этого
  проекта; файл может быть внутри или вне checkout и не может иметь symlink-компоненты.

Утилита базы не запускается внутри долгоживущего PostgreSQL-контейнера. Adapter создаёт уникальный
labeled auto-remove helper из того же image digest, подключает только network namespace точного
контейнера БД, включает read-only root, сбрасывает capabilities, включает `no-new-privileges`,
задаёт CPU/memory/PID limits и внутренний hard deadline и принимает лишь аргументы, создаваемые
project recovery CLI. Dump потоково записывается в эксклюзивно созданный owner-only host-файл;
restore читает проверенный owner-only host-файл. Пароль сравнивается с Compose secret, но не
попадает в Docker arguments, labels или inspectable environment helper-контейнера.

Recovery core выдаёт каждому helper UUID и после timeout/signal запускает identity-bound cleanup.
Cleanup не удаляет одноимённый контейнер с другими labels, image/network identity или secret mount,
force-removes только точный helper и проверяет стабильное отсутствие дольше окна `docker create`.
Если cleanup не доказан, replacement PostgreSQL resources сохраняются: drop не может гоняться с
выжившим restore. Не запускайте adapters напрямую, не переопределяйте Compose project name и не
используйте их внутренний протокол `--cleanup-run` вручную.

Adapter намеренно поддерживает только Compose `POSTGRES_USER` и его проверенный Compose secret. Для
отдельной recovery-operator role нужны совместимые host binaries либо отдельно спроектированная и
проверенная secret boundary. Другой Compose project/container, чужая database family, remote Docker
daemon и не-loopback PostgreSQL порт всегда отклоняются.

Для restore настройте operator connection через `RECOVERY_OPERATOR_DATABASE_URL`, указывающий на
maintenance database (обычно `postgres`), либо через `RECOVERY_OPERATOR_PG*`. Source и operator
должны использовать одинаковые numeric loopback host/port и `PGSSLMODE=disable`.

До создания БД restore потоково копирует dump и runtime-файлы, связанные manifest-checksum,
через `O_NOFOLLOW` в новое owner-only staging-поколение, проверяет именно эту закреплённую копию и
использует только её пути. Используйте отдельную recovery operator role и не запускайте параллельно
привилегированные create/drop/rename database. Согласованные recovery-запуски сериализуют
create/drop через advisory lock в maintenance database. Marker, OID и inventory проверяются в одной
read-only транзакции; PostgreSQL не позволяет сделать `DROP DATABASE` условным по OID, поэтому
враждебный или параллельный superuser остаётся за границей гарантий инструмента.

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 /opt/saltanatbotv2-replacements
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
STAMP="<verified-generation-stamp>"
DBSTAMP="$(date -u +%Y%m%d_%H%M%S)"
npm run recovery:restore -- "/opt/saltanatbotv2-backups/$STAMP" \
  --target-database "saltanatbotv2_restore_$DBSTAMP" \
  --data-dir "/opt/saltanatbotv2-replacements/data-$STAMP" \
  --current-data-dir "/opt/saltanatbotv2/backend/data" \
  --target-owner "saltanatbotv2"
exit
```

Restore:

- создаёт только несуществующую БД с префиксом `<source>_restore_`;
- требует заранее созданный родительский каталог data target владельца recovery-процесса, без
  group/world write-битов и symlink-компонентов;
- принимает только отсутствующий или пустой owner-only data directory владельца recovery-процесса;
- заранее эксклюзивно занимает destination owner-only nonce-marker и не освобождает путь во время
  публикации файлов; подменённый конкурентом пустой каталог сохраняется и отклоняется;
- отклоняет текущую БД/runtime path, непустые цели, symlink, corruption и mismatch;
- маркирует созданную БД точным recovery ownership-marker;
- при ошибке удаляет только эту маркированную БД и возвращает data target в исходное
  отсутствующее/пустое состояние; если безопасный SQLite cleanup не доказан, парная PostgreSQL БД и
  pinned recovery input также сохраняются, а не удаляются отдельно;
- никогда не меняет systemd, Compose, `PGDATABASE` или активный runtime path.

Полная изолированная репетиция сама создаёт и удаляет `_drill_` database и временный data directory:

```bash
sudo install -d -o saltanatbotv2 -g saltanatbotv2 -m 0700 /opt/saltanatbotv2-recovery-drills
sudo -u saltanatbotv2 -H -s
cd /opt/saltanatbotv2
STAMP="<verified-generation-stamp>"
npm run recovery:drill -- "/opt/saltanatbotv2-backups/$STAMP" \
  --temporary-root "/opt/saltanatbotv2-recovery-drills" \
  --current-data-dir "/opt/saltanatbotv2/backend/data"
exit
```

## Низкоуровневое создание и проверка SQLite

Создание использует online backup API SQLite, поэтому сервер может продолжать работать. Базы
проверяются через `PRAGMA quick_check`, а каждый файл записывается в checksum-manifest.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
npm run data:verify -- ../saltanat-backups/2026-07-11
```

Output должен находиться вне `backend/data/` и не должен существовать заранее. Его parent должен
заранее существовать, принадлежать оператору, не иметь group/world write и symlink-компонентов.
Для другого volume:

```bash
npm run data:backup -- --data-dir /srv/saltanat/data --output /srv/backups/saltanat-001
```

### Docker Compose и named volume

В Compose каталог `/app/backend/data` находится в named volume `saltanat-data`, а не в checkout.
Создавайте backup внутри контейнера и затем копируйте уже проверенный результат на хост:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p ../saltanat-backups
docker compose exec saltanatbotv2 \
  npm run data:backup -- --output "/tmp/$STAMP"
docker compose cp \
  "saltanatbotv2:/tmp/$STAMP" "../saltanat-backups/$STAMP"
```

Для восстановления остановите оба сервиса, смонтируйте backup только для чтения и обязательно
используйте `--in-place`: корень named volume нельзя переименовать. Режим проверяет и staging, и
результат, заменяет только известные runtime-файлы, сохраняет посторонние файлы и выполняет rollback
при ошибке.

```bash
docker compose stop saltanatbotv2 research-worker
BACKUP_DIR="$(realpath ../saltanat-backups/2026-07-15T120000Z)"
docker compose run --rm --no-deps --user root \
  -v "$BACKUP_DIR:/restore:ro" \
  saltanatbotv2 sh -lc \
  'node scripts/runtime-data.mjs verify /restore &&
   node scripts/runtime-data.mjs restore /restore --data-dir /app/backend/data --force --in-place &&
   for file in trading.db candles.db arbitrage-paper-multi-leg.sqlite .secret .authtoken .restore-manifest.json; do
     [ ! -e "/app/backend/data/$file" ] || chown node:node "/app/backend/data/$file";
   done'
docker compose up -d saltanatbotv2 research-worker
```

Сначала восстановите соответствующий PostgreSQL dump. Не копируйте работающие SQLite-файлы
напрямую через `docker cp`.

## Низкоуровневое/ручное восстановление

Для новых поколений используйте `recovery:restore` выше. Следующие команды оставлены как описание
отдельных building blocks и compatibility path старых backup.

1. Остановите приложение.
2. Проверьте backup командой `data:verify`.
3. Восстановите PostgreSQL только в новую пустую replacement database, без `--clean`.
4. Выполните явную замену SQLite runtime-каталога.
5. Переключите только `PGDATABASE` этого проекта после проверки replacement database.
6. Запустите приложение сначала в paper mode и проверьте пользователей, workspaces, jobs, ботов и журналы.

Не восстанавливайте dump поверх текущей `saltanatbotv2` и не удаляйте исходную БД до завершения
acceptance window. Binary rollback после forward migration выполняется переключением на сохранённую
совместимую БД, а не down migration.

Пример для заранее созданной пустой replacement database:

```bash
pg_restore --exit-on-error --no-owner --no-privileges \
  --host 127.0.0.1 --port 55434 --username saltanatbotv2 \
  --dbname saltanatbotv2_restore_20260715 saltanatbotv2.dump
```

После проверки PostgreSQL восстановите соответствующее поколение SQLite:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

Без `--force` непустая runtime-директория не перезаписывается. Даже с `--force` обычный direct-host
restore заменяет только известный плоский allowlist runtime-файлов и отказывается рекурсивно удалять
постороннюю запись. Сначала создаётся и проверяется staging-копия, затем публикуются только
проверенные файлы; при ошибке выполняется rollback. Parent цели должен заранее существовать,
принадлежать оператору, не иметь group/world write и symlink-компонентов. Compose использует описанный выше проверяемый
`--in-place` publish/rollback внутри самого volume, не переименовывая mountpoint.

Безопасная репетиция в отдельный каталог:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

Храните минимум две проверенные версии на разных доверенных зашифрованных носителях.
