# Иесі бойынша оқшауланған серверлік алерттер

Ағылшынша түпнұсқа: [ALERTS.md](../ALERTS.md).

Орысша нұсқа: [ru/ALERTS.md](../ru/ALERTS.md).

Бұл құжат PostgreSQL schema 13 енгізетін R5.1 алерттерді басқару контурын
сипаттайды. Бұл — тек хабарландыруға арналған зерттеу ішкі жүйесі. Ол ордер
орналастыра алмайды, актив қарызға ала алмайды, маржаны өзгерте алмайды, биржа
сұрауына қол қоя алмайды және сауда рөлін бере алмайды.

## R5.1 ауқымы

R5.1 серверде бағаланатын бір ереже түрін қолдайды:

- `price-threshold`;
- Binance немесе Bybit биржаларының ашық нарық деректері;
- нарық сәйкестігі: `spot`, `linear` немесе `inverse`;
- тек last price;
- `1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d` және `1w`;
- `above` немесе `below` мәндерін қоса есептейтін салыстыру;
- нақты қайта іске қосылғанға дейін бір рет іске қосылу;
- қолданба ішіндегі тұрақты тарих.

Күнтізбелік ай (`1M`) шамдары қосылмаған, өйткені күнтізбелік айды тұрақты
миллисекунд аралығымен көрсету мүмкін емес. Telegram да R5.1 құрамына кірмейді.
Schema ішіндегі оған арналған орындар Telegram-ды қолжетімді етпейді: bindings,
provider acknowledgements және retry delivery R5.3 кезеңіне жатады.

R5.1 биржа credential-дарын ешқашан оқымайды. Evaluator тікелей ашық REST candle
endpoint-тарын қолданады және synthetic, cached, private немесе қол қойылмаған
алмастыру evidence-ін қабылдамайды.

## Скринер алерттері (R5.3a)

R5.3a екінші серверлік rule kind қосады — `screener`: сақталған
[техникалық скан](./SCREENER.md) «өзгеріс бойынша» тұрақты алертке айналады.
Инкремент schema миграциясынсыз қабылданды және деплой жасалды; қабылдау мен
cutover жазбасы — [R5.3a evidence](../evidence/R5_3A_SCREENER_ALERTS.md).
Кез келген алерт сияқты бұл — тек зерттеу хабарландыруы:
`researchOnly: true`, `executionPermission: false`, ордер орналастыру мүмкін
емес.

Screener ережесі толық `screener-definition-v1` құжатын мән бойынша ендіреді.
Ендірілген скан ереже revision-ымен бірге өзгермейді; ережені өңдеу өз
анықтамасы бар жаңа revision жасайды. Жаңа PostgreSQL schema жоқ: ереже, оның
durable state-і және receipt-тері schema 14-тің бар алерт кестелеріне сыяды.

### «Өзгеріс бойынша» семантика

Worker ендірілген сканды тек жабылған candle-дар бойынша бағалайды және толық
сәйкес символдар жиынын (нәтиже қысқартылғанға дейін) тұрақты алдыңғы жиынмен
салыстырады:

- алғашқы бағалау baseline-ды trigger-сіз инициализациялайды;
- trigger үшін тиімді жиын алдыңғы жиыннан өзгеше болуы керек;
- кірген және шыққан символдар event summary ішінде көрсетіледі, мәтінде ең
  көбі 12 символ;
- envelope title — `Screen match changed: <name>`; body кірген/шыққан
  символдар мен сәйкестік санын береді;
- trigger-ден кейін ереже **белсенді күйінде қалады** және бағалана береді;
  rearm қажет емес. `POST /api/alerts/:id/rearm` тек price ережелеріне
  арналған және screener ережесіне `409 alert_rearm_unsupported` қайтарады.

Қолжетімсіз символдар — **белгісіз, шыққан емес**: осы run-да қолжетімсіз
болған бұрынғы мүше мүше болып қалады, ал бұрынғы мүше емес символ мүше емес
болып қалады. Сұралған әлемнің 30%-ынан көбі қолжетімсіз болса, бағалау state
алға жылжымай кейінге қалдырылады (`screener-availability-floor`).

`cooldownSeconds` (0–86 400; браузердегі айналдыру әдепкі мәні — 3600) әр
trigger кезінде `cooldown_until` орнатады. Cooldown кезінде байқалған өзгеріс
state алға жылжымай кейінге қалдырылады, сондықтан cooldown өткен соң өзгеріс
үнсіз жұтылмай, бәрібір іске қосылады.

### Каденция, worker lane және жеткізу

Бағалау каденциясы скан таймфреймінен шығарылады (`5m` → 300 с, `15m` →
900 с, `1h` → 3600 с, `4h` → 14 400 с, `1d` → 86 400 с) және 300–86 400
секунд аралығында шектеледі. Research worker бір sweep ішінде ең көбі бір
screener-алерт бағалауын 300 секундтық lease және 90 секундтық деректер
бюджетімен қабылдайды және бөлек screener-alert lane метрика блогын
жариялайды. Completion өзгермейтін receipt-ті (producer
`screener-alert-worker`), event-ті, outbox-ты және pre-delivered in-app жолын
бір транзакцияда жазады; transition key қайталауларды дедупликациялайды.

Жеткізу R5.3b-ге дейін тек `in-app`. `telegram` каналын сұраған screener
ережесі басқа кез келген қолдау көрсетілмейтін жеткізу каналы сияқты айқын
`400` қатесімен қабылданбайды.

### Screener алерт квоталары

| Шекара | Лимит |
| --- | ---: |
| Бір owner-дың қосулы screener ережелері | 5 |
| Глобалды белсенді screener ережелері | 40 |

Screener ережелері R5.1 ортақ лимиттерінің (100/200/480) ішінде де
есептеледі; екі шектеу де қолданылады. Асып кету
`429 screener_alert_quota_exceeded` және
`429 screener_alert_capacity_exhausted` кодтарына түседі.

## HTTPS жоқ кездегі HTTP deployment шекарасы

Қазіргі pre-HTTPS релиз TLS-ті әдейі баптамайды. Сондықтан login password пен
session cookie тек сенімді жергілікті желі, private VPN немесе SSH tunnel арқылы
берілуі керек. Бұл build-ті жалпыға ашық интернет login service ретінде
жарияламаңыз және оған биржаның private key-лерін қоспаңыз. HTTPS — бөлек release
gate.

## Деректер ағыны

```text
аутентификацияланған браузер
  -> тұрақты жергілікті intent
  -> owner-scoped /api/alerts mutation
  -> PostgreSQL rule + өзгермейтін revision
  -> research worker lease
  -> дәл ашық жабылған candle
  -> fenced state revision + өзгермейтін receipt
  -> event + notification outbox + in-app delivery
  -> owner-forward event cursor
  -> браузер history/toast
```

Браузер сервер ережесін жасамай тұрып идемпотентті `clientId` мәнін тұрақты
сақтайды. Сервер алдымен disabled draft жазады. Браузер өз evaluator-ын тұрақты
түрде тоқтатқаннан кейін ғана reconciliation сервер revision-ын іске қосады.
Осы реттілік браузер мен сервердің бір retained rule-ды бір уақытта бағалауына
жол бермейді.

## Жабылған шамдар семантикасы

Сервер тек final candle-дарды бағалайды. Сондықтан алерт таңдалған candle
жабылғанға дейін armed күйінде қалуы мүмкін.

Тұрақты іске қосу уақытын қамтитын алғашқы дәл candle predicate-тің бастапқы
мәнін белгілейді. Оны trigger-ге қолдан жасау мүмкін емес. Хабарландыру үшін
кейінгі тұрақты `false -> true` ауысуы дәлелденуі керек. Әр completion дәл бір
bar және бір state revision алға жылжытады. Worker тоқтап тұрған болса, ол
тарихи arming candle-ды алып, cursor-ды аттамай, жабылған bar-ларды бір-бірден
қуып жетеді.

Threshold string-тері бақыланған JavaScript market price мәнінің ең қысқа дәл
ондық көрінісімен салыстырылады. Дәлдігі жоғары threshold бақыланған double
мәніне дейін дөңгелектелмейді. Мысалы, бақыланған `64703.52` мәні
`64703.520000000001` мәнінен кіші.

Жетіспейтін, қалыптасып жатқан, болашақ, stale, үзілісті, тым үлкен немесе
malformed candle window-лар fail closed күйінде қабылданбайды. Әлі жабылмаған қалыпты
candle evaluation error ретінде жазылмай, күтілетін жабылу уақытына дейін
кейінге қалдырылады.

## Иелік және авторизация

Әр API оқу және жазу әрекетінің owner-ы аутентификацияланған database session
арқылы анықталады. Client сол user ID-мен бірге `X-SBV2-Expected-User` header-ын
да жіберуі керек. Бұл ашық бетте account ауысқан кезде local state басқа tenant
ішіне синхрондалмай тұрып сәйкессіздікті анықтайды.

Mutation request-терге әдеттегі CSRF header-ы да қажет. Repository transaction
мына мәндерді қайта тексереді:

- user status белсенді екенін;
- `must_change_password = false` екенін;
- қазіргі authorization revision-ды;
- actor owner-ға тең екенін;
- күтілетін rule revision-ды;
- worker completion үшін lease owner, token, generation және expiry мәндерін.

Administrator-ларға басқа owner-дың алертін оқитын немесе өзгертетін жол
берілмейді. Alert document-тері мен public projection-дарда destination,
credential, password, lease token немесе authorization revision болмайды.

## Lifecycle және браузерді қалпына келтіру

Көрінетін lifecycle күйлері:

1. **queued** — owner-local intent тұрақты сақталды және synchronization күтуде;
2. **synchronizing** — disabled server draft бар, ал браузер көшірмесі inert;
3. **armed** — evaluation-ды сервер басқарады;
4. **triggered** — алғашқы дәлелденген crossing commit жасалды, rule rearm
   орындалғанға дейін disabled;
5. **stale/error** — evidence қабылданбады; бұдан notification немесе trade
   болғаны туралы қорытынды жасалмайды;
6. **archived** — rule енді бағаланбайды және retention арқылы шектелген
   тарихтан шығарылады.

Delete әрекеті inert local tombstone қолданады. Егер delete пен create жарысса,
қайтарылған disabled draft қайта көрінбей тұрып archive жасалады. Server archive
орындалғаннан кейін browser storage істен шықса, local record reload кезінде
қайта armed болудың орнына suspended күйінде қалады.

Бір owner-дың беттері owner-local Lamport revision-дарын `storage` event-тері
және `BroadcastChannel` арқылы біріктіреді. Price feed әр browser transition
алдында durable snapshot-ты қайта оқиды; бұл stale in-memory copy-ға қарсы соңғы
fence.

## API

Барлық path database authentication, rate limiting талап етеді және
`Cache-Control: no-store` қайтарады.

| Method | Path | Мақсаты |
| --- | --- | --- |
| `GET` | `/api/alerts?limit=200` | Басқарылатын rule-дар тізімі; non-archived алдымен |
| `POST` | `/api/alerts` | `clientId` арқылы идемпотентті rule жасау |
| `GET` | `/api/alerts/:id` | Owner-дың бір rule-ын оқу |
| `PUT` | `/api/alerts/:id` | `expectedRevision` арқылы definition-ды ауыстыру |
| `POST` | `/api/alerts/:id/archive` | `expectedRevision` арқылы archive жасау |
| `DELETE` | `/api/alerts/:id` | Archive-compatible alias |
| `POST` | `/api/alerts/:id/rearm` | Жаңа armed revision жасау |
| `GET` | `/api/alerts/events?limit=200&cursor=…` | Тұрақты forward event stream-ді оқу |
| `GET` | `/api/alerts/outbox?limit=200` | In-app delivery evidence-ін оқу |

Event response schema-сы — `alert-event-page-v1`; ол әрдайым opaque,
owner-bound `nextCursor`, `hasMore`, `generatedAt` мәндерін және ең көбі 200
event қамтиды. Client тұрақты watermark-ты жылжытпас бұрын `hasMore=true` болған
барлық page-ді толық оқуы керек. Басқа owner-дың cursor-ы қабылданбайды.
Қалпына келтірілген database-тан алда тұрған cursor
`alert_event_cursor_ahead` қайтарады және жаңа baseline орнатуды талап етеді.

Request body 65 536 byte-тан аспауы керек. Unknown field-тер, unsupported
delivery channel-дар, non-canonical envelope-тар және 200-ден үлкен result limit
қабылданбайды.

## At-least-once in-app delivery

Әр owner-да transactional event counter бар. Insert trigger бір owner үшін
sequence тағайындауды тізбектеп орындайды, сондықтан кейінгі transaction бұрынғы
аяқталмаған owner event-тен озып, көрінетін sequence-ті commit жасай алмайды.
Әртүрлі owner-лар бұл lock-ты бөліспейді.

Браузер cursor checkpoint-ін сақтамай тұрып жаңа cursor page-ді жариялайды.
Crash toast-ты қайталауы мүмкін, бірақ көрінбеген toast-ты acknowledge ете
алмайды. Бұл — әдейі таңдалған at-least-once behavior. Event ID-лер мен
transition key-лер retry әрекеттерін deduplicate етуге мүмкіндік береді.

`in-app` channel үшін `delivered` «адам бұл toast-ты оқыды» дегенді емес,
«қолданбада тұрақты қолжетімді» дегенді білдіреді. R5.1 UI осы тұжырымды
қолданады. Telegram provider acknowledgement семантикасы бөлек және әзірге
active емес.

Durable cursor storage owner-scoped. Local storage қолжетімсіз болса, UI
synchronization failure көрсетіп, cursor-ды жылжытпайды; retry notification-ды
қайталауы мүмкін.

## Quota және admission

R5.1 консервативті beta limit-терді қолданады:

| Шекара | Лимит |
| --- | ---: |
| Бір owner-дың active rule-дары | 100 |
| Бір owner-дың non-archived rule-дары | 200 |
| Бір owner-дың барлық rule/history row-лары | 400 |
| Globally active rule-дар | 480 |
| Бір sweep ішінде claim жасалатын rule-дар | әдепкі 100, қатаң максимум 500 |
| Concurrent public scope-тар | 4 |
| Бір sweep ішіндегі unique public read-тер | 16 |
| Бір provider үшін бір sweep ішіндегі unique read-тер | 8 |
| Бір read ішіндегі initial/continuation candle-дар | 1 |

Globally active күйіне өту арнайы PostgreSQL advisory transaction lock арқылы
тізбектеп орындалады. 480 rule шегі бір provider-ға түсетін ең нашар жағдайда секундына сегіз
unique one-minute evaluation-ға сәйкес келеді. Бірдей scope/cursor read-тері
coalesce жасалады. Provider admission екінші provider-ды starvation күйіне
түсіре алмайды: limit-ке жеткен provider rule-ы bounded retry арқылы босатылады.

Бұл beta limit-терді көтермес немесе жүйені 100 user үшін service-level
guarantee деп сипаттамас бұрын R11 құжатталған
[100-user workload](../CAPACITY_100_USERS.md) сынағын іске қосып, сәтті аяқтауы
керек.

## Retention және metrics

Research worker alert compaction-ды бар retention timer арқылы іске қосады:

- өзгермейтін evaluation receipt-тер: 2 күн;
- event, outbox, terminal delivery, ескі state және ескі revision: 30 күн;
- archived rule-дар: dependency-лер жойылғаннан кейін 30 күн.

Бір run non-blocking advisory lock, `SKIP LOCKED`, әдепкі 1 000-row batch,
6 000-row ceiling және 2 секундтық time budget қолданады. Өзгермейтін parent
row-лардан бұрын child row-лар жойылады.

Structured worker log-тары active, due, leased, archived және errored rule-дарды,
oldest due age, recent evaluation/trigger-лерді, read/coalescing count-тарын,
admission deferral-дарын және scheduler failure-ларын көрсетеді. Log ішінде owner
ID, destination немесе secret болмайды.

## PostgreSQL schema 13

Schema 13 мына table-дарды қосады:

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

Revision, receipt, event және outbox row-ларын update жасауға тыйым салынған.
Composite owner foreign key-лер cross-tenant graph edge-терге жол бермейді.
Retention өзгермейтін history-ді жарияланған dependency order бойынша жоя алады.

## Upgrade және rollback

Schema 12-ден upgrade жасамас бұрын:

1. exact commit-ті build жасап, test өткізу;
2. research worker-ды тоқтату;
3. paired project backup жасап, тексеру;
4. сол backup-ты isolated marked database ішіне restore жасап, drill орындау;
5. API-ды тоқтату;
6. exact API release-ті іске қосып, checksum-locked schema 13 migration-ға рұқсат
   беру;
7. health, readiness, owner isolation және migration no-op restart-ты тексеру;
8. research worker-ды іске қосып, оның alert-lane metrics мәндерін тексеру;
9. post-upgrade backup жасап, isolated restore check-ті қайталау.

Rollback үшін schema 13 row-ларын ешқашан жоймаңыз және
`schema_migrations` мәнін кемітпеңіз. Pre-upgrade PostgreSQL backup-ты жаңа
project-marked replacement database ішіне restore жасаңыз, paired runtime data-ны
қалпына келтіріңіз және қорғалған R4 release slot-ты іске қосыңыз. Сәтсіз schema
13 database-ты incident evidence ретінде сақтаңыз.

Қараңыз: [MIGRATIONS.md](../MIGRATIONS.md),
[BACKUP_RESTORE.md](../BACKUP_RESTORE.md),
[STARTUP_RECOVERY.md](../STARTUP_RECOVERY.md) және
[RELEASING.md](../RELEASING.md).

## Тексеру

Release gate құрамына мыналар кіреді:

- strict contract generation check-тері;
- route/auth/CSRF/owner-change test-тері;
- real unprivileged PostgreSQL migration, repository, capacity, retention және
  forward-cursor test-тері;
- forged trigger, skipped cursor, stale revision, duplicate receipt және
  cross-revision replay test-тері;
- browser storage failure, create/delete race, multi-tab convergence және
  first-poll notification test-тері;
- browser жабық кездегі worker restart/dedup acceptance;
- desktop/mobile accessibility және visual regression;
- exact-commit GitHub CI және backup/restore/rollback evidence.

R5.2.1 бөлек [сұраныс бойынша техникалық скринерді](./SCREENER.md) қосады; ол
скандарды сұраныс бойынша орындайды, ал R5.3a сканды жоғарыда сипатталған
`screener` rule kind-ке айналдырады. R5.3 бөлек notification worker және
Telegram binding/revoke/delivery flow қосады.
