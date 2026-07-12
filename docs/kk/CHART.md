# График және кестелік деректер

## Нарық пен интервалды таңдау

Жоғарғы панельден құралды, timeframe-ді және график түрін таңдаңыз. Криптовалюта үшін Binance
немесе Bybit дереккөзін бөлек таңдауға болады. Индикаторлар, салыстырылатын құралдар, сызбалар және
белсенді стратегия бір уақыт диапазонында көрсетіледі.

Қарапайым және іші бос candle, Heikin Ashi, bar, line, step line, area, baseline және Renko түрлері бар. Іші бос candle өскен денені боямайды, ал step line келесі өзгеріске дейін алдыңғы бағаны ұстайды.

## Басқару

- Тінтуір дөңгелегі курсор тұрған candle маңында масштабтайды.
- Сүйреу уақыт диапазонын жылжытады, double-click бастапқы масштабты қайтарады.
- `LIN` / `LOG` / `%` баға шкаласын ауыстырады.
- Соңғы баға белгісі ағымдағы candle жабылғанға дейінгі уақытты көрсетеді; курсор жанындағы HUD уақыт, OHLC, өзгеріс және volume мәндерін ашады.
- Сол жақтағы **Көрінетін диапазонның volume profile** батырмасы VPVR қабатын ауыстырады. Көлденең жолақтар баға бойынша өсу/төмендеу volume үлесін, үзік сызық POC деңгейін, ал айқынырақ бөлік үздіксіз 70% value area-ны көрсетеді. Масштаб не pan өзгергенде профиль тек көрінетін candle-дар үшін қайта есептеледі.

VPVR `EST` деп белгіленеді: OHLCV candle тек жалпы volume береді, candle ішіндегі нақты мәміле таралуын бермейді. Сондықтан volume High–Low диапазоны кесіп өтетін баға жолақтарына пропорционал бағаланады. Дәл tick/L2 профиль үшін trades немесе order-book ағыны қажет.

## Order book heatmap

**Order book heatmap** батырмасы таңдалған биржаның нақты public top‑20 деңгейлерін қосады. Графиктің оң жағындағы 60 секундтық liquidity тарихында bids жасыл, asks қызыл болады; жарықтық `price × size` номинал көлемінің логарифмдік шкаласын көрсетеді. Деңгейлер нақты баға шкаласына байланған, сондықтан кең диапазонда жұқа көрінуі қалыпты — ағымдағы баға маңын zoom жасаңыз.

Frontend тек same-origin `/orderbook` арнасына қосылады. Backend бір market үшін бір upstream-ды барлық клиентке ортақ пайдаланады, browser snapshot жиілігін секундына төртпен және әртүрлі белсенді кітаптарды 32-мен шектейді; баяу client send buffer шексіз өспей тұрып ажыратылады. Соңғы клиент кеткенде upstream жабылады. Жасырылған tab-та stream pause болады; reconnect, stale және error күйлері ашық көрсетіледі. Synthetic стакан жасалмайды.

Дереккөздер: [Binance WebSocket Streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams), [Bybit Orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook).

## Footprint және мәміле дельтасы

**Live trade footprint** батырмасы Binance немесе Bybit-тің нақты public print-терін қосады. Әр candle көрінетін price row-ларға бөлінеді: қызыл жартысы aggressive sell номиналын, жасыл жартысы aggressive buy номиналын көрсетеді. Zoom жеткілікті болса, жолдың ішінде `sell × buy` мәндері жазылады. Төменгі жолақта candle delta бағандары мен көк cumulative-delta сызығы бар. Badge-тегі `Δ %` формуласы: `(buy − sell) / (buy + sell)`.

Frontend тек батырма қосылғаннан кейінгі жаңа мәмілелерді same-origin `/trade-flow` арқылы алады. Backend бір market үшін бір upstream пайдаланады, print-терді 100 мс batch-ке біріктіреді, бір хабарды 500 trade-пен және жалпы stream санын 32-мен шектейді. Reconnect жаңа observation window бастайды: жоқ history ойдан жасалмайды және OHLCV estimate-пен алмастырылмайды. Tab жасырылса немесе browser component render-ін өткізіп жіберсе, WebSocket пен Canvas pause болады.

Side баға қозғалысынан болжанбайды: Binance-та `m=true` aggressive sell дегенді білдіреді, Bybit-та `S` taker side-ты тікелей береді. Дереккөздер: [Binance Aggregate Trade Streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#aggregate-trade-streams), [Bybit Public Trade](https://bybit-exchange.github.io/docs/v5/websocket/public/trade).

### Imbalance, stacked imbalance және ықтимал absorption

Контур кемінде `3:1` diagonal imbalance-ты көрсетеді: ағымдағы жолдың buy көлемі төменгі жолдың sell көлемімен, sell көлемі жоғарғы жолдың buy көлемімен салыстырылады. Dominant side осы candle-дегі ең үлкен біржақты көлемнің кемінде 8%-ы болуы керек. Бір side-тағы қатар тұрған үш немесе одан көп imbalance `3×` не үлкен bracket-ке біріктіріледі. Imbalance, stack және `ABS?` саны Canvas түсіне ғана емес, кәдімгі DOM мәтініне де шығарылады.

`ABS?` ромбы тек candle-дің бақыланған бөлігіндегі **ықтимал absorption** дегенді білдіреді: кемінде 20 normalized print, абсолют delta кемінде 35%, candle көлемі көрінетін candle-дардағы ең үлкен бақыланған көлемнің кемінде 15%-ы болуы және close aggressor бағытына қарсы High–Low жартысында қалуы керек. Төменгі жартыда жабылған buy aggression — buy absorption ықтималдығы; жоғарғы жартыда жабылған sell aggression — sell absorption ықтималдығы.

Бұл live-only heuristic, trading signal немесе historical exchange data емес. Нәтиже қосылған уақытқа және zoom-ға тәуелді: price row-лар screen pixel бойынша агрегатталады, сондықтан scale өзгергенде cluster саны да өзгеруі мүмкін. Reconnect analysis window-ды тазалайды. Сауда шешімі үшін context, liquidity және ұзақ history-ді бөлек тексеріңіз.

### Flow alert-тер

Footprint badge астында keyboard арқылы басқарылатын **FLOW ALERTS** лентасы бар. Ол stacked imbalance, `ABS?`, CVD spike және жеке large print үшін event жасай алады. Event exchange trade немесе candle/side бойынша deduplicate жасалады және сол observation window ішінде dismiss не clear-дан кейін қайта шықпайды. Memory-де ең көбі сегіз event қалады, соңғы төртеуі көрінеді.

Параметрлер native **Alert settings** disclosure ішінде ашылады және тек local browser-де сақталады. Әдепкі CVD шарты: absolute delta 70%, notional 50 000 және кемінде 20 print; large print threshold — 100 000. Threshold-тарды өзгертуге болады, бірақ олар қауіпсіз диапазонмен clamp жасалады. Sound әдепкіде off. Desktop notification тек explicit browser permission-нан кейін қосылады; бір update ең көбі үш notification жібереді.

Flow alert trading journal-ға жазылмайды, Telegram-ға жіберілмейді және order ашпайды. Symbol ауысса, layer өшсе немесе stream reconnect болса, observation window мен feed тазаланады. Бұл automatic trading decision емес, live-only көмекші analytics.
- **Қосу** мәзірі кірістірілген және пайдаланушы индикаторларын басқарады.
- **Салыстыру** үш символға дейін қосады.
- `Ctrl+K` (`⌘K`) command palette ашады; `Enter` орындайды, `Esc` жабады.

## Терминал орналасуы

- Орналасу мәзірі бір графикті, тік/көлденең бөлуді және 2×2 торын таңдайды.
- Қосымша графиктерде symbol, timeframe және crosshair негізгі графикпен бөлек байланысады.
- Бүйір панель өлшемін тінтуірмен немесе пернетақта жебелерімен өзгертуге, панельдерді орын алмастыруға болады.
- Индикаторды баға панеліне не жеке pane-ге орналастырып, шкаласын солға, оңға немесе hidden күйіне ауыстыруға болады.
- Drawing object tree көрінуді, lock күйін, жоюды, style template-терді, undo және redo әрекеттерін басқарады.

Workspace өзгергеннен кейін автоматты version жасайды. Бұрынғы revision-ға rollback жасауға болады. Экспортталған `.saltanat-workspace.json` SHA-256 checksum арқылы тексеріледі; өзгертілген файл импортталмайды.

`Ctrl+/` немесе **Пернетақта тіркесімдері** батырмасы command binding редакторын ашады. Қайшылықты тіркесім сақталмайды.

Оң жақ data-status панелі 24 сағаттық диапазонды, ағымдағы бағаның ондағы орнын, provider, market type, latency, candle gap және live/fallback режимін көрсетеді. Watchlist бір агрегатталған WebSocket пайдаланады және байланыс үзілсе REST polling-ке өтеді.

## Қолжетімді график деректері

Canvas жылдам визуализация үшін қолданылады, бірақ негізгі деректер кәдімгі HTML кестелерінде де бар.

1. `Tab` арқылы **График деректері** батырмасына өтіңіз.
2. `Enter` немесе `Space` басыңыз.
3. Таңдалған/соңғы OHLC candle, соңғы 20 candle, сигнал және орындалған trade кестелері ашылады.
4. Панельді сол батырмамен жабыңыз.

Түске ғана тәуелді ақпарат жоқ: күйлер мәтінмен белгіленеді, focus анық көрінеді. Синтетикалық не
fallback candles интерфейсті тексеруге жарайды, бірақ стратегия табыстылығын дәлелдемейді.

Техникалық канондық сипаттама: [chart архитектурасы](../../frontend/src/chart/README.md).
