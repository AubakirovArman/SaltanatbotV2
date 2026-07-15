# Paper және live trading

SaltanatbotV2 сақталған стратегияларды paper режимінде немесе Binance/Bybit арқылы іске қосады.
Backtest пен paper болашақ нәтижеге кепілдік бермейді; live нақты қаражатты қолданады.

## Сауда бөлімін ашу

1. **Сауда** бөлімін ашыңыз.
2. Әкімшілік **Кіру токенін** енгізіп, **Құлыпты ашу** түймесін басыңыз.
3. Жұмысты аяқтағанда ортақ құрылғыдағы сессиядан шығыңыз.

Кіру токені браузерде сақталмайтын HttpOnly session cookie-ге айырбасталады. Күйді өзгертетін
сұраулар CSRF token-мен, ал trading WebSocket қысқа мерзімді бір реттік ticket-пен қорғалады.

## Paper бот

1. Strategy Studio-да стратегияны сақтап, тексеріңіз.
2. **Жаңа бот** ішінен стратегия, symbol және timeframe таңдаңыз.
3. **Paper (simulation)** режимін, position size және leverage орнатыңыз.
4. Ботты жасап, іске қосыңыз; orders, fills және logs журналдарын бақылаңыз.

Paper аккаунт күйі append-only оқиғалар журналынан қалпына келеді: initialization, orders, fills,
fees, P&L cash қозғалысы, position, settings және funding. Бір оқиғаның дәл қайталануы еленбейді,
ал ID/sequence қайшылығы немесе sequence үзілісі recovery-ді fail-closed етеді. Ескі
`paper:<botId>` snapshot журналы жоқ бот үшін тек бір рет импортталады. Funding балансқа тек unique
ID, source, rate, mark price және timestamp бар verified settlement арқылы әсер етеді; шамаланған
rate не таймер бойынша кредит жасалмайды.

## Multi-leg paper журналы

`paper-trade` рөлі бар пайдаланушы сауда бүйір панелінен **Multi-leg paper журналын** аша алады.
N-leg немесе route-family зерттеу қозғалтқышы жасаған мерзімі өтпеген
`paper-multi-leg-plan-v1` JSON-ын дәл енгізіңіз және сол жоспарды қайталағанда идемпотенттік кілтті
сақтаңыз. Экран restart recovery күйін, соңғы прогондарды, соңғы нәтижені және барлық append-only
оқиғаны көрсетеді: бастапқы fills, өтем шешімі, кері fills және аяқталу.

Бұл paper bot-тан бөлек детерминдік failure сценарийі. Ол биржа кілттерін қабылдамайды, private
request жасамайды және нақты order орналастыра алмайды. `manual-review-required` — нақты сауда
командасы емес, сценарийде өтелмей қалған дәл paper quantity. Интерфейс қазақша, орысша және
ағылшынша қолжетімді; қазір exact JSON импортталады, screener-ден one-click беру кейінгі UX жұмысы.

## API кілттері және live іске қосу

**Баптаулар** бөлімінде Binance не Bybit кілтін қосыңыз. Сервер кілтті шифрлайды және оны браузерге
қайтармайды. Саудаға ғана рұқсаты бар, withdrawal өшірілген жеке кілт пен IP allowlist қолданыңыз.

Live ботты іске қоспас бұрын:

1. Серверде `DEMO_MODE` өшірілгенін және қолданба HTTPS не тікелей localhost арқылы ашылғанын тексеріңіз.
2. Position, бір order, daily loss және open-order саны үшін оң risk limits орнатыңыз.
3. **Нақты саудаға рұқсат беру** параметрін қосыңыз.
4. Binance немесе Bybit ботын таңдап, нақты қаражат туралы ескертуді қайта растаңыз.

Bybit spot үшін бұған қоса `ENABLE_LIVE_SPOT` және расталған bot-attributed inventory қажет. Binance
spot authenticated execution accounting дайын болғанша кез келген feature flag-қа қарамастан өшірулі.

## Live қауіпсіздігі

- Қаражат шығаруға рұқсаты жоқ бөлек API кілтін пайдаланыңыз және IP allowlist орнатыңыз.
- Алдымен testnet және paper режимінде тексеріңіз.
- Live әдепкіде өшірулі және global arm мен per-bot confirmation қажет етеді.
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
- API кілттері, live командалары және Bybit UTA өзгерістері үшін HTTPS немесе тікелей localhost керек. Paper сауда public HTTP арқылы қолжетімді болып қалады.

## Аккаунт деңгейіндегі апаттық тоқтату

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

## Bybit UTA: BTC-ні фьючерске кепіл ету

Сауда баптауларындағы **Bybit UTA кепілі мен қарызы** экраны IMR/MMR, қолжетімді маржа, кепіл құны, қарыз, пайыз, айнымалы мөлшерлеме және әр монетаның қарыз лимитін көрсетеді.

- Bybit futures ботында **Bybit UTA ортақ кепілін пайдалану** параметрін қосыңыз. Іске қосу кезінде сервер Unified Trading Account, балансы бар қосылған кепіл және тәуекел шектерін тексереді.
- Қолмен қарыз алу тек әкімшіге, live сауда қосулы кезде және анық растаудан кейін қолжетімді. Стратегия өздігінен қарыз ала алмайды.
- Әдепкі өтеу тек қарыз монетасының балансын пайдаланады және BTC-ні сатпайды. Кепілді айырбастау бөлек екінші растауды талап етеді.
- MMR 50%-дан асса, қарыз лимиті 80%-дан асса, isolated margin қолданылса немесе Bybit collateral шектеуі болса, жаңа қарыз бұғатталады.
- Public HTTP бетінде өзгертетін операциялар өшірілген. Нақты кілттер мен қарызды пайдаланбас бұрын HTTPS орнатыңыз.

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

## Bybit live spot inventory

Bybit live spot эксперименттік және `ENABLE_LIVE_SPOT` анық қосылуын талап етеді.
Confirmed v5 executions әр боттың attributed quantity, weighted average және fee assets
күйін жасайды. 100% close account-тағы басқа монеталарды емес, тек осы боттың
көлемін сатады. Restart-тан кейін
exchange balance қолмен тексерілгенше бот pause күйінде қалады. Binance live spot authenticated
spot execution accounting жасалғанға дейін feature flag-ка қарамастан өшірілген.

Ешбір live path mainnet-ready деп жарияланбайды. 7–14 күндік үздіксіз funded Binance/Bybit
testnet soak қазіргі тексерілген scope-тан анық алып тасталған.

## Rate limit және server уақыты

Signed requests әр exchange үшін ортақ circuit breaker қолданады. HTTP `429` немесе Binance `418`
жаңа signed requests-ті `Retry-After` мерзіміне тоқтатады; mutating request автоматты қайталанбайды.
Binance `-1021` және Bybit `10002` host clock-skew қатесі ретінде көрсетіледі. Live execution-ды
тоқтатып, operating-system уақытын NTP/chrony арқылы синхрондаңыз.

## Командалар консолі

Antares командалары мен параметрлері аударылмайды. **Командалар консолінде** алдымен **Тест** режимін
қолданыңыз; жиі қолданылатын қауіпсіз үлгіні ғана сақтап, **Анықтама** ішіндегі нақты action атауын
тексеріңіз. `::pause=500::` тізбегі қадамдар арасына басқарылатын кідіріс қояды. Тәуекелді арттыратын
live команда нақты оң base `qty` көрсетуі керек; quote/deposit не пайыздық quantity түрлерін тек
paper/general resolution үшін қолданыңыз. Bot-тағы **Позицияны жабу** exact `closeposition` жібереді;
барлық аккаунт позициясын flatten ету тек бөлек emergency-stop растауы арқылы орындалады.

## Журналдарды оқу

- **Ашық ордерлер** — биржада немесе paper engine-де әлі орындалмаған orders.
- **Ордер журналы** — durable intent, accepted, partial/full fill, cancel, rejected және `unknown`
  lifecycle. SL/TP/safety child rows осы жерде бөлек көрінеді.
- **Мәмілелер журналы** — authenticated fills, орындалу бағасы, комиссия және realized P&L.
- **Бот журналы** — іске қосу, strategy signal, reconciliation және error хабарлары.

`unknown`, venue ID жоқ protection row немесе execution-сыз terminal status көрінсе, ботты қайта
қоспай тұрып биржа күйін қолмен салыстырыңыз. Түске ғана сенбеңіз: status мәтіні шешуші белгі.

Канондық техникалық құжаттар: [Trading](../TRADING.md) және [Configuration](../CONFIGURATION.md).
