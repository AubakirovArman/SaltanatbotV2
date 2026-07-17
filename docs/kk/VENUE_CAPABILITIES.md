# Биржалардың мүмкіндіктері, қолжетімділігі және кеңейту матрицасы

Күйі: іске асырудың канондық тізілімі; репозиториймен және биржалардың ресми құжаттарымен
2026 жылғы 14 шілдеде салыстырылды.

Бұл құжат бес бөлек деңгейді ажыратады: ашық нарық деректері, жоғалуды анықтайтын үздіксіз
кітаптар, сканерге қатысу, жеке шот/ордер операциялары және оператордың құқықтық қолжетімділігі.
Бір деңгейдің дайындығы келесісін қоспайды. Мұнда mainnet дайындығы туралы мәлімдеме жоқ;
алынып тасталған 7–14 күндік ақылы Binance/Bybit soak өткізілген жоқ.
Қазіргі `public-http-paper` ішінде барлық private/live жолдары белсенді емес:
credential use, signed requests, private streams және live orders қабылданбайды,
ал `private-live` немесе `ENABLE_LIVE_SPOT=true` startup-ты тоқтатады.

## Күй атаулары

| Белгі | Нақты мағынасы |
| --- | --- |
| Ашық түрде іске асқан | Тіркелгі деректерінсіз жол тіркелген, ресурстары шектелген және репозиторий тесттерімен жабылған |
| Continuous route-ready | Таңдалған құралдың WebSocket кітабы sequence/checksum, connection generation және freshness тексерулерінен кейін ғана зерттеу discovery-іне кіре алады |
| Continuous research-only | Ағын немесе reducer бар, бірақ route-ready үшін тұтастық/канондық дәлел жеткіліксіз |
| Белсенді емес private анықтамасы | Аутентификацияланған код future review үшін болуы мүмкін, бірақ қазіргі runtime оны іске қоса алмайды |
| Жоспарланған үміткер | Адаптер іске асырылмаған; бұл зерттеу басымдығы, уәде емес |
| Алынып тасталған | Көрсетілген deployment немесе құқықтық ауқым үшін әдейі ұсынылмайды |

`Route-ready` бәрібір тек **зерттеу кірісі**, орындалатын арбитраж емес. Ол баланс, қарыз,
маржа, комиссия, аударым желісі, бір мезгілдегі fill немесе өнімнің юрисдикцияда қолжетімділігін
дәлелдемейді.

## Нақты қосылған мүмкіндіктер

| Бет/қызмет | Ағымдағы шындық |
| --- | --- |
| Графиктер | Тек Binance және Bybit ашық candle бағыттары; market type және price source шектеулері анық көрсетіледі |
| Binance/Bybit төл сканері | Биржааралық және бір биржадағы Spot/perpetual basis, таңдалған үшбұрышты зерттеу және Bybit native spread |
| Ортақ public REST фасады | OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin және MEXC — `/api/market-data/:venue/*` арқылы |
| Құралдар тізілімі | Binance/Bybit/OKX төл көздері және барлық тіркелген public adapters; әдепкіде тек fresh rows беріледі |
| Ортақ continuous модулі | Тоғыз биржа: OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin және MEXC; allowlist операторға тиесілі, браузер тек оқиды |
| Жеке сауда | Тек Paper қолжетімді; Binance/Bybit private коды белсенді емес, барлық ортақ public adapters private execution=false деп жариялайды |

`GET /api/instruments` толық тізілімнен нормаланған metadata береді. `GET /api/venues` capability
manifest береді. Екі жауапта да freshness және provenance бар. Public facade тіркелгі деректерін
қабылдамайды. `GET /api/arbitrage/route-families/live` optional continuous модулін көрсетеді;
браузер subscription қоса алмайды, economic identity бекітпейді және fee overlay өзгертпейді.

## Қазіргі биржалар матрицасы

| Биржа | Іске асқан public/read-only ауқымы | Continuous тұтастық күйі | Сканердегі қазіргі қолданыс | Жеке контур шекарасы |
| --- | --- | --- | --- | --- |
| Binance | Төл registry, chart candles, Spot және derivative top-book/depth/funding | Сканерге арналған ағындар бар, бірақ Binance ортақ continuous-public-feed модуліне кірмейді | Қазіргі Binance↔Bybit және same-venue basis, таңдалған top-book triangular research | USDⓈ-M execution тек белсенді емес retained кодта бар. Live Spot өшірулі. Inverse execution қолдау таппайды |
| Bybit | Төл registry, candles, Spot/linear/inverse public data және native spread book | Арнайы snapshot/delta books бар, бірақ Bybit ортақ continuous-public-feed модуліне кірмейді | Қазіргі basis, triangular және native-spread research | Spot, USDT-linear және UTA private paths — белсенді емес future анықтамасы; қазіргі runtime оларды қабылдамайды |
| OKX | Spot, swap және dated futures үшін тіркелген REST metadata, BBO, bounded depth және variable funding | `books` ағыны `prevSeqId/seqId` арқылы қалпына келеді; тек дұрыс fresh generation route-ready бола алады. Ескірген checksum `0` дәлел емес | Operator allowlist арқылы ортақ continuous research; chart selector-да жоқ | Account/private/order беті жоқ |
| Gate.io | Spot және USDT perpetual үшін REST metadata, BBO, depth және funding тіркелген | Spot/perpetual OBU full + `U/u` қолданады; legacy incremental mode governed REST-ID bridge талап етеді. Дұрыс fresh book route-ready бола алады | Operator allowlist арқылы ортақ continuous research; chart-та жоқ | Account/private/order беті жоқ |
| Hyperliquid | First-DEX Spot/perpetual үшін public HyperCore `/info`, selected L2 және funding тіркелген | Әр `l2Book` protocol sequence/checksum жоқ atomic block snapshot. Тек continuous research, route-ready books ішіне кірмейді | Ортақ continuous-та тек research signal | Wallet, address, signing, `/exchange`, HyperEVM және order коды жоқ |
| Deribit | Perpetual, dated future және option үшін public JSON-RPC metadata/BBO/depth/funding тіркелген | `book` нақты `prev_change_id/change_id` қолданады; дұрыс fresh book route-ready бола алады | Ортақ continuous research және бөлек read-only options-parity evaluator/workbench | Тек public-method allowlist; credentials/private methods жоқ |
| Kraken | Spot және inverse/linear Futures metadata, BBO/depth; inverse perpetual funding тіркелген | Spot v2 lossless decimals және әр update-тен кейін CRC32 қолданады, route-ready бола алады. Futures v1 `seq` өнім бойынша contiguous деп құжатталмаған, сондықтан research-only | Operator allowlist арқылы ортақ continuous research; chart-та жоқ | Account/private/order беті жоқ |
| Coinbase | Coinbase Exchange Spot metadata және selected L1/L2 тіркелген | Advanced Trade public `level2` + `heartbeats` әр non-error envelope үшін connection-global sequence және бөлек heartbeat-counter continuity тексереді. Sequence zero route-ready емес. `market_trades` ешқашан book емес. Көптеген `*-USDC` alias fail-closed | Operator allowlist арқылы ортақ continuous research; selected Spot canary 2026-07-14 өтті, chart-та жоқ | JWT, account немесе order беті жоқ |
| dYdX | **Тіркелген** public Indexer perpetual metadata, selected REST book және funding | Ортақ hub bounded unbatched Indexer `v4_orderbook` socket ашады және `connected` identity мен үздіксіз `message_id` тексереді. Proof әдейі `sequence-observed` болып қалады: book non-canonical, research-only және әрқашан `routeReady: false`. Funding REST-only, socket оны жарияламайды | Operator allowlist және dynamic browser filters арқылы generic continuous research; бөлек dYdX workflow/chart selector және route-ready economics жоқ | Wallet, mnemonic, subaccount, signing, node mutation немесе order коды жоқ |
| KuCoin | **Тіркелген** public Spot және linear-USDT-perpetual metadata, executable BBO, REST depth және funding | Public Spot/Futures sockets `welcome` күтеді және тек 2026-07-15 кейінгі `depth=increment@10ms`, `rpiFilter: 0` қабылдайды; self-seeded `O=C` snapshot және нақты overlapping `O..C` ranges route-ready бола алады, gap/time regression/reconnect generation-ды алып тастайды. Binary-marked JSON bounded fatal UTF-8 decode арқылы өтеді | Operator allowlist generic continuous research; selected Spot canary 2026-07-14 өтті, chart selector жоқ және repeated scheduled artifact қажет | Key, signing, account, borrow немесе order беті жоқ |
| MEXC | **Тіркелген** public Spot және linear-USDT-perpetual metadata, BBO/depth және funding | Spot exact public Protobuf tag үшін bounded decoder және delta-triggered single-flight REST/version bridge қолданады; Futures `compress: false` арқылы unmerged JSON және exact `version + 1` сұрайды. REST-only seed жарияланбайды, gap/reconnect generation-ды алып тастайды | Allowlist арқылы generic continuous research; selected Spot canary 2026-07-14 өтті, chart selector жоқ және repeated scheduled artifact қажет | Key, signing, account, borrow немесе order беті жоқ |

dYdX, KuCoin және MEXC енді жай ғана оқшауланған папка немесе болашақ үміткер емес: үшеуінде де
bounded generic continuous path бар, сондықтан ортақ модуль тоғыз биржаны қамтиды. Browser
venue/source filters-ті live response-тан динамикалық құрады, hard-coded жеке батырмалар қажет емес;
venue-specific diagnostics және chart selectors бөлек UX жұмысы болып қалады. dYdX
non-canonical/non-route-ready болып қалады.

Schema-v3 canary енді тоғыз generic continuous venue-дің әрқайсысы үшін бір reviewed target
қамтиды. 2026-07-14 local run OKX, Gate, Hyperliquid, Deribit public testnet, Coinbase, dYdX,
KuCoin және MEXC үшін өтті; Kraken host TLS-egress failure болып қалды. Live run-дар KuCoin
binary-marked JSON, Coinbase connection-global sequence және MEXC snapshot/delta bootstrap race
жағдайларын анықтады және оларға regression test қосылды. Бұл бір реттік public connectivity
evidence; soak немесе execution readiness емес.

## Жеке орындау бойынша шындық

| Өнім | Күй | Маңызды шекара |
| --- | --- | --- |
| Paper Spot/Futures және multi-leg journal | Тест үшін қолдау бар | Simulated fills/recovery биржадағы execution-ды дәлелдемейді |
| Binance Spot | Өшірулі | Authenticated Spot execution stream/accounting әлі жоқ |
| Binance USDⓈ-M | Белсенді емес анықтама | Signed REST, private order updates және reconciliation retained кодта бар; қазіргі runtime іске қоспайды |
| Binance inverse | Қолдау жоқ | Order path жоқ |
| Bybit Spot | Белсенді емес анықтама | Retained код `ENABLE_LIVE_SPOT` талап етеді, бірақ қазіргі runtime бұл flag-ты қабылдамайды |
| Bybit USDT linear | Белсенді емес анықтама | Signed v5 lifecycle/reconciliation retained кодта бар; қазіргі runtime іске қоспайды |
| Bybit UTA cross collateral/manual debt | Белсенді емес анықтама | Қазіргі runtime borrow, repay және collateral mutations жолдарын қабылдамайды |
| Барлық тоғыз ортақ public adapter | Дизайн бойынша қолдау жоқ | Manifest private execution, borrow және transfers мәндерін false ұстайды |

Толық мәлімет [execution capability matrix](EXCHANGE_CAPABILITIES.md) ішінде. Public scanner
нәтижесі account entitlement дәлелі ретінде қолданылмайды.

## Жаңа биржалардың ұсынылған реті

Бұлар **жоспарланған үміткерлер**. Қазір репозиторийде олардың коды да, scanner status-ы да жоқ.
Төмендегі кез келген жолдан бұрын тіркелген continuous sources-ты hardening жасау, олардың protocol
conformance-ын сақтау және пайдалы venue-specific diagnostics қосу басым. Жаңа venue бар
интеграцияларды аяқтау жұмысын ығыстырмайды.

| Басымдық | Биржа | Пайдасы | Алғашқы рұқсат етілетін public scope | Scanner-ге дейінгі integrity/legal gate |
| --- | --- | --- | --- | --- |
| Next 1 | Crypto.com Exchange | Spot + derivatives + funding cross-venue basis, same-venue carry және funding comparison кеңейтеді | Metadata, exact-decimal selected REST books, кейін selected `SNAPSHOT_AND_UPDATE` books және funding/estimated-funding | `u/pu`, fresh REST resync, нақты product identity, regional availability және API/data-terms review қажет. Private methods жоқ |
| Next 2 | BitMEX | Perpetual/futures, Spot, funding, instrument және settlement data құнды | Public instruments/funding және нақты liquidity-pool identity бар бір selected `orderBookL2` family | WS `partial/insert/update/delete` қолданады, бірақ қаралған table protocol әр delta үшін contiguous sequence/checksum бермейді. Loss detection дәлелденгенше research-only; 2026 `pool` field және changelog ескеріледі |
| Next 3 | Bitfinex | Spot, derivatives, funding books және derivative status basis/borrow-aware research үшін пайдалы | Public configs/mapping, selected REST book, кейін WS v2 books/status | Checksum қосып тексеру; `SEQ_ALL` — beta; array length бекітпеу; 30-subscription budget; API/Market Data Terms review |
| Next 4 | Gemini | Metadata `spot`/`swap` ажыратады, REST books exact decimal strings сақтайды, derivatives funding amount береді | Алдымен public symbols/details және bounded selected REST book; кейін тек дәлелденген crypto Spot/perpetual differential-depth symbols | WS snapshot және `U/u` gap recovery құжаттайды, бірақ мысалдарда prediction markets бар. Fixture арқылы product/symbol coverage дәлелдеу және market-data permission анықтау қажет |
| Next 5 | Bitstamp | Spot, public derivatives/funding және public order-event gap recovery basis/funding research кеңейтеді | Public markets, exact selected book және funding; streaming тек protocol fixtures кейін | Commercial exchange data пайдалану үшін Data License Agreement тікелей талап етіледі. Hosted redistribution үшін блокер; WS book continuity және regional derivative eligibility бөлек тексеріледі |
| Next 6 | Backpack | Public crypto Spot/perpetual metadata, mark/index/funding, funding history және deep books; анық REST/WS bridge бар | Тек crypto `SPOT`/`PERP`: exact-decimal markets, funding, bounded REST depth, кейін selected depth. `IPERP`, `DATED`, `PREDICTION`, `RFQ` және tokenized stocks әзірге жоқ | REST `lastUpdateId` + contiguous WS `U..u`; gap болса жаңа REST snapshot. Барлық non-post-only taker order үшін 100 мс speed bump latency cost ретінде есептеледі. Қазақстан product access және hosted redistribution terms тексеріледі |
| Next 7 | WhiteBIT | Spot/perpetual metadata, current/history funding және `past_update_id → update_id` тізбегі basis үшін пайдалы | Data-use gate-тен кейін public markets/futures/funding және бір depth family; book RPI liquidity жоқ деп белгіленеді | Snapshot, exact continuity және gap кезінде resubscribe. Public depth RPI көрсетпейді. API terms personal use береді, бірақ жазбаша келісімсіз resale/commercial use, price collection және data mining-ті қоспайды; hosted aggregation permission және Қазақстан review-іне дейін блоктаулы |
| Next 8 | Phemex | Spot, COIN-M және USDⓈ-M perpetual metadata, mark/index/funding және funding history linear/inverse basis үшін пайдалы | Алдымен public products, exact/scaled REST snapshots және funding; WS books тек research-only | Snapshot, incremental, `sequence` және periodic snapshot бар, бірақ official contract `previous + 1` не checksum уәдесін бермейді. Loss detection болжанбайды. Terms API-ді transaction purpose-пен шектейді және басқа commercial data use-ты қабылдамайды; жазбаша approval және Қазақстан/product review қажет |
| Қазақстаннан private live үшін алынып тасталған | Bitget | Public aggregation бөлек зерттелуі мүмкін | Әдепкіде жоқ | 2026-06-16 Terms Қазақстанды prohibited country деп көрсетеді. Private execution жасалмайды; public use те бөлек data-license/terms review талап етеді |

Басымдық тек нарық өлшеміне емес, scanner value және құжатталған loss recovery сапасына тәуелді.
Legal/data-license blocker код өзгермей-ақ ретті өзгерте алады.

### Қазақстан және екінші толқынның hosted-data gate-і

Review күні: **2026-07-14**. Official pages Қазақстан operator-ына legal немесе product entitlement
бермейді; restricted list ішінде елдің болмауы permission емес. WhiteBIT access-ті
citizenship/residence/location-ға тәуелді қалдырады және commercial API reuse-ты шектейді. Phemex-тің
қазіргі тізімінде Қазақстан аталмағанмен, catch-all, discretion және limited API license бар.
Backpack Қазақстанды қазіргі named not-served list-ке қоспайды, бірақ тізім өзгеретінін ескертеді.
Venue нақты Spot/perpetual products, deployment region және hosted/open-source data use-ты растағанша,
үш жол да private/account/execution мүмкіндігі жоқ disabled planned candidate болып қалады.

## Жаңа биржалар сканерді қалай жақсартады

Identity және executable books дәлелденгеннен кейін жаңа venue мыналарды қоса алады:

- cross-venue Spot↔Spot және Spot↔perpetual/future «қос вилкалар»;
- same-venue Spot↔perpetual/future basis және funding carry;
- үш native market және quantity conversion дәлелденгенде бір биржалық triangular routes;
- барлық leg үшін units, fees, capacity, freshness және recovery сәйкес болғанда ғана N-leg routes;
- public ticker-ден болжанбайтын, анық borrow/funding/network cost overlays.

Бірдей ticker мәтіні economic identity емес. Quote/settlement currency, chain/network,
linear/inverse, contract size, expiry, collateral және regional product анық болуы керек. Әйтпесе жаңа
venues нақты мүмкіндікке қарағанда false positive-ті жылдамырақ көбейтеді.

Алғашқы exact BTC/ETH catalog schema 1 және `2026-07-14.v1` нұсқасын қолданады; review мерзімі
2026-07-14–2026-10-12. Ол тек registered venue fixture-лерінде normalized болған нақты
Spot/perpetual ID-лерді қамтиды. Adapter assertion catalog қолданылар алдында жойылады; unknown,
wrapped, expiry-specific немесе field-mismatch instrument `economicAssetId` алмайды және жаңа
reviewed catalog version шыққанша cross-venue route-қа кірмейді.

## Әр үміткерге міндетті қақпалар

1. Кодтан бұрын official URL, review date, product/region және data-use terms жазу.
2. Bounded payload, timeout, cancellation, resource governor және exact symbol/contract/unit
   normalization бар credential-free adapter жасау.
3. Decimal strings тексерілгенше сақтау; contract value, stablecoin equivalence, exchange timestamp
   немесе funding interval ойдан шығармау.
4. Connection generation бар нақты snapshot/delta protocol іске асыру. Gap, checksum failure,
   crossed book, timestamp regression, overload немесе reconnect кітапты invalidate етіп, fresh
   snapshot талап етуі тиіс.
5. Official protocol loss detection дәлелдемесе, ағынды research-only күйінде қалдыру.
6. Snapshot/update/gap/reconnect/checksum fixtures, malformed/bounds tests және optional
   credential-free canary қосу. Бір canary — soak емес.
7. Scanner candidate алдында identity, reviewed fees/funding schedule, freshness/skew және capacity қосу.
8. Private trading — account snapshots, fills, fees, reconciliation, kill switch, test environment
   және legal review бар бөлек кейінгі жоба. Public registration оны қоспауы керек.

## Adapter capability жазбасының міндетті өрістері

Manifest public ticker/top-book/depth/trades; Spot, margin, perpetual, dated future, option, native
spread; mark/index/last/candles; funding, borrow және network status; subscription limits,
sequence/checksum және REST bootstrap; settlement/collateral және linear/inverse units; private
reads/execution/demo; eligibility review date мәндерін анық жариялауы тиіс. Жоқ мүмкіндік `false`,
«мүмкін» емес.

Versioned public plugin boundary credentials қабылдамайтын factory бар `public-read-only`
descriptor-ды ғана қабылдайды. Plugin certification, live canary, private conformance және operator
eligibility — бөлек қақпалар.

## Ресми дереккөздер

Қазіргі интеграциялар:

- [Binance Spot API](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Binance USDⓈ-M Futures API](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)
- [Bybit instruments](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [Bybit spread instruments](https://bybit-exchange.github.io/docs/v5/spread/market/instrument)
- [OKX API](https://www.okx.com/docs-v5/en/)
- [Gate API v4](https://www.gate.com/docs/developers/apiv4/ws/en/)
- [Hyperliquid WebSocket API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)
- [Deribit API](https://docs.deribit.com/)
- [Kraken Spot v2 book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book)
- [Coinbase Advanced Trade WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- [dYdX Indexer WebSockets](https://docs.dydx.xyz/indexer-client/websockets)
- [dYdX full-node streaming](https://docs.dydx.xyz/nodes/full-node-streaming)
- [KuCoin order-book migration](https://www.kucoin.com/docs-new/3470221w0)
- [MEXC Spot API және Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
- [MEXC Futures API](https://mexcdevelop.github.io/apidocs/contract_v1_en/)

Үміткерлер және legal gates:

- [Crypto.com Exchange API v1](https://exchange-developer.crypto.com/exchange/v1)
- [BitMEX WebSocket API](https://www.bitmex.com/app/wsAPI)
- [BitMEX API changelog](https://www.bitmex.com/app/apiChangelog)
- [Bitfinex WS v2 books](https://docs.bitfinex.com/reference/ws-public-books)
- [Bitfinex sequence/checksum flags](https://docs.bitfinex.com/docs/ws-general)
- [Bitfinex derivatives API](https://docs.bitfinex.com/docs/derivatives)
- [Bitfinex API terms](https://www.bitfinex.com/legal/general/api-terms/)
- [Bitstamp API, funding, gap recovery және commercial-data notice](https://www.bitstamp.net/api/)
- [Gemini market-data API](https://developer.gemini.com/trading/rest-api/market-data)
- [Gemini WebSocket depth/gap recovery](https://developer.gemini.com/trading/websocket/streams)
- [Gemini derivatives API](https://developer.gemini.com/trading/rest-api/derivatives)
- [Backpack markets/depth/funding/streams](https://docs.backpack.exchange/)
- [Backpack supported regions](https://support.backpack.exchange/exchange/exchange-account/identity-verification/supported-regions)
- [Backpack trading rules және market-data boundary](https://support.backpack.exchange/legal/vara-disclosures/exchange-trading-rules)
- [WhiteBIT public market metadata](https://docs.whitebit.com/api-reference/market-data/market-info)
- [WhiteBIT futures/funding metadata](https://docs.whitebit.com/api-reference/market-data/available-futures-markets-list)
- [WhiteBIT funding history](https://docs.whitebit.com/api-reference/market-data/funding-history)
- [WhiteBIT depth ordering/recovery](https://docs.whitebit.com/websocket/market-streams/depth)
- [WhiteBIT API terms](https://whitebit.com/terms/api)
- [WhiteBIT user agreement](https://whitebit.com/terms)
- [Phemex products/funding/order-book protocol](https://phemex-docs.github.io/)
- [Phemex terms және API-use boundary](https://phemex.com/help-center/phemex-terms-of-use)
- [Bitget terms](https://www.bitget.com/support/articles/360014944032-terms-of-use)
