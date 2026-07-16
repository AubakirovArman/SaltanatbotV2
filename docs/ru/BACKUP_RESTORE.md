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

Учётные записи, сессии, рабочие пространства и очередь исследований находятся в PostgreSQL и
копируются отдельно: `pg_dump -Fc saltanatbotv2 > saltanatbotv2.dump`. Для полного восстановления
нужны и PostgreSQL dump, и SQLite backup с исходным `.secret`.

`PGPASSWORD_FILE` является настройкой самого SaltanatbotV2. Утилиты `pg_dump`, `pg_restore` и `psql`
не читают файл с таким форматом. Для них используйте защищённый интерактивный prompt, owner-only
libpq `PGPASSFILE` или другой отдельно проверенный механизм libpq.

> Backup содержит секретные материалы. Не коммитьте его, не прикладывайте к issue и не загружайте
> в недоверенное облако. Инструмент проверяет целостность, но не шифрует backup.

## Создание и проверка

Создание использует online backup API SQLite, поэтому сервер может продолжать работать. Базы
проверяются через `PRAGMA quick_check`, а каждый файл записывается в checksum-manifest.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
npm run data:verify -- ../saltanat-backups/2026-07-11
```

Output должен находиться вне `backend/data/` и не должен существовать заранее. Для другого volume:

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

## Восстановление

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

Без `--force` непустая runtime-директория не перезаписывается. Обычный direct-host restore сначала
создаёт и проверяет staging-копию, затем атомарно меняет каталоги и откатывает прежний каталог при
ошибке swap. Compose использует описанный выше проверяемый `--in-place` publish/rollback внутри
самого volume, не переименовывая mountpoint.

Безопасная репетиция в отдельный каталог:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

Храните минимум две проверенные версии на разных доверенных зашифрованных носителях.
