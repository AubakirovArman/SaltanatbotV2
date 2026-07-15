# KuCoin және MEXC заманауи public адаптерлері

Мәртебе: public/read-only adapter-лер shared registry, public HTTP, generic SDK, instrument catalog
және REST governor-ға тіркелді; ресми құжаттама 2026-07-14 күні тексерілді. Recorded fixture және
deterministic failure/reconnect test бар. KuCoin және MEXC bounded public WebSocket shared protocol
factory/hub-қа қосылды. Екі Spot target та 2026-07-14 local schema-v3 credential-free canary-ден
өтті; қайталанатын scheduled artifact пен browser workflow әлі қажет. Private execution, soak
немесе mainnet readiness жоқ.

Екі биржа да ортақ read-only continuous view ішіндегі бар dynamic venue/source filters арқылы
көрінеді. Бөлек venue workflow, diagnostic page немесе chart selector жоқ; бұл bounded
socket/factory/hub paths қосылуынан бөлек UX жұмысы.

## Capability шекарасы

| Биржа | Іске асқан | Әдейі қолдау жоқ |
| --- | --- | --- |
| KuCoin | Spot және linear USDT perpetual metadata, bulk/selected BBO, REST depth, current/predicted/history funding, `increment@10ms` үшін bounded Spot/Futures public sockets | retired `depth=increment`, inverse/delivery, account/order/borrow/transfer |
| MEXC | Spot және linear USDT perpetual metadata/depth/funding, Spot BBO, depth арқылы selected perpetual BBO, bounded Spot Protobuf decoder/socket және бөлек Futures `version + 1` socket | ескі Spot JSON WS, size жоқ perpetual bulk BBO, account/order/borrow/transfer |

Manifest-терде `privateExecution`, `borrow`, `depositWithdrawal` — `false`; factory key немесе
signature қабылдамайды.

## Protocol және unit

KuCoin тек 2026-07-15 күні тоқтаған legacy mode орнына енгізілген `obu depth=increment@10ms`
қабылдайды. Алғашқы snapshot үшін `O=C`; кейін absolute delta
`O <= previous C + 1` және `C > previous C` шарттарын орындауы керек. Zero size level-ді жояды,
reconnect жаңа snapshot талап етеді, әр side 500 level-мен шектеледі. Spot size — base unit,
perpetual size — contract; `multiplier` бір contract-тың base amount-ын сақтайды. Inverse және
delivery fail-closed қабылданбайды.

Shared continuous protocol құжатталған `wss://x-push-spot.kucoin.com` немесе
`wss://x-push-futures.kucoin.com` public endpoint-інде generation-local `welcome` күтеді, содан
кейін тек `obu`, `rpiFilter: 0`, `depth=increment@10ms` жібереді және application ping/pong
қолданады. `O/C/M/P` integer token-дері parse алдында дәл сақталады. Book route-ready input-қа тек
positive safe sequence бар self-seeded snapshot-тан кейін кіреді. Gap, timestamp regression,
replacement snapshot, malformed/oversized message, missing pong немесе reconnect generation-ды
дереу алып тастайды.
KuCoin JSON-ды binary frame деп белгілесе, сол lossless parser алдында 2 MiB cap және fatal UTF-8
decode қолданылады; жарамсыз byte үнсіз алмастырылмайды.
KuCoin-ның қазіргі UTA құжаты API-ді active development деп белгілеп, production live trading үшін
қолданбауды айтады; сондықтан sequence-verified book та тек public research input болып қалады.

MEXC Spot тек жаңа `wss://wbs-api.mexc.com/ws` және ресми Protobuf schema қолданады. Binary frame
text-ке айналмайды: explicit decoder тек public `PushDataV3ApiWrapper.publicAggreDepths` wire
tag-терін қабылдайды және private/account қоса басқа oneof body-лерді қабылдамайды. Сол narrow
interface арқылы protoc-generated decoder енгізуге болады, frame/update bound тәуелсіз қалады.
Open/ack/control хабарламалары REST-ті бастамайды. Бірінші нақты depth delta buffer-ге жиналып,
ағымдағы connection generation үшін бір single-flight snapshot request бастайды; REST аяқталғанша
келесі delta-лар да buffer-де қалады. Reducer snapshot version-ды `[fromVersion,toVersion]`
диапазонымен байланыстырады, одан кейін дәл
`fromVersion = previous toVersion + 1` талап етеді. MEXC Futures — `compress: false` қойылған бөлек
native JSON `push.depth`; merged/zipped mode әр intermediate version келгенін дәлелдемейді:
snapshot-тан кейін әр жаңа `version` алдыңғы мәннен бірге үлкен болуы тиіс.

Екі socket shared hub-қа тіркелген және process-wide MEXC REST/WS governor қолданады. REST-ті тек
бірінші depth delta-дан кейін бастау subscribe/snapshot race-ін жабады. Close/reconnect generation
күтіп тұрған request-ін тоқтатады, ал кеш келген stale нәтиже еленбейді. REST snapshot жалғыз өзі
WebSocket evidence болып жарияланбайды: version-ды ілгерілеткен нақты delta қажет. Тек current
generation-ның fresh positive safe version-ы route-ready research-ке кіреді. Нәтиже әлі
`readOnly`, `research-only`, `executable: false`; order рұқсаты жоқ.

REST default origin — Futures үшін де қазіргі `https://api.mexc.com`. Futures size — contract;
`contractSize`, `priceUnit`, `volUnit`, `minVol` сақталады. `collectCycle` және `nextSettleTime`
funding schedule-ды дәлелдейді. Perpetual bulk ticker bid/ask size бермегендіктен жарияланбайды;
selected BBO bounded depth-тен алынады.

MEXC нөл `baseSizePrecision`/`quoteAmountPrecision` берсе, ол тек «minimum белгісіз» sentinel ретінде
сақталады; venue minimum жоқ деген дәлел емес.

## Safety және evidence

- anonymous `GET` қана, 8 секунд timeout және caller cancellation;
- body cap 4 MiB, queue-сіз 8 concurrent request;
- depth шегі: KuCoin 1–100, MEXC 1–500;
- gap/reconnect/oversized/crossed/empty/unsorted book fail-closed;
- structured timeout/cancel/rate-limit/HTTP/exchange/validation error.

Тесттер: `backend/tests/kucoinPublicAdapter.test.ts`, `backend/tests/mexcPublicAdapter.test.ts`,
`backend/tests/modernVenueBookProtocols.test.ts`, `backend/tests/kucoinContinuousProtocol.test.ts`,
`backend/tests/mexcSpotProtobufDecoder.test.ts`, `backend/tests/mexcContinuousProtocol.test.ts`;
delta-triggered single-flight REST, snapshot кезіндегі buffering, cancellation және reconnect-тен
кейінгі stale нәтижені елемеу де тексеріледі.
Кеңейтілген 2026-07-14 live run екі Spot target үшін де өтті. Ол KuCoin binary-marked JSON және
MEXC subscribe/snapshot race жағдайларын анықтады; bounded fatal UTF-8 path пен delta-triggered
single-flight REST bridge енді осы жағдайлардың deterministic regression coverage-і. Browser
workflow, қайталанатын scheduled canary artifact және regional terms review әлі қажет. Бір public
run soak немесе readiness evidence емес; MEXC streaming funding REST-only. Private Bitget exclusion
өзгермейді. Canonical
source link-тері [ағылшын нұсқасында](../KUCOIN_MEXC_PUBLIC_ADAPTERS.md).
