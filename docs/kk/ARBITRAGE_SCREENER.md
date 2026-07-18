# Арбитражды зерттеу жұмыс кеңістігі

**Скринер** API кілттерінсіз жұмыс істейді және order жібермейді. Basis режимі Binance/Bybit ортақ
USDT жұптары үшін төрт бағытты есептейді: Binance ішіндегі spot → perpetual, екі биржа арасындағы
екі бағыт және Bybit ішіндегі spot → perpetual. UI ішінде бір биржадағы REST top-book дерегінен
directional үш аяқты cycle симуляциясы, Bybit native spread order book және European options parity
scenario lab бар. Options form ішіндегі capacity/borrow/margin/rate/fee — live account evidence емес,
caller assumption.

Basis, triangular және native-spread browser режимдері пайдаланушы бағандары, ықшам жылу картасы,
аяқтардың реттелген графы және ағымдағы кандидаттарды салыстыруы бар ортақ жергілікті research
workspace қолданады. Options, funding және continuous режимдерінің жеке панельдері бар және олар
әзірге осы preset пен visualization-дарды қолданбайды. Ортақ workspace ішіндегі он екіге дейін
атаулы preset шектелген filter мен көрсету параметрлерін versioned local schema ішінде сақтайды; v1 дерегі
миграцияланады, ал бұзылған не тым үлкен мәндер қауіпсіз default күйге қайтады. API кілттері preset-ке
жазылмайды және ол execution құқығын бермейді. Жылу картасы түске ғана сүйенбей, нақты мән мен рейтинг
орнын көрсетеді; route graph үшін мәтіндік және semantic table баламасы бар. Tab жасырылғанда жиі
visual update тоқтайды. Basis режимі read-only lifecycle жиынтығын да көрсетеді, бірақ ол
`executionPermission: false` күйінде қалады және order control емес.

Mobile экранда basis нәтижелері default бойынша ықшам card түрінде көрсетіледі, сондықтан маңызды
өрістер мен row action бүкіл page-ті viewport-тан кеңейтпейді. **Толық кесте** ауыстырғышы толық
semantic table-ды жеке horizontal scroll аймағында ашады; **Карточкаларға** қайтқанда table active
DOM-нан алынады және екі жасырын result tree қатар тұрмайды.

Режим ауыстырғышының жанындағы жиналмалы **Айырма бағыттарының түрлері** анықтамасы trader
терминдерін нақты engine пішіндерімен байланыстырады: қос бағыт — екі аяқты pairwise route, үштік —
үш conversion triangular cycle, биржа ішіндегі атауы жеке стратегияны емес, орындалу орнын
білдіреді, ал multi-leg — төрт–сегіз аяқты шектелген зерттеу engine-і. Әр түр үшін depth,
комиссия, атомдық емес орындалу, капитал және recovery тәуекелі көрсетіледі. Канондық анықтамалар
мен current/planned шекарасы [арбитраж taxonomy құжатында](ARBITRAGE_TAXONOMY.md) берілген.

Үшбұрышты REST нәтижесі тек зерттеу кандидаты: contract ішінде `rest-top-book`, `rest-snapshot`,
`sequenceVerified: false` және `executionStatus: non-executable-candidate` анық көрсетіледі. Ол
sequence-verified execution ретінде ұсынылмайды.

Custom research клиенттері үшін deterministic pairwise evaluator,
[мүмкіндіктер матрицасындағы](../VENUE_CAPABILITIES.md) барлық adapter-дің ортақ credential-free
public API-ы және `packages/arbitrage-sdk` TypeScript клиенті қолжетімді. **Live бағыттар** режимі
тек [машина оқитын реестрде](../CAPABILITY_TRUTHS.json) бекітілген бөлек continuous protocol
жиынын қолданады және оператор таңдаған public stream-дерді, дереккөз күйлерін және үйлесімді route
түрлерін көрсетеді; бұл орындалатын basis кестесінің автоматты жолдары емес, бөлек зерттеу көрінісі.

Кестеде жалпы spread, жеке комиссия профилі, таза айырма, екі үздік бағада қолжетімді көлем және
funding мөлшерлемесі көрсетіледі.
Абсолюттік айырмасы 20%-дан жоғары жолдар қабылданбайды: бұл орындалатын мүмкіндікке қарағанда
бірдей ticker бар әртүрлі актив, redenomination немесе ескірген нарық болуы ықтимал.
Жолдар execution уәдесі емес, research candidate болып табылады. Екі venue timestamp-ы жоқ жол
`unverified` ретінде көрінеді, `fresh` жолдан төмен сұрыпталады, alert іске қоспайды және paper
gate-тен өтпейді.
Биржалар арасындағы matching үшін reviewed economic-asset identity де міндетті. Бастапқы allowlist
тек BTC және ETH активтерін қамтиды; басқа бірдей ticker-лердің шығу тегі, redenomination және
settlement semantics тексерілгенше олар fail closed болады. Бір биржаның ішіндегі route бұл
cross-venue allowlist-пен шектелмейді: екі leg бір strict venue-native identity және үйлесімді
quote/settlement/direction/multiplier/quantity semantics көрсетуі тиіс.

```text
жалпы spread (bp) = (perpetual bid - spot ask) / spot ask × 10 000
таза айырма (bp)  = жалпы spread - болжамды толық шығын
сәйкестенген base quantity = min(spot ask size, perpetual bid size)
қолжетімді USD көлемі      = сәйкестенген base quantity × spot ask
```

Browser ішінде Binance/Bybit spot және perpetual taker комиссиялары, екі бағыттағы slippage қоры,
күтілетін ұстау уақыты, жылдық қаржыландыру/қарыз мөлшерлемесі және тұрақты аударым құны жеке
беріледі. Кіру мен шығу автоматты есептеледі. Funding тек таңдалған horizon ішіндегі дискретті
settlement үшін, `nextFundingTime` және interval registry арқылы расталғанда ғана есептеледі.
Расталмаған positive schedule болжалды табыс бермейді; расталмаған negative rate holding horizon
нөлден үлкен болса, `nextFundingTime` жоқ кезде де кемінде бір settlement шығыны ретінде алынады.
Болашақ rate белгісіз болғандықтан бұл кепіл емес.

Server default бойынша expected executable USD profit арқылы сұрыптайды: net edge таңдалған notional
мен top-book capacity-дің кішісіне қолданылады. Filter `limit`-тен бұрын орындалады, response
`totalOpportunities` және `truncated` өрістерін береді. UI cost waterfall, spot capital, initial
margin, safety buffer және basis 100/75/50/25/0% converge болатын scenario-ларды бөлек көрсетеді.
Бұл account telemetry емес, user assumption моделі.

REST бастапқы snapshot-ты қатар алады, содан кейін сервер әр Binance/Bybit нарығына бір ортақ
public WebSocket ұстайды. Binance Spot REST `bookTicker` venue timestamp бермейді, сондықтан
bootstrap candidate `unverified` болып қалады; Spot `ticker` WebSocket event time және ағымдағы
bid/ask беріп, оны `fresh` күйіне көтере алады. Binance Futures үшін `bookTicker`, Bybit үшін V5
ticker қолданылады. Сервер
heartbeat жібереді, valid market event келгеннен кейін ғана healthy болады, үнсіз қалған feed-ті
тоқтатады, jittered exponential backoff арқылы қайта қосылады және жиі tick-терді
`/arbitrage-stream` алдында топтайды. REST жаңа жұптарды табу және fallback шекарасы үшін 30 секундта
бір рет жаңарады. Барлық көз уақытша істемесе,
30 секундтан ескі емес соңғы snapshot ескерту белгісімен көрсетілуі мүмкін. Жасырын browser tab
ағынды уақытша тоқтатады. Әр leg exchange timestamp-тың venue-ден келгенін бөлек көрсетеді. Ол жоқ
болса, local time арқылы синтезделмейді және route `unverified` болады. Age және leg skew venue
timestamp пен өзгермейтін `receivedAt` мәндерінің ең нашар шекарасы бойынша есептеледі.

Basis экраны tab көрініп тұрған кезде `GET /api/arbitrage/clock-health` endpoint-ін 30 секунд сайын
сұрайды. Ресми public server-time endpoint-і бар Binance, Bybit, OKX, Deribit, Kraken және Coinbase үшін
`calibrated/degraded/expired/unavailable` күйі, өлшенген RTT және сағат ығысуының консервативті
белгісіздігі бөлек көрсетіледі. Жасырын tab-та polling тоқтайды.
Public диагностика уақыт/өлшем бойынша шектелген және local time-ды venue time ретінде
көрсетпейді. Basis REST ranking, WebSocket жаңартулары және server alert әзірге Binance/Bybit
калибровкасын және консервативті түзетілген age/skew интервалдарын қолданады. Calibration жоқ немесе degraded болса, route
fail-closed түрде `unverified` болады; барлық мүмкіндік әлі де research-only.

Server шектелген lifecycle күйін де жүргізеді: `first-seen`, `confirmed`, `decaying`, `expired`.
Confirmation бөлек observation және толық market data мен instrument identity coverage талап етеді.
`GET /api/arbitrage/lifecycle` тек оқу үшін берілген және әрқашан `executionPermission: false`.

## Тереңдік, alert және paper позициялары

Таңдалған үш аяқты вилка үшін `POST /api/arbitrage/triangular/verify-depth` екінші кезеңді іске
қосады: үш L2 book snapshot пен WebSocket delta-ларынан қалпына келтіріледі, sequence және ағымдағы
generation тексеріледі, содан кейін тереңдік, комиссия, қадам/минимум, freshness және аяқтар skew-ы
қайта есептеледі. Интерфейс әр аяқтың sequence/generation дәлелін және top-book candidate жойылса,
нақты себебін көрсетеді. Тексеруден өткен бағыт та `readOnly`, `researchOnly`, `executable: false`
болып қалады: key, баланс және order қолданылмайды, үш тізбекті order атомдық болмайды.

`GET /api/arbitrage/depth` оператор сұрағанда ғана әр стаканның шектелген depth мәнін on-demand
sequence-reconstructed L2 арқылы алады. Ол бірдей base quantity, ортақ venue step бойынша rounding, residual delta, VWAP, worst price, level саны,
әр кітаптың бастапқы timestamp/age/skew мәндерін және slippage көрсетеді. Entry spot asks пен
perpetual bids-ті, exit нақты ашық quantity үшін spot bids пен perpetual asks-ті өтеді. Дерек
stale/skewed/incomplete болса немесе quantity сәйкес келмесе, paper әрекеті бұғатталады. Venue
timestamp немесе sequence continuity екі кітапта да расталмаса, quality `unverified`,
`complete: false` болып, paper entry/exit бұғатталады. Binance Spot REST snapshot-ты diff-depth-пен
`lastUpdateId + 1` арқылы байланыстырады, USD-M кейін `pu` тексереді, ал Bybit Spot/Linear V5
WebSocket snapshot арқылы кітапты қайта орнатып, үздіксіз `u` delta-ларын ғана қабылдайды. Gap не
reconnect алдыңғы кітапты дереу жарамсыз етеді. Endpoint стакандарды сұрамай тұрып екі нақты venue instrument үшін жаңа registry
жазбасын, расталған lot step пен биржа минимумдарын талап етеді және metadata жоқ не тексерілмеген
болса fail-closed аяқталады. `quantityStepSource` contract provenance ретінде сақталады, ал сәтті
public analysis `instrument` көзімен және `precisionVerified: true` күйімен қайтарылады.
Strict reconstruction қолжетімсіз болса, REST fallback `rest-snapshot`,
`sequenceVerified: false` деп белгіленеді, display-only болып қалады және paper позициясын аша да,
жаба да алмайды.
Әр жауапта екі құралдың тұрақты ID-лері, native/reviewed `identityScope` және қолжетімді расталған
economic asset ID де беріледі. Browser paper позициясын ашар не жабар алдында оларды symbol,
биржалар, market type, direction және аяқ side-тарымен бірге бастапқы request-пен салыстырады.
Client ажыраса, соңғы ортақ subscriber кеткеннен кейін upstream work тоқтатылады; артық unique
order-book request шексіз queue-ге жиналмай, нақты overload жауабын алады.

Alert таза айырма бапталған шекті кесіп өткенде ғана іске қосылады. Desktop хабарландыру үшін
browser рұқсаты керек. Remote delivery тек авторизацияланған paper-trade сессиясында қолжетімді.
50-ге дейінгі тұрақты ереже browser жабық кезде де жұмыс істейді; crossing state әр rule + route
үшін жеке сақталады. Durable outbox event-ті алдымен сақтап, failed delivery-ді restart-тен кейін
қайталайды және queued/sending/retrying/delivered/failed/cancelled status көрсетеді. External channel
message-ті қабылдап, process `delivered` күйін жазбай тұрып тоқтаса, at-least-once шекарасында
duplicate болуы мүмкін. Alert order жібермейді.

`GET /api/arbitrage/history` SQLite ішіндегі жеті күндік шектелген тарихты оқиды. Белсенді ағын
кезінде 50 үздік бағыт минутына бір рет жазылады, ескі нүктелер тазартылады, ал depth панелі
таңдалған бағыттың соңғы 24 сағатын көрсетеді.

Historical basis replay — бөлек deterministic backend research шекарасы. Immutable manifest event,
source file, registry snapshot, adapter version digest-терін және canonical economic asset ID-лерді
байланыстырады. Schema v4 quantity step, minimum quantity және minimum notional өзгерістерін де
versioned point-in-time epoch ретінде бекітеді. Listing, constraint update және delisting point-in-time
қолданылады, entry/exit recorded depth арқылы өтеді, ал PnL-ге тек settlement `exchangeTs`
`[openedAt, actualClosedAt)` жартылай ашық аралығына түскен verified funding
қосылады. Кеш келген record өзінің `receivedAt` provenance-ын сақтайды, бірақ settlement-ті
жылжытпайды және таңдалған entry/exit-ті өзгертпейді.

Paper позициялары browser-де bounded, versioned append-only event ledger ретінде сақталады. Кіру
және жабу екі стаканның matched VWAP бағасын қолданады. Funding тек settlement time, rate және
reference price берілген қолмен расталған event арқылы жазылады; current ticker rate нақты cash
flow ретінде автоматты есептелмейді. Recovery журналдан дәл сол PnL-ді қайта есептеп, duplicate
немесе өзгертілген event-ті қабылдамайды. Панель realized/open PnL, win rate және жабылған орташа нәтижені көрсетеді. Бұл
биржа шоты емес.
Жиі жаңарту жүздеген DOM жолын қайта құрмас үшін live кесте әр бетте 50 жол көрсетеді.

## Көп қадамды циклдерді зерттеу

`POST /api/arbitrage/n-leg/evaluate` нақты spot metadata мен sequence-і расталған толық стакандарды
қабылдап, төрттен сегіз аяққа дейінгі қарапайым циклдерді шектеулі түрде іздейді және модельдейді.
Нақты `(биржа, актив, бірлік)` сәйкестігі, көрінетін тереңдік, қадамдар мен минимумдар, әр жақтың
комиссиясы және қалдық dust тексеріледі. HTTP жауабы мен public SDK тек оқу режимінде және мәміле
орындамайды.

Оқшауланған server-side paper модулі есептелген N-leg немесе екі аяқты route-family нәтижесін қысқа
мерзімді `paper-multi-leg-plan-v1` жоспарына айналдырады. Ол test fill үшін анық deterministic
ratio-ларды журналға жазады, алғашқы толық емес аяқта тоқтайды, compensation шешімін бекітеді және
кері fill-дерді аяқтардың кері ретімен модельдейді. Нәтиже completed, compensated, exposure жоқ
aborted немесе нақты өтелмеген paper quantity көрсетілген manual review болады. Append-only SQLite
журналы hash пен event sequence-ті тексереді, қатаң run/event лимиттеріне ие және restart-тен кейін
аяқталмаған run-дарды қалпына келтіреді. Ол тек қорғалған
`/api/trade/paper-multi-leg` астында қосылған: `paper-trade` рөлі, ал mutation үшін CSRF қажет.
**Сауда** бөліміндегі қазақша, орысша және ағылшынша қатаң интерфейс нақты JSON-жоспарды импорттап,
recovery күйін, прогондар тізімін және append-only оқиғаларды көрсетеді. Бұл журнал зерттеу
қозғалтқышының тек дәл JSON-жоспарын қабылдайды. Қабылданған R8 релизі осы
модульдің таза қозғалтқышын, builders пен валидациясын сол күйінде версияланған trading store
ішіндегі owner-scoped durable multi-leg интенттері үшін қайта пайдаланады — ортақ капитал резерві,
«екі аяқ + барлық шығын» біріктірілген research PnL және анық қалдық экспозициямен;
`paperPlan: ready` зерттеу карточкасы расталатын «Paper multi-leg іске қосу» әрекетін алады, ал
сервер жоспарды apply кезінде fail-closed қайта құрып тексереді ([kk/TRADING.md](./TRADING.md),
ағылшынша канондық құжат: [Canonical paper portfolios](../PAPER_PORTFOLIOS.md)). Оқшауланған
журналдың өзі, оның қоймасы және admin шектеуі байт бойынша өзгеріссіз қалады. Модульде private
exchange client жоқ, credentials қабылдамайды, public SDK-ға кірмейді және нақты order тізбегін
орындамайды немесе бүкіл биржаға арналған live scanner болып саналмайды.

## Funding curve сценарийлері

**Funding сценарийлері** қойындысында server-owned
`GET /api/arbitrage/funding-curve/universe` жауабынан төрт fresh perpetual құралына дейін таңдауға
болады. Endpoint verified registry-ді Funding Curve нақты іске асырған adapter-лермен қиылыстырады,
сондықтан Binance/Bybit жалпы capability-і қолдаусыз құралды selectable етпейді.
`POST /api/arbitrage/funding-curve` шектелген
көкжиек үшін discrete settlement тізбегін құрып, әр settlement-ке base, оң және теріс additive
stress қолданады. Қатаң public SDK interval, freshness, unit, timestamp, scenario arithmetic және
тұрақты non-executable envelope-ті қайта тексереді.

Funding айырмасы тек exact reviewed `economicAssetId` бірдей құралдар арасында салыстырылады. Оң
funding кезінде long short-қа төлейді, сондықтан төмен cumulative rate зерттеу long-ы, ал жоғары
rate зерттеу short-ы деп көрсетіледі. Бұл trade немесе P&L емес: entry/exit basis, комиссия,
margin, liquidation, capital, borrow және fill risk бұл санға кірмейді. Continuous немесе inferred
schedule үшін ойдан шығарылған interval қолданылмайды, нәтиже fail-closed rejection болады.

## Үздіксіз көпбиржалық бағыттар

**Live бағыттар** қойындысы бет көрініп тұрған кезде ғана
`GET /api/arbitrage/route-families/live` endpoint-ін сұрайды. Шектелген құрал allowlist-і мен
комиссияны сервердегі оператор басқарады; browser оларды өзгерте алмайды. Economic identity тек
орталық exact versioned catalog-тан алынады: environment жолы соған дәл сәйкес болуы тиіс және жаңа
asset equivalence жариялай алмайды. Allowlist болмаса, WebSocket жазылымы іске қосылмайды. Registry қатесі, мерзімі өткен
identity review, gap немесе қолдау көрсетілмейтін құрал ескірген route-ты қайта қолданбай, деректі
қауіпсіз алып тастайды.

OKX, Gate.io және Deribit стакандары protocol continuity тексерілгеннен кейін ғана sequence-ready
болады. Hyperliquid full block snapshot-тары зерттеу дерегі ретінде көрінеді, бірақ sequence proof
ретінде көрсетілмейді. Екі public стакан да local receipt уақыты бойынша fresh болып, аяқтар
арасындағы receipt skew шегінен аспаса, sequence немесе checksum дәлелі болса және ағымдағы
connection generation-ға тиесілі болса, server `market-only` кіру бағасын қоса алады. Ол
нормаланған quantity model-дерді сәйкестендіріп, ағымдағы сатып алу ask-ы мен сату bid-ында көрінетін
ең үлкен ортақ base quantity-ді қолданады. Нәтиже short bid бойынша сату quote value-ы мен long ask
бойынша сатып алу quote value-ының айырмасын және operator environment берген public taker
комиссияларының quote-equivalent бағасына дейінгі/кейінгі entry basis-ті көрсетеді. Бұлар кіру
құнының айырмалары; trading return да, күтілетін пайда да емес. Есеп тек top-book пен
entry-ді қамтиды, full depth немесе round trip емес. Комиссия активі расталмаған, оның base/quote
exposure-ға әсері есепке алынбаған; profile account tier, discount немесе rebate-ті де растамайды.

24 құрал hard bound ішінде server толық compatible universe-ті (ең көбі 552 ordered pair)
enumerate етіп, барлық candidate-ті бағалайды да, содан кейін ғана ең жақсы bounded set-ті
жариялайды. Ranking алдымен fee-adjusted entry quote value айырмасын, кейін basis, visible capacity,
continuity quality және freshness-ті қолданады. Бөлек evaluated/published counter-лері truncation-ды
анық көрсетеді; family немесе route ID реті economics есептелмей тұрып жақсы market row-ды алып
тастай алмайды.

Әр `market-only` жолында strict long/short тәртібімен екі economic identity жазбасы болады. Әр
жазба `instrumentId`, `economicAssetId`, reviewed status, source, version, `asOf` және `validUntil`
мәндерін байланыстырады және `evaluatedAt` кезінде жарамды болуы тиіс. Invalid, әлі күшіне енбеген
немесе expired provenance fail-closed бұғатталады. Туынды capacity, quote value, fee estimate және
basis арифметикасы finite, талап етілген жерде positive әрі өзара келісімді болуы керек. Overflow,
underflow немесе қолдан жасалған туынды field жарияланбай, қабылданбайды. Strict SDK ordered
provenance-ті бөлек тексеріп, туынды арифметиканы қайта есептейді. Continuity, generation,
freshness, quantity немесе venue minimum өтпесе де entry value нәтижесінің орнына нақты market-data
blocker беріледі.

`market-only` орындалатын бағыт дегенді білдірмейді. Әр бағалау `readOnly: true`,
`researchOnly: true`, `executable: false` және `strategyStatus: blocked` күйінде қалады; бұл шекара
order қолдамайды. Есепте расталған balance, capital, inventory, network/withdrawal бағыты, borrow,
derivative margin, full-horizon funding, convergence, expiry/delivery, exit шығыны, нақты fill және
пайда кепілдігі жоқ. Екі market book толық болса да, осы жетіспейтін strategy evidence blocker
ретінде көрінеді.

Жоғарғы runtime және discovery snapshot бір coverage authority жариялайды: `complete`, `current`,
`retainedPriorDiscovery` және шектелген reason (`complete`, configuration disabled/invalid, refresh
pending/failed немесе partial instruments). Сәтті partial refresh current болғанымен incomplete.
Кейінгі registry refresh сәтсіз болса, алдыңғы discovery бақылау үшін сақталуы мүмкін, бірақ ол
incomplete, non-current және retained деп анық белгіленеді: бұл stale evidence, сәтті refresh емес.
Алғашқы refresh сәтсіз болса, ештеңе сақталмайды және жалған `refreshedAt` жасалмайды.

Continuous lifecycle estimated fee-ден кейінгі entry basis-ті зерттеу observation ретінде қолдана
алады, бірақ әр leg evidence-і incomplete және `actionable: false` болып қалады. Market data
себебімен бұғатталған, usable evidence-і жоқ candidate synthetic zero-score route-қа айналмай,
өткізіліп жіберіледі; сондықтан ол бөлек дұрыс observation-ды жарамсыз етпейді. Оның нақты blocker
code-тары lifecycle failure coverage-іне бәрібір кіреді. Runtime refresh reason-дары, non-live
source-тар, excluded/rejected input-тар, candidate/economics truncation және stale market code-тары
incomplete/stale/truncated coverage-ке беріледі. Сондықтан candidate жолдары мен lifecycle
шектелген public market evidence көрсетеді; олар trading signal да, order рұқсаты да емес.

Бөлек daily/manual credential-free canary тоғыз generic continuous venue-дің әрқайсысында бір
selected target бақылайды. Spot үшін public book, derivative үшін book және public funding
observation міндетті; explicit reviewed dYdX — book-only research target. Сақталатын schema-v3 JSON
artifact нақты requirement, environment, integrity, continuity және тұрақты `credentialsUsed:
false`, `executionAttempted: false`, `soakClaimed: false`, `mainnetReadinessClaimed: false`
өрістерін береді. 2026-07-14 local run OKX, Gate, Hyperliquid, Deribit public testnet, Coinbase,
dYdX, KuCoin және MEXC үшін өтті. Kraken осы server TLS egress арқылы қолжетімсіз қалды. Live
run-дар KuCoin binary-marked JSON, Coinbase connection-global sequence және MEXC snapshot/delta
bootstrap race жағдайларын анықтады және regression test қосты. Бір run soak немесе
execution-readiness evidence емес.

Бұл тек зерттеу құралы және order жібермейді. Екі биржаның бағалары атомарлы емес. Комиссия,
нарық тереңдігі, funding, қарыз қолжетімділігі, аударым, latency және liquidation тәуекелі көрінген
айырманы толық жоюы мүмкін. Оң нәтиже пайдаға кепілдік бермейді.
