# Резервное копирование и восстановление

Проверено: 2026-07-15.

Runtime-данные находятся в `backend/data/`. Рабочая копия должна сохранять вместе `trading.db` и
`.secret`: без исходного `.secret` зашифрованные API-ключи расшифровать невозможно. `candles.db` и
Новые backup не добавляют устаревший `.authtoken`; старые manifest с ним по-прежнему проверяются.

Учётные записи, сессии, рабочие пространства и очередь исследований находятся в PostgreSQL и
копируются отдельно: `pg_dump -Fc saltanatbotv2 > saltanatbotv2.dump`. Для полного восстановления
нужны и PostgreSQL dump, и SQLite backup с исходным `.secret`.

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

## Восстановление

1. Остановите приложение.
2. Проверьте backup командой `data:verify`.
3. Выполните явную замену.
4. Запустите приложение сначала в paper mode и проверьте ботов, журналы и настройки.
5. Не включайте live до reconciliation с фактическими ордерами/позициями биржи.

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

Без `--force` непустая runtime-директория не перезаписывается. Restore сначала создаёт и проверяет
staging-копию, затем атомарно меняет каталоги и откатывает прежний каталог при ошибке swap.

Безопасная репетиция в отдельный каталог:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

Храните минимум две проверенные версии на разных доверенных зашифрованных носителях.
