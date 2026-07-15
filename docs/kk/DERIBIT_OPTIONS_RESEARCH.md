# Deribit ашық деректері және опцион паритетін зерттеу

Мәртебесі: ашық adapter `/api/market-data/deribit/*` арқылы қолжетімді; pure parity engine bounded
`POST /api/arbitrage/options-parity/evaluate` және ашық TypeScript SDK арқылы берілді. Scanner UI,
EN/RU/KK scenario lab бар; сауда және Deribit private access іске асырылмаған.

## Ашық адаптер

`backend/src/venues/deribit` — кілт пен токенді қабылдамайтын read-only JSON-RPC адаптері. Тек futures/perpetual/options тізімі, ticker/top book, стакан тереңдігі және funding тарихы рұқсат етіледі. Capability manifest әрқашан `privateExecution: false` деп көрсетеді.

Deribit-та bounded bulk executable ticker әдісі жоқ. Сондықтан `tickers()` анық `unsupported`
қайтарады; client бір exact instrument таңдап `ticker()` немесе `depth()` шақырады және мыңдаған
option бойынша шексіз JSON-RPC fan-out жасамайды.

Transport HTTP пен JSON-RPC-ты бөлек тексереді: жауап өлшемі, timeout және caller abort, `2.0` нұсқасы, сұрау `id` сәйкестігі, тек бір `result` немесе `error`, белгілі Deribit timing өрістері, биржа қатесі және payload құрылымы. Қайшы жауап fail-closed қағидасымен қабылданбайды.

Deribit көлем бірліктері араластырылмайды:

- perpetual және inverse future `amount` — quote/USD бірлігінде;
- option және linear future `amount` — базалық актив бірлігінде;
- `contract_size` жеке multiplier ретінде сақталады;
- негізгі қадам `qty_tick_size` арқылы алынады, `min_trade_amount` fallback-ы анық белгіленеді;
- premium/settlement активтері, expiry, strike, call/put, European exercise және linear option-ның future арқылы бірден cash settlement процесі бөлек сақталады.

Deribit funding-і үздіксіз есептеледі. `funding_8h` сегіз сағаттық reference estimate ретінде ғана беріледі, сондықтан `scheduleVerified: false`: адаптер жалған дискретті төлем уақытын жасамайды.

## Опцион паритеті қозғалтқышы

`backend/src/arbitrage/engines/optionsParity` put-call parity, conversion/reversal, long/short box және synthetic forward нұсқаларын зерттеу үшін модельдейді. Есептік жазбаға немесе order execution-ға қатысы жоқ.

Call мен put underlying, expiry, strike, strike asset, settlement asset/process бойынша толық сәйкес және European болуы тиіс. Box екі strike қолданады, бірақ expiry және settlement identity бірдей болады.

Көлем тек орындалатын bid/ask тереңдігімен есептеледі. Native step пен base-per-contract multiplier арқылы барлық legs бір base-equivalent көлемге келтіріледі. Fee, premium FX, risk-free/dividend rate, exercise және settlement assumption-дары source/asOf-пен анық беріледі. Settlement cash flow тек `settlementAsset === valuationAsset` болса қабылданады: expiry кезіндегі FX моделі жоқ болса, қозғалтқыш жасырын conversion қолданбай, сценарийді fail closed етеді. Әр short option үшін availability және margin capacity расталуы керек; reversal үшін underlying borrow, capacity және borrow rate қосымша міндетті.

Барлық нәтиже `research-simulation`, `visible-depth-taker`, `executable: false` деп белгіленеді. Бұл risk-free пайда, капитал табыстылығы немесе live order орындау уәдесі емес.

## Ашық HTTP және SDK шекарасы

`POST /api/arbitrage/options-parity/evaluate` толық primary call/put сериясын, box үшін optional толық
екінші серияны, underlying стаканын, target base quantity және timestamped assumptions қабылдайды.
Стаканның әр жағы 400 деңгеймен, assumption map сегіз жазбамен, pairing 4–64 iteration-мен, нәтиже
16 candidate және 64 rejection-мен шектелген. Strict schema белгісіз өрістерді, соның ішінде API key,
secret және order-shaped деректерді қабылдамайды. Response `no-store` және тұрақты `readOnly: true`,
`researchOnly: true`, `executable: false`, `execution: "none"` мәндерін береді.

Response caller-supplied contract-ты анық көрсетеді: instrument expiry; European automatic
hold-to-expiry cash-equivalent settlement; settlement және valuation asset тең болмаса settlement FX
жоқ; premium FX пен option/underlying fee бөлек беріледі. SDK-дегі `optionsParity()` дәл осы request
type-тарын және strict runtime parser-ді қолданады. Parser unknown field, жалған executable,
strategy/leg shape, PnL/fee/edge және timestamp сәйкессіздігін, assumption policy өзгерісін қабылдамайды.
HTTP пен SDK account data оқымайды, credential қабылдамайды және order құрмайды.

## Scenario зертханасы

**Screener → Опцион паритеті** режимінде бір European call/put pair және underlying үшін top-book
бағасы, strike, expiry horizon, base quantity, short capacity, rate және fee енгізіледі. Browser дәл
сол strict public request-ті құрады, барлық мәнді live venue/account evidence емес caller assumption
деп көрсетеді және candidate economics, visible-depth legs пен rejection себептерін шығарады.
Snapshot account entitlement емес, key сақтамайды және order батырмасы жоқ. Component test және
Chromium E2E crossed book, localization және pure HTTP route-ты тексереді.

## Тексеру

Recorded fixtures inverse BTC options, multiplier бар linear USDC options, inverse perpetual, ticker/depth, continuous funding және JSON-RPC error жағдайларын қамтиды. Unit/conformance тесттері бірліктерді, settlement пен missing settlement FX rejection-ды, envelope/id тексеруін, timeout/abort-ты, depth walking, fee cap, барлық candidate түрлерін, stale/skew/missing-leg fail-closed тәртібін, HTTP bound және adversarial SDK parsing-ті тексереді.

Тек ресми дереккөздер қолданылды: [JSON-RPC](https://docs.deribit.com/articles/json-rpc-overview), [errors](https://docs.deribit.com/articles/errors), [instruments](https://docs.deribit.com/api-reference/market-data/public-get_instruments), [ticker](https://docs.deribit.com/api-reference/market-data/public-ticker), [order book](https://docs.deribit.com/api-reference/market-data/public-get_order_book), [funding history](https://docs.deribit.com/api-reference/market-data/public-get_funding_rate_history), [inverse options](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options), [linear USDC options](https://support.deribit.com/hc/en-us/articles/31424932728093-Linear-USDC-Options).
