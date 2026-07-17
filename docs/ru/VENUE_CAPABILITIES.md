# Матрица возможностей, доступности и расширения бирж

Статус: канонический реестр реализации; сверен с репозиторием и официальной документацией
бирж 14 июля 2026 года.

Документ разделяет пять разных уровней: публичные рыночные данные, непрерывные книги с
обнаружением потерь, участие в сканере, приватные операции со счётом/ордерами и юридическую
доступность для оператора. Готовность одного уровня не включает следующий. Здесь нет заявления о
готовности к mainnet; исключённый 7–14-дневный оплачиваемый soak Binance/Bybit не проводился.
В текущем `public-http-paper` все private/live пути неактивны и недоступны:
credential use, signed requests, private streams и live orders отклоняются, а
`private-live` или `ENABLE_LIVE_SPOT=true` останавливают startup.

## Термины статуса

| Метка | Точное значение |
| --- | --- |
| Публично реализовано | Путь без учётных данных зарегистрирован, ограничен по ресурсам и покрыт тестами репозитория |
| Continuous route-ready | Книга выбранного инструмента может попасть только в исследовательский discovery после проверки sequence/checksum, поколения соединения и свежести |
| Continuous research-only | Поток или редьюсер есть, но доказательств целостности/каноничности недостаточно для route-ready |
| Неактивный private-справочник | Аутентифицированный код может существовать для будущего review, но текущий runtime не может его активировать |
| Планируемый кандидат | Адаптера ещё нет; это приоритет исследования, а не обещание |
| Исключено | Возможность сознательно не предоставляется для указанного развёртывания или правового контура |

`Route-ready` всё равно означает только **исследовательский вход**, а не исполнимый арбитраж. Он
не доказывает наличие баланса, займа, маржи, комиссий, сетей перевода, одновременного исполнения
или доступность продукта в юрисдикции.

## Что действительно подключено

| Поверхность | Текущее состояние |
| --- | --- |
| Графики | Только публичные свечи Binance и Bybit; ограничения market type и price source указаны явно |
| Нативный сканер Binance/Bybit | Межбиржевой и внутрибиржевой spot/perpetual basis, выбранные треугольные исследования и нативные спреды Bybit |
| Общий публичный REST-фасад | OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin и MEXC через `/api/market-data/:venue/*` |
| Реестр инструментов | Нативные источники Binance/Bybit/OKX плюс все зарегистрированные публичные адаптеры; по умолчанию выдаются только свежие строки |
| Общий continuous-модуль | Девять бирж: OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin и MEXC; allowlist задаёт оператор, браузер имеет только чтение |
| Приватная торговля | Только Paper доступен; Binance/Bybit private-код неактивен, а все общие публичные адаптеры объявляют private execution равным false |

`GET /api/instruments` отдаёт нормализованные метаданные из полного реестра. `GET /api/venues`
отдаёт манифесты возможностей. Оба ответа содержат свежесть и происхождение данных. Публичный
фасад не принимает учётные данные. `GET /api/arbitrage/route-families/live` показывает опциональный
continuous-модуль; браузер не может добавлять подписки, подтверждать экономическую идентичность или
менять комиссии.

## Матрица текущих бирж

| Биржа | Реализованный публичный/read-only контур | Статус целостности continuous | Использование в сканере | Граница приватного контура |
| --- | --- | --- | --- | --- |
| Binance | Нативный реестр, свечи графика, Spot и derivative top-book/depth/funding | Есть специализированные потоки сканера, но Binance не входит в общий continuous-public-feed | Текущий Binance↔Bybit и внутрибиржевой basis, выбранное треугольное исследование по top book | USDⓈ-M execution существует только как неактивный retained-код. Live Spot выключен. Inverse execution не поддерживается |
| Bybit | Нативный реестр, свечи, Spot/linear/inverse public data и нативный spread book | Есть специализированные snapshot/delta книги, но Bybit не входит в общий continuous-public-feed | Текущие basis, triangular и native-spread исследования | Spot, USDT-linear и UTA private paths — неактивный future-справочник; текущий runtime отклоняет их |
| OKX | Зарегистрированы REST metadata, BBO, ограниченная depth и переменный funding для Spot, swap и dated futures | `books` восстанавливается по `prevSeqId/seqId`; только корректное свежее поколение может стать route-ready. Устаревший checksum `0` не является доказательством | Общий continuous research по allowlist оператора; в selector графика не выведен | Нет account/private/order поверхности |
| Gate.io | Зарегистрированы REST metadata, BBO, depth и funding для Spot и USDT perpetual | OBU Spot/perpetual использует full + `U/u`; старый incremental mode требует контролируемый REST-ID bridge. Корректная свежая книга может стать route-ready | Общий continuous research по allowlist; в графиках не выведен | Нет account/private/order поверхности |
| Hyperliquid | Зарегистрированы публичные HyperCore `/info`, выбранные L2 и funding для first-DEX Spot/perpetual | Каждый `l2Book` — атомарный block snapshot без protocol sequence/checksum. Это только continuous research, книга исключена из route-ready | Только исследовательский сигнал общего continuous | Нет wallet, address, signing, `/exchange`, HyperEVM и order-кода |
| Deribit | Зарегистрированы public JSON-RPC metadata/BBO/depth/funding для perpetual, dated future и option | `book` использует точные `prev_change_id/change_id`; корректная свежая книга может стать route-ready | Общий continuous research и отдельный read-only options-parity evaluator/workbench | Только allowlist public methods; нет ключей и private methods |
| Kraken | Зарегистрированы Spot и inverse/linear Futures metadata, BBO/depth; funding inverse perpetual | Spot v2 использует lossless decimals и CRC32 после каждого update и может стать route-ready. `seq` Futures v1 наблюдается, но не документирован как непрерывный для каждого продукта, поэтому Futures остаётся research-only | Общий continuous research по allowlist; в графиках не выведен | Нет account/private/order поверхности |
| Coinbase | Зарегистрированы Coinbase Exchange Spot metadata и выбранные L1/L2 | Public Advanced Trade `level2` + `heartbeats` проверяет connection-global sequence для каждого non-error конверта и отдельный heartbeat counter. Sequence zero не допускается в route-ready. `market_trades` никогда не считается книгой. Большинство alias `*-USDC` отклоняется | Общий continuous research по allowlist; выбранный Spot canary прошёл 2026-07-14, в графиках не выведен | Нет JWT, account или order поверхности |
| dYdX | **Зарегистрированы** публичные Indexer perpetual metadata, выбранная REST-книга и funding | Общий hub открывает bounded unbatched Indexer `v4_orderbook` socket и проверяет `connected` identity и непрерывный `message_id`. Proof намеренно остаётся `sequence-observed`: книга неканонична, research-only и всегда `routeReady: false`. Funding остаётся REST-only и из socket не публикуется | Generic continuous research по operator allowlist и динамическим browser filters; нет отдельного dYdX workflow/chart selector и route-ready economics | Нет wallet, mnemonic, subaccount, signing, node mutation или order-кода |
| KuCoin | **Зарегистрированы** public Spot и linear-USDT-perpetual metadata, executable BBO, REST depth и funding | Public Spot/Futures sockets ждут `welcome` и принимают только режим после 2026-07-15 `depth=increment@10ms`, `rpiFilter: 0`; self-seeded snapshot `O=C` и точные overlapping `O..C` ranges могут стать route-ready, а gap/time regression/reconnect снимают поколение. Binary-marked JSON проходит bounded fatal UTF-8 decode | Generic continuous research по allowlist; выбранный Spot canary прошёл 2026-07-14, chart selector отсутствует и нужны повторные scheduled-артефакты | Нет key, signing, account, borrow или order поверхности |
| MEXC | **Зарегистрированы** public Spot и linear-USDT-perpetual metadata, BBO/depth и funding | Spot использует bounded decoder точных public Protobuf tags и delta-triggered single-flight REST/version bridge; Futures запрашивает unmerged JSON через `compress: false` и exact `version + 1`. REST-only seed не публикуется, gap/reconnect снимает поколение | Generic continuous research по allowlist; выбранный Spot canary прошёл 2026-07-14, chart selector отсутствует и нужны повторные scheduled-артефакты | Нет key, signing, account, borrow или order поверхности |

dYdX, KuCoin и MEXC уже не являются просто изолированными папками или будущими кандидатами: все
три имеют bounded generic continuous paths, поэтому общий модуль охватывает девять бирж. Browser
строит venue/source filters динамически из live response и не требует отдельных hard-coded кнопок;
venue-specific диагностика и chart selectors остаются отдельной UX-задачей. dYdX остаётся
non-canonical/non-route-ready.

Schema-v3 canary теперь содержит по одной проверенной цели для каждой из девяти generic continuous
бирж. Локальный прогон 2026-07-14 прошёл для OKX, Gate, Hyperliquid, Deribit public testnet,
Coinbase, dYdX, KuCoin и MEXC; Kraken остался host TLS-egress failure. Live-прогоны выявили и
получили regression-тесты для binary-marked JSON KuCoin, connection-global sequence Coinbase и
гонки snapshot/delta bootstrap MEXC. Это разовое evidence публичной связности, а не soak или
execution readiness.

## Правда о приватном исполнении

| Продукт | Статус | Важная граница |
| --- | --- | --- |
| Paper Spot/Futures и multi-leg journal | Поддерживается для тестов | Симулированные fills и recovery не доказывают исполнение на бирже |
| Binance Spot | Выключен | Ещё нет аутентифицированного Spot execution stream/accounting |
| Binance USDⓈ-M | Неактивный справочник | Signed REST, private order updates и reconciliation есть в retained-коде; текущий runtime не активирует их |
| Binance inverse | Не поддерживается | Order path отсутствует |
| Bybit Spot | Неактивный справочник | Retained-код требует `ENABLE_LIVE_SPOT`, но текущий runtime отклоняет этот флаг |
| Bybit USDT linear | Неактивный справочник | Signed v5 lifecycle/reconciliation есть в retained-коде; текущий runtime не активирует их |
| Bybit UTA cross collateral/manual debt | Неактивный справочник | Текущий runtime отклоняет borrow, repay и collateral mutations |
| Все девять общих публичных адаптеров | Не поддерживается по дизайну | Манифесты держат private execution, borrow и transfers равными false |

Подробности находятся в [матрице исполнения](EXCHANGE_CAPABILITIES.md). Результат публичного
сканера нельзя использовать как доказательство прав или средств счёта.

## Предлагаемый порядок новых бирж

Ниже **планируемые кандидаты**. Сейчас у них нет кода или статуса сканера в репозитории. До любой
строки ниже приоритетнее усилить уже зарегистрированные continuous sources, поддерживать их protocol
conformance и добавлять полезную venue-specific диагностику. Новые биржи не должны вытеснять
доведение существующих интеграций.

| Приоритет | Биржа | Польза | Первый допустимый public scope | Условие целостности и права до включения в сканер |
| --- | --- | --- | --- | --- |
| Next 1 | Crypto.com Exchange | Spot + derivatives + funding расширят cross-venue basis, same-venue carry и сравнение funding | Metadata, selected REST books с точными decimal, затем выбранные `SNAPSHOT_AND_UPDATE` books и funding/estimated-funding | Нужны `u/pu`, свежий REST resync, точная product identity, региональная доступность и review API/data terms. Без private methods |
| Next 2 | BitMEX | Ценные perpetual/futures, Spot, funding, instrument и settlement data | Public instruments/funding и одна выбранная `orderBookL2` family с явной liquidity-pool identity | WS использует `partial/insert/update/delete`, но проверенный table protocol не содержит contiguous sequence/checksum для каждой delta. До доказательства loss detection только research; учесть поле `pool` 2026 года и changelog |
| Next 3 | Bitfinex | Spot, derivatives, funding books и derivative status полезны для basis и borrow-aware research | Public configs/mapping, selected REST book, затем WS v2 books/status | Включить и проверить checksum; считать `SEQ_ALL` beta; не фиксировать длину массивов; лимит 30 subscriptions; review API/Market Data Terms |
| Next 4 | Gemini | Metadata различает `spot`/`swap`, REST books сохраняют точные decimal strings, derivatives дают funding amount | Сначала public symbols/details и bounded selected REST book; затем только подтверждённые crypto Spot/perpetual differential-depth symbols | WS документирует snapshot и `U/u`, но примеры включают prediction markets. Нужно доказать product/symbol coverage в fixtures и уточнить market-data permission |
| Next 5 | Bitstamp | Spot, public derivatives/funding и endpoints восстановления public order events расширяют basis/funding research | Public markets, exact selected book и funding; streaming только после protocol fixtures | Для коммерческого использования exchange data прямо требуется Data License Agreement. Это блокер hosted redistribution; отдельно проверить continuity WebSocket book и региональную доступность derivatives |
| Next 6 | Backpack | Public crypto Spot/perpetual metadata, mark/index/funding, funding history и deep books; есть явный REST/WS bridge | Только crypto `SPOT`/`PERP`: exact-decimal markets, funding, bounded REST depth, затем selected depth. `IPERP`, `DATED`, `PREDICTION`, `RFQ` и tokenized stocks пока исключить | REST `lastUpdateId` + contiguous WS `U..u`, при gap новый REST snapshot. Учитывать 100 мс speed bump всех non-post-only taker orders как latency cost. Проверить продукты для Казахстана и terms hosted redistribution |
| Next 7 | WhiteBIT | Spot/perpetual metadata, current/history funding и цепочка `past_update_id → update_id` полезны для basis | Public markets/futures/funding и одна depth family только после data-use gate; книга всегда помечена как исключающая RPI | Snapshot, точная continuity и resubscribe при gap. Public depth не показывает RPI. API terms разрешают personal use, но исключают resale/commercial use, сбор цен и data mining без письменного согласия: hosted aggregation заблокирован до разрешения и review Казахстана |
| Next 8 | Phemex | Spot, COIN-M и USDⓈ-M perpetual metadata, mark/index/funding и funding history полезны для linear/inverse basis | Сначала public products, exact/scaled REST snapshots и funding; WS books только research-only | Есть snapshots, incremental updates, `sequence` и periodic snapshots, но официальный контракт не обещает `previous + 1` и checksum. Loss detection не предполагается. Terms ограничивают API транзакциями и запрещают иное commercial use data; нужны письменное разрешение и review Казахстана/продукта |
| Исключено для private live из Казахстана | Bitget | Public aggregation можно исследовать отдельно | По умолчанию ничего | Terms от 16.06.2026 называют Казахстан prohibited country. Private execution не строить; public use тоже требует отдельного review лицензии/условий |

Приоритет зависит и от ценности для сканера, и от качества документированного восстановления потерь.
Юридический или лицензионный блокер может изменить порядок без изменения кода.

### Gate Казахстана и hosted data для второй волны

Review выполнен **14.07.2026**. Официальные страницы не дают юридической гарантии или product
entitlement для оператора из Казахстана; отсутствие страны в списке запретов не равно разрешению.
WhiteBIT оставляет доступ зависимым от гражданства/residence/location и ограничивает commercial API
reuse. В текущем списке Phemex Казахстан не назван, но есть catch-all, discretion и ограниченная API
license. Backpack сейчас не относит Казахстан к явно not-served регионам, однако предупреждает, что
список меняется. До подтверждения venue конкретных Spot/perpetual products, deployment region и
hosted/open-source data use все три строки остаются выключенными planned candidates без private или
execution возможностей.

## Как новые биржи улучшают сканер

После доказательства identity и executable books новая биржа может дать:

- cross-venue Spot↔Spot и Spot↔perpetual/future «двойные вилки»;
- same-venue Spot↔perpetual/future basis и funding carry;
- внутрибиржевые треугольники при трёх подтверждённых рынках и конверсиях количества;
- N-leg routes только при совместимых units, fees, capacity, freshness и recovery на каждой ноге;
- borrow/funding/network overlays как явные затраты, а не догадки по тикеру.

Одинаковый текст тикера не равен экономической идентичности. Нужны явные quote/settlement,
chain/network, linear/inverse, contract size, expiry, collateral и региональный продукт. Без этого
новые биржи быстрее умножают ложные сигналы, чем реальные возможности.

Начальный точный каталог BTC/ETH имеет schema 1 и версию `2026-07-14.v1`; период review — с
2026-07-14 по 2026-10-12. Он охватывает только явные Spot/perpetual ID из нормализованных fixtures
зарегистрированных бирж. Утверждение адаптера удаляется до применения каталога; неизвестный,
wrapped, expiry-specific или несовпадающий по полям инструмент не получает `economicAssetId` и не
входит в межбиржевой маршрут до публикации новой reviewed-версии.

## Обязательные гейты каждого кандидата

1. До кода зафиксировать официальный URL, дату review, product/region и правила использования data.
2. Создать credential-free adapter с ограничением payload, timeout, cancellation, resource governor
   и точной нормализацией symbol/contract/unit.
3. Сохранять decimal strings до валидации; не выдумывать contract value, stablecoin equivalence,
   exchange timestamp или funding interval.
4. Реализовать настоящий snapshot/delta protocol с connection generation. Gap, checksum failure,
   crossed book, timestamp regression, overload и reconnect обязаны инвалидировать книгу и требовать
   новый snapshot.
5. Оставлять поток research-only, если официальный protocol не доказывает loss detection.
6. Добавить fixtures snapshot/update/gap/reconnect/checksum, malformed/bounds tests и необязательный
   credential-free canary. Разовый canary не равен soak.
7. До scanner candidates добавить identity, reviewed fees/funding schedule, freshness/skew и capacity.
8. Private trading — отдельный поздний проект с account snapshots, fills, fees, reconciliation, kill
   switch, test environment и legal review. Public registration не должна включать его.

## Обязательная запись возможностей адаптера

Манифест должен явно содержать public ticker/top-book/depth/trades; Spot, margin, perpetual, dated
future, option, native spread; mark/index/last/candles; funding, borrow и network status; subscription
limits, sequence/checksum и REST bootstrap; settlement/collateral и linear/inverse units; private
reads/execution/demo; дату eligibility review. Отсутствующее значение равно `false`, а не «вероятно».

Версионированная public plugin boundary принимает только `public-read-only` descriptor без учётных
данных в factory. Plugin certification, live canary, private conformance и operator eligibility —
разные гейты.

## Официальные источники

Текущие интеграции:

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
- [MEXC Spot API и Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
- [MEXC Futures API](https://mexcdevelop.github.io/apidocs/contract_v1_en/)

Кандидаты и legal gates:

- [Crypto.com Exchange API v1](https://exchange-developer.crypto.com/exchange/v1)
- [BitMEX WebSocket API](https://www.bitmex.com/app/wsAPI)
- [BitMEX API changelog](https://www.bitmex.com/app/apiChangelog)
- [Bitfinex WS v2 books](https://docs.bitfinex.com/reference/ws-public-books)
- [Bitfinex sequence/checksum flags](https://docs.bitfinex.com/docs/ws-general)
- [Bitfinex derivatives API](https://docs.bitfinex.com/docs/derivatives)
- [Bitfinex API terms](https://www.bitfinex.com/legal/general/api-terms/)
- [Bitstamp API, funding, gap recovery и commercial-data notice](https://www.bitstamp.net/api/)
- [Gemini market-data API](https://developer.gemini.com/trading/rest-api/market-data)
- [Gemini WebSocket depth/gap recovery](https://developer.gemini.com/trading/websocket/streams)
- [Gemini derivatives API](https://developer.gemini.com/trading/rest-api/derivatives)
- [Backpack markets/depth/funding/streams](https://docs.backpack.exchange/)
- [Backpack supported regions](https://support.backpack.exchange/exchange/exchange-account/identity-verification/supported-regions)
- [Backpack trading rules и market-data boundary](https://support.backpack.exchange/legal/vara-disclosures/exchange-trading-rules)
- [WhiteBIT public market metadata](https://docs.whitebit.com/api-reference/market-data/market-info)
- [WhiteBIT futures/funding metadata](https://docs.whitebit.com/api-reference/market-data/available-futures-markets-list)
- [WhiteBIT funding history](https://docs.whitebit.com/api-reference/market-data/funding-history)
- [WhiteBIT depth ordering/recovery](https://docs.whitebit.com/websocket/market-streams/depth)
- [WhiteBIT API terms](https://whitebit.com/terms/api)
- [WhiteBIT user agreement](https://whitebit.com/terms)
- [Phemex products/funding/order-book protocol](https://phemex-docs.github.io/)
- [Phemex terms и API-use boundary](https://phemex.com/help-center/phemex-terms-of-use)
- [Bitget terms](https://www.bitget.com/support/articles/360014944032-terms-of-use)
