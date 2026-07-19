# Hyperliquid ашық адаптері

Күйі: ашық backend adapter 2026 жылғы 19 шілдеде ресми API-мен салыстырылып,
`/api/market-data/hyperliquid/*` және кәдімгі chart source таңдауы арқылы қолжетімді. First-DEX
perpetual candle, chart L2/trades және paper robot data source қосылды; private execution жоқ.

Кілтсіз адаптер тек ашық `POST /info` сұрауларын орындайды: spot/default-perp DEX метадеректері,
`l2Book`, `predictedFundings`, `fundingHistory` және `candleSnapshot`. `/exchange`, wallet, agent key, қолтаңба,
пайдаланушы адресі, ордер орындау, қарыз не аударым жоқ. HyperEVM, indexer, HIP-3 DEX және `#...`
outcome активтері бұл scope-қа кірмейді.

Интерфейсте `Hyperliquid` first-DEX perpetual source ретінде таңдалады. Мысалы, `BTCUSDT` тек
provider шекарасында native `BTC` coin атауына ауысады. `linear` және last-trade candle мәжбүрлі;
spot, inverse, mark және index басқа source-пен үнсіз алмастырылмайды. Public WebSocket candle, L2
және trades ағындарын heartbeat/reconnect және REST backfill арқылы береді.

Paper robot Hyperliquid market data қолдана алады, бірақ order, balance және PnL жергілікті
simulation ішінде қалады. Wallet/key жасалмайды және биржаға order жіберілмейді. Live wallet
қосылымы HTTPS пен key storage/signing қауіпсіздік тексерісіне дейін өшірулі қалады.

Spot үшін token ID, token index және pair index бөлек сақталады; execution asset ID мәні
`10000 + pairIndex`. PURR `PURR/USDC` атауын, қалған жұптар `@{pairIndex}` нативті атауын қолданады.
Идентификатор mainnet/testnet пен token ID-ді қамтиды, сондықтан UBTC → BTC сияқты UI remap әртүрлі
активтерді біріктірмейді. Perp үшін metadata universe жолының индексі сақталады. `isDelisted`
тексерілген `closed` күйін береді; spot үшін осындай ресми flag жоқ және бұл белгісіздік көрсетіледі.

Мөлшер базалық активпен өлшенеді, қадам `10^-szDecimals`. Барлық бағаға ортақ static tick size жоқ:
баға ең көбі бес мәнді цифрдан және perp үшін `6 - szDecimals`, spot үшін `8 - szDecimals` ондық
таңбадан тұрады. Сондықтан `tickSize: 0` тексеру жоқ дегенді емес, dynamic/unknown мәнін білдіреді;
нақты ереже `priceRules` ішінде сақталады.

Орындалатын bid/ask тек `l2Book` арқылы алынады. `allMids` қолданылмайды, өйткені бос стаканда API
соңғы мәміле бағасын қайтара алады. Mid, mark және oracle `executable: false` белгісі бар жеке
`referenceContext` ішінде. REST стаканы 20 деңгеймен шектеледі және sequence/checksum бермейді;
сондықтан `sequenceVerified: false` деп белгіленеді. Әр `l2Book` тек бір coin қабылдайтындықтан,
bulk `tickers()` анық `unsupported` қайтарады: бір anonymous request жүздеген upstream шақыруға
айналмайды. Таңдалған бір жұп үшін `ticker()` немесе `depth()` қолданылады.

Ағымдағы funding `predictedFundings` ішіндегі `HlPerp` мәнінен, тарих `fundingHistory` арқылы
алынады. Расталған аралық — бір сағат, шек — сағатына ±4%. Ағымдағы болжам қатесі нәтижені
тоқтатады; тек тарих қатесі ағымдағы бағаны сақтап, `sourceErrors` ішіне жазылады. Болжамда server
timestamp жоқ, сондықтан бақылау уақыты `local-receive` деп нақты белгіленеді.

Әр сұрауда timeout, cancellation, жауап көлемінің шегі және қатаң validation бар. Толық сипаттама
мен ресми сілтемелер: [Hyperliquid public adapter](../HYPERLIQUID_PUBLIC_ADAPTER.md).
