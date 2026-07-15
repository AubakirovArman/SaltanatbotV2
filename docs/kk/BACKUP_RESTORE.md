# Backup және қалпына келтіру

Тексерілген күні: 2026-07-15.

Runtime деректері `backend/data/` ішінде сақталады. Жарамды backup `trading.db` және `.secret`
файлдарын бірге сақтауы тиіс: бастапқы `.secret` болмаса, шифрланған API кілттері ашылмайды.
`candles.db` бар болса қосылады. Жаңа backup ескірген `.authtoken` файлын қоспайды, бірақ ескі
manifest оны әлі тексере алады.

Accounts, sessions, workspaces және research queue PostgreSQL ішінде орналасады және бөлек
`pg_dump -Fc saltanatbotv2 > saltanatbotv2.dump` арқылы сақталады. Толық recovery үшін PostgreSQL
dump және бастапқы `.secret` бар SQLite backup екеуі де керек.

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

### Docker Compose және named volume

Compose ішінде `/app/backend/data` checkout-та емес, `saltanat-data` named volume ішінде болады.
Backup-ты application container ішінде жасап, тексерілген нәтижені host storage-қа көшіріңіз:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p ../saltanat-backups
docker compose exec saltanatbotv2 \
  npm run data:backup -- --output "/tmp/$STAMP"
docker compose cp \
  "saltanatbotv2:/tmp/$STAMP" "../saltanat-backups/$STAMP"
```

Қалпына келтіру алдында екі service-ті де тоқтатып, backup-ты read-only mount етіңіз және міндетті
түрде `--in-place` қолданыңыз: named volume mountpoint атауын өзгертуге болмайды. Бұл режим staging
пен нәтижені тексереді, тек белгілі runtime файлдарын ауыстырады, бөгде файлдарды сақтайды және
қате болса rollback жасайды.

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

Алдымен сәйкес PostgreSQL dump-ты қалпына келтіріңіз. Жұмыс істеп тұрған SQLite файлдарын
`docker cp` арқылы тікелей көшірмеңіз.

## Қалпына келтіру

1. Қолданбаны тоқтатыңыз.
2. Backup-ты `data:verify` арқылы тексеріңіз.
3. Runtime каталогын анық растаумен ауыстырыңыз.
4. Алдымен paper mode іске қосып, bots, settings және journals тексеріңіз.
5. Exchange orders/positions reconciliation аяқталғанша live режимін қоспаңыз.

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 --force
```

`--force` болмаса, бос емес runtime каталогы ауыстырылмайды. Кәдімгі direct-host restore verified
staging directory жасап, atomic swap орындайды және swap қатесінде алдыңғы каталогты қайтарады.
Compose mountpoint-ті атамай, volume ішінде verified `--in-place` publish/rollback қолданады.

Қауіпсіз recovery drill:

```bash
npm run data:restore -- ../saltanat-backups/2026-07-11 \
  --data-dir /tmp/saltanat-recovery-check
```

Кемінде екі verified generation-ды бөлек trusted encrypted storage ішінде сақтаңыз.
