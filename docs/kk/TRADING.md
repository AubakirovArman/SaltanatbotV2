# Paper trading және белсенді емес live анықтамасы

> **Қазіргі релиз шекарасы — `public-http-paper`:** тек research, backtest және paper execution
> қолжетімді. Биржа API кілттерін енгізбеңіз, Binance/Bybit execution таңдамаңыз, live feature
> flag-тарын қоспаңыз және нақты қаражатпен операция жасауға тырыспаңыз. Төмендегі live сипаттамасы
> бөлек болашақ HTTPS/live релизіне арналған белсенді емес legacy/private-live анықтамасы ғана.

SaltanatbotV2 сақталған стратегияларды тек paper режимінде іске қосады. Backtest пен paper болашақ
нәтижеге кепілдік бермейді және көрсетілген fills нақты биржа мәмілелері емес.

## Сауда бөлімін ашу

1. Белсендірілген account арқылы кіріңіз.
2. **Сауда** бөлімін ашыңыз.
3. Қолжетімділік жабық болса, administrator account panel ішінде paper-trading рөлін береді.

Login және password қайтарып алуға болатын HttpOnly session жасайды. Күйді өзгертетін сұраулар CSRF
token-мен, ал trading WebSocket қысқа мерзімді бір реттік ticket-пен қорғалады.

## Paper бот

1. Strategy Studio-да стратегияны сақтап, тексеріңіз.
2. **Жаңа бот** ішінен стратегия, symbol және timeframe таңдаңыз.
3. **Paper (simulation)** режимін, position size және leverage орнатыңыз.
4. Ботты жасап, іске қосыңыз; orders, fills және logs журналдарын бақылаңыз.
5. Эксперимент аяқталған соң ботты тоқтатыңыз.

Бұл workflow үшін API кілттері керек емес. Paper bot private request жібермейді және нақты қаражатты
пайдалана да, шығара да алмайды.

Paper аккаунт күйі append-only оқиғалар журналынан қалпына келеді: initialization, orders, fills,
fees, P&L cash қозғалысы, position, settings және funding. Бір оқиғаның дәл қайталануы еленбейді,
ал ID/sequence қайшылығы немесе sequence үзілісі recovery-ді fail-closed етеді. Ескі
`paper:<botId>` snapshot журналы жоқ бот үшін тек бір рет импортталады. Funding балансқа тек unique
ID, source, rate, mark price және timestamp бар verified settlement арқылы әсер етеді; шамаланған
rate не таймер бойынша кредит жасалмайды.

### DCA робот түрі (R6, қабылданды)

R6 — **қабылданды және өндіріске шықты**; жазылған
[R6 acceptance evidence](../evidence/R6_DCA_PAPER_ROBOT.md) құжатын қараңыз — стратегиялық
роботтардың қасына екінші paper робот түрін қосады. Жасау формасына робот түрін ауыстырғыш
(**Стратегия | DCA**) қосылады; DCA панелі стратегия таңдауын бағыт пен `dca-params-v1`
өрістерімен алмастырады (base және safety order өлшемдері, safety order саны, баға ауытқуы,
step/volume көбейткіштері, take-profit, қалауыңша stop-loss/trailing/цикл ұзақтығы лимиті және
cooldown), әр өріс inline тексеріледі. Форма ортақ контракт математикасымен есептелген worst-case
капиталды портфельдің қолжетімді капиталымен салыстырып тікелей көрсетеді және резервтелген
allocation оны жаппаса, жіберуді бұғаттайды; сервер де дәл сол лимитті қолданады. Робот detail
drawer-і DCA бөлімін алады: цикл фазасы, safety order filled/total, орташа кіру бағасы, келесі
safety баға, take-profit мақсаты және cooldown, сондай-ақ параметрлер мен worst case ашылмалы
блокта. DCA роботтар — осы бөлімдегі барлық роботтар сияқты research-only paper симуляция. Дәл
параметрлер, формулалар, күй машинасы, орташалау моделі, детерминизм және рестарт семантикасы
(ағылшынша канондық құжат): [Canonical paper portfolios](../PAPER_PORTFOLIOS.md).

### Grid робот түрі (R7, қабылданды)

R7 — **қабылданды және өндіріске шықты**; жазылған
[R7 acceptance evidence](../evidence/R7_GRID_PAPER_ROBOT.md) құжатын қараңыз. Жасау формасындағы
робот түрін ауыстырғышқа үшінші
нұсқа (**Стратегия | DCA | Grid**) қосылады. Grid панелі стратегия таңдауын `grid-params-v1`
өрістерімен алмастырады — режим (neutral/long/short), spacing (arithmetic/geometric),
төменгі/жоғарғы шекара, деңгей саны, әр деңгейдің quote өлшемі, диапазоннан тыс әрекет, қалауыңша
stop-loss баға мен цикл лимиті және cooldown — әр өріс inline тексеріледі. Форма ортақ контракт
математикасымен есептелген worst-case капиталды портфельдің қолжетімді капиталымен салыстырып
тікелей көрсетеді және резервтелген allocation оны жаппаса, жіберуді бұғаттайды; сервер де дәл
сол лимитті сол қате кодымен қолданады. Іске қосу алдында форма деңгейлердің алдын ала көрінісін
де көрсетеді: есептелген дәл деңгей бағаларының тік тізімі (жоғарыдан төмен) және әр деңгейде
индикативті тарап белгісі; графиктің үстіндегі көрініс кейінгі релизде шығады. Робот detail
drawer-і grid бөлімін алады: фаза, режим, spacing, шекаралар, деңгей санауыштары
(resting/filled/cooldown), inventory саны мен орташа бағасы, evidence-aware inventory PnL-ден
қатаң бөлінген realized grid PnL, аяқталған циклдар, тоқтау себебі және worst case қоса берілген
параметрлердің ашылмалы блогы. Grid роботтар — осы бөлімдегі барлық роботтар сияқты research-only
paper симуляция. Дәл параметрлер, деңгей математикасы, worst case, gap/рестарт семантикасы және
PnL бөлінуі (ағылшынша канондық құжат):
[Canonical paper portfolios](../PAPER_PORTFOLIOS.md).

### Мүмкіндік зерттеуінен multi-leg paper интенттері (R8, жұмыс үстінде — қабылданбаған)

R8 **осы checkout ішінде жұмыс үстінде және қабылданбаған**; production әлі R7 слотында trading
SQLite schema 9-бен жұмыс істейді. Ол зерттелген мүмкіндіктен paper портфель ішіндегі durable
multi-leg paper симуляциясына дейінгі owner-scoped бір басу жолын қосады:

1. Скринерде мүмкіндікті зерттеңіз (sequence-verified N-leg цикл немесе үйлесімді route-family
   нәтижесі) және бар research беру арқылы оның `market-opportunity-v1` карточкасын
   **Автоматтандыру** бөлімінде ашыңыз.
2. Карточканың paper шекарасы `paperPlan: ready` көрсетсе және конверттің мерзімі өтпесе, журнал
   сілтемесінің қасында **Paper multi-leg іске қосу** әрекеті шығады.
3. Confirm диалогы paper портфельді таңдайды (әдепкі портфель алдын ала таңдалған) және worst-case
   капитал резервінің алдын ала көрінісін көрсетеді — planned notional, екі бағыттың (бастапқы
   және өтем) fee резерві және қорытынды worst case — дәл сервер формуласының клиенттік
   айнасымен. Сандық комиссиялар не мөлшерлер болмаса, бұл ашық айтылады; сервер әрқашан
   валидацияланған жоспардан комиссияны қоса дәл worst case резервтейді.
4. Растау әр портфель мутациясы жүретін сол fenced idempotent кезек арқылы бір
   `paper-multi-leg.submit` командасын жібереді, әр диалогқа бір тұрақты idempotency key.
   Қабылданбау сервердің дәл коды мен себебін көрсетеді (`MULTI_LEG_KILL_SWITCH`,
   `MULTI_LEG_PLAN_REJECTED`, `MULTI_LEG_LIMIT_EXCEEDED`, `MULTI_LEG_INSUFFICIENT_CAPITAL`).
5. Интент портфель орталығының **Multi-leg paper интенттері** секциясында көрінеді: нәтиже
   белгісі, source engine мен мүмкіндік, резервтелген капитал, екі аяқ пен барлық модельдік
   комиссияны қамтитыны анық жазылған біріктірілген net PnL, аяқтардың ашылмалы блогы (venue,
   инструмент, тарап, planned/filled мөлшер, орташа баға, комиссия, өтем белгісі) және
   `compensated`/`manual-review-required` нәтижелері үшін residual exposure жолдары. Секцияда
   тек жаңа жіберулерді бұғаттайтын, жүріп жатқан интенттерге тимейтін расталатын owner деңгейлі
   kill switch ауыстырғышы да бар.

Прогон — осы бөлімдегі барлығы сияқты research-only paper симуляция: кілтсіз, private сұраусыз,
live ордерсіз, ал қалдық экспозиция PnL ішіне жасырын кірмей, анық тізіммен көрсетіледі. Капитал
математикасы, лимиттер, қалпына келтіру семантикасы және жұмыс үстіндегі trading SQLite v10
миграциясы (ағылшынша канондық құжат): [Canonical paper portfolios](../PAPER_PORTFOLIOS.md). Бұл
әрекет төмендегі legacy admin multi-leg журналынан бөлек; журнал дәл JSON-жоспар импортын
өзгеріссіз сақтайды.

## Multi-leg paper журналы

`paper-trade` рөлі бар пайдаланушы сауда бүйір панелінен **Multi-leg paper журналын** аша алады.
N-leg немесе route-family зерттеу қозғалтқышы жасаған мерзімі өтпеген
`paper-multi-leg-plan-v1` JSON-ын дәл енгізіңіз және сол жоспарды қайталағанда идемпотенттік кілтті
сақтаңыз. Экран restart recovery күйін, соңғы прогондарды, соңғы нәтижені және барлық append-only
оқиғаны көрсетеді: бастапқы fills, өтем шешімі, кері fills және аяқталу.

Бұл paper bot-тан бөлек детерминдік failure сценарийі. Ол биржа кілттерін қабылдамайды, private
request жасамайды және нақты order орналастыра алмайды. `manual-review-required` — нақты сауда
командасы емес, сценарийде өтелмей қалған дәл paper quantity. Интерфейс қазақша, орысша және
ағылшынша қолжетімді; бұл журнал тек дәл JSON жоспарын қабылдайды. Жоғарыда сипатталған R8 әрекеті
(жұмыс үстінде) бөлек durable owner-scoped paper интентін жібереді — ол осы журналдың JSON-жоспарын
жасамайды және live ордер орналастыра алмайды.

## Белсенді емес legacy/private-live анықтамасы

Бұл бөлім setup нұсқаулығы емес. `public-http-paper` релизінде Binance/Bybit кілттерін қосуға,
қорғаныс режимдерін өшіруге, live flag-тарын қосуға немесе биржалық bot жасауға болмайды. Source
code ішіндегі adapter және legacy setting live қолжетімді немесе тексерілген дегенді білдірмейді.

Бөлек болашақ HTTPS/live релизі алдымен HTTPS, әр пайдаланушыға оқшауланған credentials, role/audit,
операциялық шектеулер және жеке тексерілген rollout алуы тиіс. Оған дейін тек
**Paper (simulation)** режимін қолданыңыз.

## Белсенді емес live қауіпсіздік жобасы

- Болашақ private-live дизайн withdrawal құқығы жоқ бөлек API кілт пен IP allowlist талап етеді;
  қазіргі релизде мұндай кілтті енгізуге болмайды.
- Болашақ rollout алдында paper және funded testnet тексеруі міндетті болады.
- Retained live-кодта global arm мен per-bot confirmation жобаланған, бірақ олар қазіргі релизді
  іске қосу тетігі емес.
- **Emergency stop** live сауданы өшіріп, боттарды тоқтатады, аккаунт ордерлерін жояды және биржа күйін қайта тексереді.
- Live бот үшін максималды позиция, бір ордер, күндік шығын және ашық ордер санының оң лимиттері міндетті; leverage — рұқсат етілген ең жоғары иінтірек.
- Сервер лимиттерді сақтау, іске қосу/қалпына келтіру және тәуекелді арттыратын әр ордер алдында тексереді. Қолдау көрсетілетін нақты `close` және `cancelall` лимитке байланысты entry-ге айналмайды; басқа әрекеттер төмендегі live allowlist-пен шектеледі.
- Әр risk-increasing ордер bot-тың нақты symbol/market мәніне байланысады және биржадан жаңа ғана алынған баға бойынша есептеледі; қол командасындағы market бағасына сенім артылмайды. Ашық non-reduce ордерлер position лимитін алдын ала резервтейді, ал strategy және manual submit нақты exchange+market+symbol бойынша кезекпен орындалады. Live bot start бөлек exchange+symbol lock арқылы сериалданады: market әртүрлі болса да, екі қатар start collision/reconciliation тексерісінен бірге өте алмайды.
- Futures leverage entry жіберілгенге дейін биржамен расталуы немесе дәл салыстырылуы керек. `reduceOnly` entry лимиттерін тек futures биржасы оны шынымен орындайтын кезде ғана айналып өтеді; spot-та бұл flag қорғаныс емес.
- Кез келген market-тегі тәуекелді арттыратын live order нақты оң base-asset `qty` талап етеді. `quqty`, `openpro` және `depopro` paper/general quantity resolution үшін қалады, бірақ live exposure аша алмайды.
- Spot exposure осы bot-қа тиесілі расталған inventory мен durable journal reservation қосындысымен есептеледі. Reservation `accepted`, `partially_filled` және venue `filled` болғаннан кейін де execution local accounting-ке жазылғанша сақталады. `cancelled`/`expired` жолдары тек есепке алынбаған partial fill-ді, legacy `replaced` accounting дәлелденгенше entry quantity-ді ұстайды. Pending spot buy exposure-ды, pending spot sell attributed quantity-ді резервтейді.
- Futures preflight exact-symbol hedge leg-тердің gross quantity мәнін durable gross-exposure shadow ledger-мен салыстырып, үлкенін қолданады; `positions()` lag жаңа fill-ді жасыра алмайды. Matched venue/local order quantity/price бойынша conservative max-пен біріктіріледі; identity қақтығысы, multiple match, side не reduce-only қақтығысы fail closed болады.
- Қолмен орындалатын live allowlist paper командаларынан тар. `neworder`/`open` толық risk және durable
  lifecycle тексеруінен өтеді; нақты `close`, `cancelall` және read-only `get` те рұқсат етіледі.
  `get` durable order journal-ға жол қоспайды. Live `replace`, `turnover`, `openorders`, `spreadentry`,
  жеке `cancel`, `cancelorphans`, account-wide `flatten`, `set` және `chporders` venue semantics пен
  әр child mutation жеке салыстырылатын lifecycle алғанша fail closed болады. Account-wide cancel
  және flatten тек бөлек audited emergency-stop workflow арқылы орындалады. Бір exchange+symbol-дағы
  екі live bot, market-і әртүрлі болса да, collision болады; start `override` оны айналып өтпейді.
- Биржа entry-ді қабылдап, сұралған SL/TP-ны қабылдамаса немесе растамаса, қабылданған entry `rejected` болып қайта жазылмайды. Bot managed-position state-ті сақтап, pause күйіне өтеді және durable entry reservation босамайды. Best-effort reduce-only emergency close бөлек `…-safety` client identity қолданады және өзінің venue order ID мәнін алуы тиіс. Оның acceptance-і бөлек көрсетіледі, ал entry/close executions authenticated accounting-ке түсуі керек; ID жоқ не close сәтсіз болса, ықтимал қорғалмаған позиция incident-і анық көрсетіледі.
- Бұл тармақтар retained live-кодқа жатады. Қазіргі релизде API кілттері, live командалары және
  Bybit UTA өзгерістері толық қолжетімсіз; paper сауда ғана жұмыс істейді.

## Белсенді емес account-level emergency-stop жобасы

`POST /api/trade/kill` — UI-дегі жай bot stop емес, durable және idempotent workflow. Сервер алдымен
live сауданы өшіріп, execution gate күйін атомарлы түрде `stopping` етеді; стратегиялар мен қол
командалары жаңа live ордер жібере алмайды. Содан кейін барлық runtime бот тоқтайды, бапталған/белсенді
Binance және Bybit spot/futures аккаунттарының ашық ордерлері алынады, symbol бойынша жойылады және
аккаунт қайта тексеріледі. Ашық ордер қалмағаны дәлелденгенде ғана success қайтарылады. Толық күйді
`GET /api/trade/kill` көрсетеді.

Негізгі батырма позицияларды әдейі **ашық қалдырады**. Бөлек flatten әрекеті UI растауын және
`confirmFlatten=FLATTEN_ALL_LIVE_POSITIONS` параметрін талап етеді; futures позицияларына 100% reduce-only
market close жіберіліп, flat күйі тексеріледі. Spot активтері сатылмайды. UUID `operationId` жіберіңіз:
сол UUID қайталанса, биржа әрекеттері қайталанбай, сақталған нәтиже беріледі. Үзілген `stopping`, қалған
ордер/позиция немесе adapter қатесі `partial_failure` (HTTP 207) болады — жалған success берілмейді.
Live сауданы тек жаңа retry `terminal` және `ok=true` күйіне жеткеннен кейін қайта қосуға болады.

## Белсенді емес Bybit UTA жобасы

Бұл бөлік `public-http-paper` ішінде қолжетімсіз және болашақ private-live контурына арналған
техникалық жоба ғана. Ол IMR/MMR, қолжетімді margin, collateral value, debt, interest, variable rate
және coin бойынша borrowing limit модельдерін сипаттайды.

- Retained-код стратегияның өздігінен қарыз алуына рұқсат бермейді.
- Жоба repayment кезінде debt coin balance қолданады және BTC сатуды әдепкіде қарастырмайды.
- Жоба MMR 50%-дан асқанда, borrowing usage 80%-дан асқанда, isolated margin немесе Bybit
  collateral restriction болғанда жаңа debt-ті блоктайды.
- Қазіргі релизде кілт енгізуге, debt алуға, collateral өзгертуге немесе public-HTTP gate айналып
  өтуге болмайды.

## Ордер күйі және қалпына келтіру

Order intent желі сұрауына дейін durable журналға жазылады. Белгісіз желі/5xx нәтижесі, сондай-ақ
mutating request үшін оқылмайтын, үзілген, malformed не order identity бермейтін сәтті HTTP response
`unknown` болып, соқыр түрде қайта жіберілмейді. Қайшы client/venue ID fail-closed тоқтап, қолмен
салыстыруды талап етеді. Binance USDⓈ-M private stream және Bybit v5 `order` + `execution`
topics REST polling fallback-пен бірге `accepted`, `partially_filled` және terminal күйлерін
жаңартады. Bybit v5 нақты қосылған spot/linear bot-тарды қамтиды; Binance futures
stream spot accounting болып саналмайды. Restart кезінде барлық in-flight order биржамен салыстырылады; қорғаныс
не outcome дәлелденбесе, бот pause жасап, operator action сұрайды.
REST polling не reconnect reconciliation terminal status алып, authenticated execution алмаса,
reservation босамайды және bot operator reconciliation-ға дейін pause күйіне өтеді.
Қабылданған live close та тек HTTP/order acknowledgement негізінде managed position-ды өшірмейді:
managed state сақталып, authenticated execution accounting-ке жазылғанша bot pause күйінде қалады.
Local flat күйі тек содан кейін бекітіледі.

Trading schema v2 orders, events, confirmed fills, соңғы position snapshot және logical strategy
runs деректерін сақтайды. Protected entry lifecycle `entry_submitted` күйінен `open_protected` немесе
`open_unprotected/error` күйіне дейін жазылады. Binance entry/SL/TP IDs береді; Bybit entry ID мен
position-level `trading-stop` acknowledgement сақтайды.

Қорғалған futures entry желіге жіберілмей тұрып журналда жеке deterministic reduce-only child
intents жасалады: stop `…-sl`, әр take-profit `…-tp1`, `…-tp2`, … және ықтимал emergency close
`…-safety`. Бұлар қайталанған entry емес, бөлек close lifecycles. Emergency close қажет болмаса,
алдын ала жазылған safety row `rejected` болып, «қажет болмады» деген нәтиже алады. Binance child
rows үшін venue order IDs сақтай алады. Bybit position-level `trading-stop` correlatable child order
ID бермей расталуы мүмкін: local SL/TP rows осы шектеу көрсетілген хабармен `accepted` күйінде
қалады, ал deterministic local ID venue order ID деп есептелмейді. Protection не execution дәлелі
жоқ немесе сәйкеспесе, bot fail-closed pause күйінде қалып, operator reconciliation талап етеді.

## Белсенді емес Bybit live spot inventory жобасы

Bybit live spot қазіргі релизге кірмейді. Retained-кодта эксперименттік `ENABLE_LIVE_SPOT` бар,
бірақ operator оны қоспауы тиіс.
Confirmed v5 executions әр боттың attributed quantity, weighted average және fee assets
күйін жасайды. 100% close account-тағы басқа монеталарды емес, тек осы боттың
көлемін сатады. Restart-тан кейін
exchange balance қолмен тексерілгенше бот pause күйінде қалады. Binance live spot authenticated
spot execution accounting жасалғанға дейін feature flag-ка қарамастан өшірілген.

Ешбір live path mainnet-ready деп жарияланбайды. 7–14 күндік үздіксіз funded Binance/Bybit
testnet soak қазіргі тексерілген scope-тан анық алып тасталған.

## Белсенді емес live анықтамасы: rate limit және server уақыты

Signed requests әр exchange үшін ортақ circuit breaker қолданады. HTTP `429` немесе Binance `418`
жаңа signed requests-ті `Retry-After` мерзіміне тоқтатады; mutating request автоматты қайталанбайды.
Binance `-1021` және Bybit `10002` retained-кодта host clock-skew қатесі ретінде қаралады. Болашақ
HTTPS/live релизі operating-system уақытын NTP/chrony арқылы міндетті синхрондауы тиіс.

## Командалар консолі

Antares командалары мен параметрлері аударылмайды. **Командалар консолінде** тек paper bot пен
**Тест** режимін қолданыңыз; қауіпсіз үлгіні ғана сақтап, **Анықтама** ішіндегі нақты action атауын
тексеріңіз. `::pause=500::` тізбегі қадамдар арасына басқарылатын кідіріс қояды. Қазіргі релизде
live command жібермеңіз және bot-ты exchange adapter-ге ауыстырмаңыз.

## Журналдарды оқу

- **Ашық ордерлер** — биржада немесе paper engine-де әлі орындалмаған orders.
- **Ордер журналы** — durable intent, accepted, partial/full fill, cancel, rejected және `unknown`
  lifecycle. SL/TP/safety child rows осы жерде бөлек көрінеді.
- **Мәмілелер журналы** — authenticated fills, орындалу бағасы, комиссия және realized P&L.
- **Бот журналы** — іске қосу, strategy signal, reconciliation және error хабарлары.

`unknown`, venue ID жоқ protection row немесе execution-сыз terminal status көрінсе, ботты қайта
қоспай тұрып биржа күйін қолмен салыстырыңыз. Түске ғана сенбеңіз: status мәтіні шешуші белгі.

Канондық техникалық құжаттар: [Trading](../TRADING.md) және [Configuration](../CONFIGURATION.md).
