# Kraken және Coinbase public адаптерлері

Мәртебе: shared public adapter және selected-instrument continuous backend; ресми құжаттама
2026-07-14 күні тексерілді. Код тек public/read-only және research scanner operator allowlist арқылы
ғана қосылады. Бұл execution немесе mainnet readiness дәлелі емес.

## Іске асқан шекара

| Биржа | Іске асқан | Әдейі қолдау жоқ |
| --- | --- | --- |
| Kraken | Spot metadata, bulk/selected BBO және L2; inverse/linear perpetual және future metadata/BBO/L2; inverse perpetual current/predicted/history funding | private API, account/order, borrow/transfer, option, бірлігі дәлелденбеген `futures_vanilla`, linear current-funding conversion |
| Coinbase Exchange | Spot products, таңдалған pair үшін L1 BBO және aggregated L2 | JWT/private API, account/order, derivative/funding, барлық product-қа fan-out bulk BBO |

Екі manifest те `privateExecution`, `borrow`, `depositWithdrawal` мәндерін `false` етеді; factory
API key немесе JWT қабылдамайды.

## Identity және өлшем бірліктері

Kraken Spot `assetVersion=1` арқылы сұралады, сондықтан stable pair ID — `BTC/USD`; legacy `X`/`Z`
prefix қолданылмайды. Kraken ресми specification-ы API-дегі `XBT` пен UI-дегі `BTC` бір Bitcoin
екенін растайды. Тек осы reviewed mapping derivative metadata-ға қолданылады, native
`PI_XBTUSD`, `PF_XBTUSD`, `FI_*`, `FF_*` symbol-дары сақталады.

Spot және linear Multi-M book size — base unit. Inverse book size — contract; `contractSize` quote
value береді және settlement base asset-пен жүреді. Coinbase book size және `base_increment` — base
unit, `quote_increment` — price tick.

USD және USDC alias болмайды. `fx_stablecoin: true` 1:1 conversion-ды дәлелдемейді, сондықтан
`BTC-USD` пен `BTC-USDC` ортақ `economicAssetId` алмайды.

Kraken REST book sequence бермейді: `sequence: 0` continuity proof емес, explicit unsequenced
snapshot. Coinbase exchange sequence сақталады. Coinbase auction book indicative және crossed болуы
мүмкін болғандықтан fail-closed қабылданбайды.

Continuous Kraken Spot v2 JSON decimal token-дарын lossless сақтайды, update-терді ретімен
қолданады, book-ты дәл subscribed depth-ке қысқартады және әр хабардан кейін ресми CRC32-ні
тексереді. Local ordinal тек connection generation ішінде жарамды. Kraken Futures үшін бөлек
`kraken-futures-seq` бар: `seq` өсуі керек, бірақ ресми құжат per-product contiguous sequence-ке
кепіл бермегендіктен book research-only болып қалады.

Coinbase тек public Advanced Trade `level2` және `heartbeats` қолданады. 2026 жылғы 14 шілдедегі
credential-free production бақылауы `sequence_num` connection бойынша global екенін және L2,
subscription acknowledgement, heartbeat пен өзге envelope-терді араластыратынын көрсетті.
Сондықтан бірінші sequence `0`, ал әрбір келесі non-error envelope арнасы өңделмей немесе
еленбей тұрып дәл `prior + 1` болуы керек. Snapshot-before-update, absolute quantity және contiguous
heartbeat counter бөлек тексеріледі. Sequence `0` snapshot research-book ретінде жарияланады,
бірақ оң L2 sequence шыққанша route-ready болмайды. Snapshot envelope timestamp-ы delta-ның
matching-engine `event_time` мәнімен салыстырылмайды: ресми snapshot мысалында epoch sentinel бар,
ал production алғашқы реттелген delta-event-ті snapshot envelope timestamp-ынан ертерек бере
алады. Бірінші delta-дан бастап event-time monotonicity бәрібір fail-closed тексеріледі.
`market_trades` order book ретінде
қолданылмайды. Coinbase көпшілік `*-USDC` public subscription үшін сәйкес `*-USD` дерегін
қайтаратындықтан олар fail-closed; құжатталған `USDT-USDC` және `EURC-USDC` — ерекшелік.

## Funding және resource safety

Inverse `PI_` үшін current/predicted absolute rate index price-қа көбейтіліп relative fraction-ға
ауысады; history `relativeFundingRate` мәнін тікелей қолданады. Positive rate — long short-қа төлейді.
Schedule — әр сағат. History қатесі current schedule-ды жоймайды. Linear current funding ticker
бірлігі толық дәлелденбегендіктен әзірге қолдау жоқ.

- default timeout 8 секунд және caller cancellation;
- body cap: Kraken 2 MiB, Coinbase 4 MiB;
- continuous WebSocket frame: default 2 MiB, Coinbase full L2 үшін оқшауланған 8 MiB;
- бір Coinbase frame-інде ең көбі 60 000 update, retained depth ең көбі 1 000 level;
- queue-сіз ең көбі сегіз concurrent request;
- нәтиже depth шегі 1–500 level;
- HTTP 429 және local overload — structured `rate-limit`;
- empty, толық malformed, crossed/locked/unsorted және identity-inconsistent response fail-closed.

Екі Spot feed те daily/manual nine-target credential-free canary-ге қосылды. 2026-07-14 schema-v3
run Coinbase және тағы жеті venue үшін өтті; Kraken осы server TLS egress жолында fail күйінде
қалды. Live observation нақты 4,8 MiB/43k-update Coinbase initial snapshot және
L2/control/heartbeat арасында connection-global sequence жағдайларын анықтады; екеуіне де
deterministic bounds/regression coverage бар. Бір canary soak/readiness evidence емес. Тесттер:
`backend/tests/krakenPublicAdapter.test.ts`,
`backend/tests/coinbasePublicAdapter.test.ts` және `backend/tests/krakenCoinbaseContinuousProtocols.test.ts`.
Ресми source link-тері мен қалған сәтті Kraken-canary қадамы
[канондық ағылшын құжатында](../KRAKEN_COINBASE_PUBLIC_ADAPTERS.md) берілген.
