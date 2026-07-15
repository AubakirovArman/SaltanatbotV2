# Gate ашық REST адаптері

Күйі: ашық backend adapter 2026 жылғы 14 шілдеде тексеріліп, `/api/market-data/gate/*` арқылы
қолжетімді. Ол `/api/instruments`, live scanner/chart UI немесе private trading құрамына кірмейді.

API кілтін қолданбайтын адаптер Gate API v4 ашық деректерін қолдайды:

- SPOT және тікелей USDT мерзімсіз контракт метадеректері;
- perpetual үшін орындалатын all/single және SPOT үшін single top-of-book;
- 1–100 деңгеймен шектелген толық REST order-book snapshot;
- ағымдағы funding, тексерілген кесте және 1–100 есептелген тарихи мән.

SPOT көлемі базалық активпен өлшенеді. `precision` баға қадамын, `amount_precision` мөлшер қадамын
береді. Perpetual көлемі контрактпен өлшенеді, ал `quanto_multiplier` бір контракттағы базалық
актив мөлшерін сақтайды. `order_price_round` және `order_size_min` жоғалмайды.
`minimumNotional: 0` шектеу жоқ дегенді емес, мән белгісіз екенін білдіреді.

Gate `enable_decimal=true` арқылы ондық contract size мүмкіндігін көрсетеді, бірақ ашық схемада
жеке quantity increment бермейді. Адаптер lot step мәнін болжамай, мұндай жолды қауіпсіз түрде
қабылдамайды. Белгісіз settlement/direction/status, қиылысқан top-book, sequence жоқ стакан,
реттелмеген немесе қиылысқан деңгейлер және көлемі жоқ баға да қабылданбайды.

Сүзілген SPOT ticker `lowest_size`/`highest_size` мәндерін қайтарады, бірақ барлық жұптың ағымдағы
тізімінде олар жоқ. Сондықтан `tickers("spot")` анық `unsupported` қайтарады: адаптер орындалмайтын
бағаны жарияламайды және шамамен 2000 жеке сұрау fan-out жасамайды. SPOT `ticker()` және perpetual
all/single толық қолданылады.

Order book үшін Gate берген `update` қолданылады: SPOT-та миллисекунд, perpetual-да секундтан
миллисекундқа түрлендіріледі. Ticker және contract-funding жауабында exchange timestamp жоқ,
сондықтан `exchangeTs` жергілікті қабылдау уақытына тең және биржаның дәл event time мәні деп
қаралмайды.

Funding `funding_next_apply` уақытында қолданылады; келесі уақыт тек дұрыс `funding_interval`
арқылы есептеледі. Ағымдағы дерек қатесі нәтижені тоқтатады, тек тарих қатесі ағымдағы бағаны
сақтап, `sourceErrors` ішіне жазылады.

Timeout, caller cancellation, бөлек rate-limit/HTTP/exchange/validation қателері, 2 MiB жауап шегі
және offline жазылған fixtures бар. Capability manifest private execution, аккаунт, қарыз және
аударымдарды `false` күйінде қалдырады.

Толық сипаттама: [Gate public adapter](../GATE_PUBLIC_ADAPTER.md). Ресми дереккөздер:
[Gate API v4](https://www.gate.com/docs/developers/apiv4/en/) және
[Gate perpetual futures API](https://www.gate.com/docs/developers/apiv4/en/futures/).
