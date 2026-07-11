# Backup және қалпына келтіру

Тексерілген күні: 2026-07-11.

Runtime деректері `backend/data/` ішінде сақталады. Жарамды backup `trading.db` және `.secret`
файлдарын бірге сақтауы тиіс: бастапқы `.secret` болмаса, шифрланған API кілттері ашылмайды.
`candles.db` және `.authtoken` бар болса, автоматты түрде қосылады.

> Backup құпия материалды қамтиды. Оны commit жасамаңыз, issue-ге қоспаңыз және сенімсіз cloud-қа
> жүктемеңіз. Құрал integrity-ді тексереді, бірақ backup-ты шифрламайды.

## Жасау және тексеру

SQLite online backup API қолданылады, сондықтан backup жасау кезінде server жұмыс істей алады.
Database `PRAGMA quick_check` арқылы, файлдар SHA-256 manifest арқылы тексеріледі.

```bash
npm run data:backup -- --output ../saltanat-backups/2026-07-11
npm run data:verify -- ../saltanat-backups/2026-07-11
```

Басқа volume үшін:

```bash
npm run data:backup -- --data-dir /srv/saltanat/data --output /srv/backups/saltanat-001
```

## Қалпына келтіру

1. Қолданбаны тоқтатыңыз.
2. Backup-ты `data:verify` арқылы тексеріңіз.
3. Runtime каталогын анық растаумен ауыстырыңыз.
4. Алдымен paper mode іске қосып, bots, settings және journals тексеріңіз.
5. Exchange orders/positions reconciliation аяқталғанша live режимін қоспаңыз.

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

`--force` болмаса, бос емес runtime каталогы ауыстырылмайды. Restore verified staging directory
жасап, atomic swap орындайды және swap қатесінде алдыңғы каталогты қайтарады.

Қауіпсіз recovery drill:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

Кемінде екі verified generation-ды бөлек trusted encrypted storage ішінде сақтаңыз.
