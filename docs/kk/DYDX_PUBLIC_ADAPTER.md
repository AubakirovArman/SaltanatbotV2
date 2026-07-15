# dYdX public және chain-aware market data

Мәртебе: read-only адаптер ортақ public facade, REST governor және instrument registry-ге
тіркелген; generic continuous hub енді operator allowlist ішіндегі құрал үшін шектелген public
Indexer socket аша алады. Іске асыру 2026-07-14 күні тексерілді. Ағын read-only continuous view
ішіндегі бар dynamic venue/source filters арқылы көрінеді; бөлек dYdX workflow немесе chart selector
жоқ. Қосу сапа шекарасын өзгертпейді: барлық books non-canonical, research-only және
`routeReady: false`.

`backend/src/venues/dydx` кілтсіз perpetual metadata, бір таңдалған top book/depth, ағымдағы funding
бағасын және public Indexer тарихын оқиды. Код wallet, mnemonic, private key, subaccount, signature
немесе order командасын қабылдамайды. Transport тек үш шектелген `GET` route-қа рұқсат береді,
timeout, caller cancellation және response size limit қолданады; custom origin ішінде credentials,
path, query не fragment болмауы тиіс.

## Неліктен стакан тек зерттеуге арналған

dYdX off-chain стаканы ағымдағы proposer mempool-ына тәуелді. Indexer нақты блоктың canonical
mempool-ын тікелей көрмейді, сондықтан оның стаканы уақытша crossed болуы мүмкін. REST нәтиже
`canonical: false`, `executable: false`, `executionStatus: research-only`,
`sequenceAvailable: false` және `timestampSource: local-receive` деп ашық белгіленеді. Logical offset
жоқ crossed REST book қабылданбайды.

WebSocket wrapper алдымен ресми `connected` identity-ді байланыстырып, тек unbatched
`v4_orderbook` арнасына жазылады. Reducer `subscribed` snapshot-тан бастайды, үздіксіз `message_id`
талап етеді және gap, replacement snapshot немесе connection ауысқанда generation-ды жарамсыз
етеді. Ресми offset uncrossing орындалады, бірақ нәтиже `sequence-observed` және
`routeReady: false`: Indexer sequence ағымдағы proposer mempool-ын дәлелдемейді және market
economics-ке жіберілмейді.

## Full-node және finality

`DydxNodeBookReconciler` алдын ала decode жасалған, шектелген `block_height`, `exec_mode`, snapshot
және place/fill/remove batch-тарын өңдейді. Snapshot-қа дейін update еленбейді. `execMode=7`
finalized checkpoint сақтайды, басқа режимдер optimistic болады; optimistic өзгерістер соңғы
checkpoint-ке қайтарыла алады. Finalized height regression, белгісіз order, қате `clobPairId`, unsafe
integer немесе bound асуы fail-closed күйін береді.

Reducer gRPC/WebSocket-ке өзі қосылмайды. Production үшін operator-дың өз full node-ы, ресми protobuf
decoder, reconnect/resnapshot, resource governor және қайталанатын reorg test қажет. Finalized local
off-chain book та `routeReady: false` болып қалады және execution уәдесі емес.

Ағымдағы funding бағасы `nextFundingRate` өрісінен алынады; settled history `effectiveAtHeight`
мәнін сақтайды. Market row келесі есептеудің нақты уақытын бермегендіктен, келесі UTC сағат шекарасы
local assumption ретінде көрсетіледі және `scheduleVerified: false` болады.
Continuous Indexer socket тек book жариялайды: funding синтезделмейді және stream етілмейді,
жоғарыдағы schedule шекарасы бар bounded REST data болып қалады.

Нақты contract, тексеру командалары және ресми сілтемелер
[ағылшын канондық құжатында](../DYDX_PUBLIC_ADAPTER.md) берілген.
