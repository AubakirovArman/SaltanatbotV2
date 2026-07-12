# График және кестелік деректер

## Нарық пен интервалды таңдау

Жоғарғы панельден құралды, timeframe-ді және график түрін таңдаңыз. Криптовалюта үшін Binance
немесе Bybit дереккөзін бөлек таңдауға болады. Индикаторлар, салыстырылатын құралдар, сызбалар және
белсенді стратегия бір уақыт диапазонында көрсетіледі.

Қарапайым және іші бос candle, Heikin Ashi, bar, line, step line, area, baseline, Renko, **Three Line Break** және **Kagi** түрлері бар. Іші бос candle өскен денені боямайды, ал step line келесі өзгеріске дейін алдыңғы бағаны ұстайды.

### Three Line Break

Бұл price-based chart бастапқы candle-дардың тек close мәндерін пайдаланады және жаңа расталған қозғалыс жоқ аралықтарды қысады. Ағымдағы бағыт жаңа close-extreme арқылы жалғасады; reversal соңғы N confirmed line-ның толық range-і қатаң бұзылғанда ғана пайда болады. Әдепкі `N = 3`, compact chart settings ішінде `1–10` қолжетімді. Source High/Low есепке кірмейді, ал жабылмаған live candle projection жасамайды және repaint тудырмайды.

Әр line бастапқы candle timestamp-ын сақтайды, ал арада өткізіліп кеткен volume қосылады. Сондықтан crosshair, drawing және time-stamped signal нақты дерекке байланып қалады, бірақ chart column-дары бірдей аралықпен орналасады. Built-in indicator-лар transformed line-break OHLC/volume бойынша есептеледі; Strategy Lab пен backtest бастапқы time candle-дарды қолданады. Бұл екі түрлі data representation, сондықтан нәтижені transformation-ды ескермей тікелей салыстыруға болмайды. Ережелер [TradingView](https://www.tradingview.com/support/solutions/43000502273-introduction-to-line-break-charts/) және [Sierra Chart](https://www.sierrachart.com/index.php?ID=131&page=doc%2FStudiesReference.php) құжаттарымен тексерілді.

### Тұрақты Renko

Renko тек confirmed source candle close мәндерін қолданады. Brick size бірінші loaded confirmed price-тың үлесі ретінде бір рет алынып, instrument-тің minimum tick-іне дөңгелектенеді. Әдепкі `0,05%`, setting range — `0,01–10%`. Continuation бір brick қозғалысын, direction reversal екі brick қозғалысын талап етеді: price соңғы brick open-ына қайтып, тағы бір толық size өтуі керек. Бір source candle бірнеше бірдей honest timestamp-ы бар brick жасай алады; оның volume-ы duplicate болмай, brick-терге бөлінеді.

Wick жаңа не reversal brick жасауға жетпеген нақты аралық close-extreme-ды ғана көрсетеді; close-only mode бастапқы High/Low-ды алмастырмайды. Жабылмаған candle және projection brick есепке кірмейді. Жаңа live candle ескі brick size-ын өзгертпейді. Егер user бұрынғы history-ді әдейі жүктесе, бірінші source price өзгереді де full Renko жаңа history boundary-ден дұрыс reseed жасай алады.

Renko price синтетикалық және нақты бір уақытта орындалатын market price емес. Chart-тағы built-in indicator Renko OHLC/volume қолданады, ал Strategy Lab пен backtest бастапқы time candle бойынша орындалады. Renko көрінісін execution price дәлелі деп қабылдамаңыз. Ресми [TradingView calculation](https://www.tradingview.com/support/solutions/43000502284-understanding-renko-charts/) және [two-brick reversal/wick](https://www.tradingview.com/support/solutions/43000481040-what-do-renko-wicks-mean/) түсіндірмелері.

### Расталған Kagi

Kagi уақытты қысып, маңызды price movement-ті ғана көрсетеді. Бірінші confirmed price instrument minimum tick-іне дөңгелектелген тұрақты percentage reversal threshold береді. Әдепкі `0,10%`, setting range — `0,01–10%`. Жаңа close-extreme ағымдағы vertical line-ды ұзартады, threshold-тан кіші қарсы қозғалыс filter жасалады. Толық reversal-дан кейін horizontal shoulder немесе waist және қарама-қарсы жаңа vertical line пайда болады. Өсу жасыл, төмендеу қызыл, confirmed endpoint шеңбермен белгіленеді.

Есеп тек жабылған source candle close мәндерін қолданады. Жабылмаған live tail, projection және source High/Low есепке кірмейді. Өткізілген candle мен volume бір leg ішінде duplicate болмай агрегатталады. Canvas, crosshair, drawing, built-in indicator, market structure және accessible OHLC table бір transformed series қолданады.

Kagi — synthetic representation: column аралығы бірдей уақытты білдірмейді, leg OHLC орындалатын market price-ты дәлелдемейді. Strategy Lab пен backtest source time candle-дармен қалады. Ереже мен терминология ресми [TradingView Kagi](https://www.tradingview.com/support/solutions/43000502272-learn-to-use-kagi-charts/) сипаттамасымен салыстырылды; осы кезеңде configurable fixed Percentage бар, ATR/Traditional әлі жоқ.

### Point & Figure

Point & Figure alternating column құрады: `X` өсу, `O` төмендеу. Бір column ішінде екі symbol араласпайды. Default box size — бірінші loaded confirmed price-тың tick-ке дөңгелектелген тұрақты `0,10%` мәні. Continuation ағымдағы column-ға box қосады; opposite column тек configured reversal box санына қозғалғанда пайда болады, default `3`.

Екі setting те өзгертіледі: box percentage `0,01–10%`, reversal `1–10` box. Есеп тек closed source candle close қолданады, skipped volume-ды duplicate жасамай жинайды және unclosed live tail/projection column-ды қоспайды. Fixed seed historical box-тарды қайта өзгертетін Percentage LTP repainting-ін әдейі қайталамайды. X/O alternation және multi-box reversal ережелері [TradingView Point & Figure](https://www.tradingview.com/support/solutions/43000502276-what-are-point-and-figure-charts/) құжатымен тексерілді.

P&F column synthetic: equal spacing equal time емес, column OHLC execution price дәлелі емес. Chart indicator/structure transformed column қолданады; Strategy Lab/backtest source time candle-дарда қалады.

Ағымдағы мәні бар (`RENKO …%`, `KAGI …%`, `NLB` немесе `P&F …% ×N`) button explicitly labelled numeric field пен help ашады. Өзгеріс бүкіл loaded display history-ді қайта құрып, legend, accessible description, indicator, structure және OHLC table-ды бірге жаңартады. Мән тек current browser-де сақталады; reset active chart type defaults-ын қайтарады. Strategy Lab/backtest source candle-дары өзгермейді.

Heikin Ashi де visible window кесілгенге дейін бүкіл loaded history бойынша есептеледі: zoom немесе pan бір candle-дың seed/OHLC мәнін енді өзгертпейді.

## Басқару

- Тінтуір дөңгелегі курсор тұрған candle маңында масштабтайды.
- Retina/HiDPI экрандарда барлық Canvas layer-дің ішкі resolution-ы автоматты түрде өседі, ал mouse, trackpad, crosshair, HUD және axis тұрақты CSS coordinate қолданады. Сондықтан display density zoom/pan жылдамдығын өзгертпейді және candle-ды бұлдырлатпайды.
- Mac trackpad-та vertical two-finger gesture chart-ты бірқалыпты zoom жасайды, horizontal gesture history-ді pan жасайды. System pinch chart ішінде қалады және бүкіл page-ті масштабтамайды; ұсақ inertia tail есепке алынбайды.
- Негізгі (сол) mouse button-мен сүйреу time range-ті жылжытады; `grab` / `grabbing` cursor режимді көрсетеді, double-click бастапқы масштабты қайтарады.
- Төменгі percentage indicator ағымдағы zoom-ды көрсетеді және бір click арқылы `100%` пен latest price-қа қайтарады.
- `LIN` / `LOG` / `%` баға шкаласын ауыстырады.
- Оң жақ price axis үстінде wheel/trackpad не vertical drag тек баға диапазонын 25%–400% өзгертеді; time zoom, offset және linked pane қозғалмайды. Axis keyboard slider ретінде де жұмыс істейді: `↑`/`↓` шағын, `Page Up`/`Page Down` үлкен қадам жасайды, `Home` не double-click `AUTO` күйін қайтарады. Төменгі mode button `AUTO` не ағымдағы пайызды көрсетеді; `LOG` режимінде масштаб logarithmic space ішінде есептеледі.
- Соңғы баға белгісі ағымдағы candle жабылғанға дейінгі уақытты көрсетеді; курсор жанындағы HUD уақыт, OHLC, өзгеріс және volume мәндерін ашады.
- `Shift` ұстап, негізгі mouse button-мен сүйресеңіз, баға/пайыз өзгерісі, candle аралығы және нақты уақыт уақытша өлшенеді. Мәндер сүйреу кезінде жаңарады, нәтиже button босатылғаннан кейін қалады және `Esc` не келесі қалыпты drag кезінде өшеді. Жылдам сызғыш сақталмайды және undo history-ге кірмейді; тұрақты нұсқа сол жақтағы **Measure** drawing құралы арқылы жасалады.
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

## Session liquidity map

`1m`–`4h` intraday interval-дарында **SESSION MAP · UTC** әдепкіде қосулы. Ол ағымдағы UTC күнінің open/high/low мәндерін, VWAP және ±1σ жолақтарын, сондай-ақ PDH/PDL деңгейлерін көрсетеді. Алдыңғы күн деңгейлері таңдалған Binance/Bybit-тің бөлек daily candle-дарынан алынады, сондықтан толық емес көрінетін intraday history толық күн деп есептелмейді.

VWAP әр OHLCV candle-дың жалпы volume-ымен өлшенген `(high + low + close) / 3` typical price арқылы есептеледі. Бұл deterministic **bar-based estimate**, tick-VWAP емес: candle ішіндегі volume таралуы ойдан жасалмайды. Volume нөл болса, VWAP және band көрсетілмейді.

`PDH SWEEP` жабылған candle previous-day high-тан wick жасап, төменде жабылғанда; `PDL SWEEP` previous-day low-дан төмен түсіп, қайта жоғарыда жабылғанда пайда болады. Ағымдағы жабылмаған candle confirmed marker жасамайды. Sweep — context, жеке entry signal емес.

## Расталған market structure

Chart үстіндегі карточкадағы `STRUCT` батырмасы расталған `HH`, `LH`, `HL`, `LL` swing-нүктелерін және `BOS` / `CHOCH` сызықтарын қосады. `S3` fractal күшін 2-ден 5-ке дейін өзгертеді: сан жоғары болса noise азаяды, бірақ confirmation кешірек келеді. Бұл layer intraday session-дар өшірілген үлкен timeframe-дерде де жұмыс істейді.

Алгоритм confirmation-нан кейін future data қолданбайды: swing оң жағындағы таңдалған candle саны жабылған соң ғана пайда болады, ал BOS/CHOCH соңғы расталған high/low деңгейінен candle close өткенде ғана жасалады. Wick-пен бір рет тесу break емес. `BOS` ағымдағы бағытты жалғастырады, `CHOCH` қарама-қарсы бағыттағы алғашқы расталған break-ті белгілейді.

`FVG` батырмасы үш жабық candle бойынша optional fair value gap zone-дарын көрсетеді. Bullish zone үшін үшінші candle low-ы бірінші candle high-ынан жоғары; bearish zone үшін үшінші candle high-ы бірінші candle low-ынан төмен болуы керек. Кейінгі wick zone-ды толық толтырғанда ғана ол mitigated деп есептеледі. Ағымдағы жабылмаған candle structure жасамайды және FVG жаппайды.

Бұл белгілер displayed OHLC bar-лардың механикалық контексті, кепілденген trading signal емес. Қарапайым candle үшін source bars, ал Heikin Ashi, Renko, Three Line Break, Kagi және Point & Figure үшін таңдалған transformed representation қолданылады. Нәтиже chart type, timeframe, swing strength және қолжетімді history-ге тәуелді; trade алдында risk, liquidity және басқа деректермен бірге тексеріңіз.

## Anchored VWAP

Сол жақ rail-дегі **Anchored VWAP** құралы candle үстінен бір click арқылы жасалады. Таңдалған уақыттан соңғы loaded candle-ға дейін cumulative VWAP, translucent ±1σ value area және ±1σ/±2σ сызықтары салынады. Anchor кәдімгі drawing object болғандықтан оны move, hide, lock, duplicate, style, undo жасауға және ағымдағы symbol drawings-імен бірге сақтауға болады.

Есептеу OHLCV volume-мен өлшенген `(high + low + close) / 3` typical price қолданады. Бұл tick-VWAP емес, bar-based AVWAP; timeframe ауысқанда жаңа interval candle-дары бойынша қайта есептеледі. Reload-тан кейін сақталған anchor loaded history-ден ескі болса, есеп бірінші қолжетімді candle-дан жалған басталмайды: бастапқы range жүктелгенше DOM legend `—` көрсетеді. Legend anchor уақытын, ағымдағы AVWAP және σ мәнін Canvas-тан бөлек береді.

## Asia, London және New York сессиялары

**SESSION UTC** карточкасының төменгі қатарындағы `ASIA`, `LON` және `NY` батырмалары бір-бірінен тәуелсіз. `1m`–`1h` chart-та олар regional window-дың translucent high/low box-ын көрсетеді. Ағымдағы range solid әрі айқынырақ border, жабылған range әлсіз dashed border қолданады. Соңғы high/low және active/closed күйі Canvas-тан бөлек semantic DOM мәтінінде де бар.

- Asia: `Asia/Tokyo` уақытымен `09:00–18:00`.
- London: `Europe/London` уақытымен `08:00–17:00`.
- New York: `America/New_York` уақытымен `09:30–16:00`.

IANA time zone London/New York DST ауысуын автоматты есептейді; candle session-ға open time бойынша кіреді. `2h` және одан үлкен timeframe-де `09:30` шекарасы дәл болмайтындықтан батырмалар disabled.

Бұл official exchange holiday calendar емес: мереке және shortened trading day есептелмейді. 24/7 crypto үшін box Binance/Bybit open/close-ын емес, regional activity window-ды көрсетеді және жеке trading signal болып саналмайды.
- **Қосу** мәзірі кірістірілген және пайдаланушы индикаторларын басқарады.
- **Салыстыру** үш символға дейін қосады.
- `Ctrl+K` (`⌘K`) command palette ашады; `Enter` орындайды, `Esc` жабады.

## Терминал орналасуы

- Орналасу мәзірі бір графикті, тік/көлденең бөлуді және 2×2 торын таңдайды.
- 2×2 торында `2`, `3`, `4` pane-дері chart үстінде жеке symbol, timeframe және chart type select көрсетеді. Басқа pair не interval таңдау сол field-ті автоматты unlink жасайды және primary chart өзгермейді.
- Негізгі indicator және compare editor grid clutter болмауы үшін бір рет көрсетіледі. Secondary pane default бойынша primary indicator set-пен linked. Secondary chart-ты maximize жасап indicator өзгертсеңіз, оның bounded set-і автоматты independent болады; chain батырмасы synchronization-ды қайтарады. Pine/Blockly logic canonical болып қалады және көшірілмейді. `UTC · STRUCT` карточкасы default collapsed: ашу үшін click не focus + `Enter` қолданыңыз.
- Compare overlays те default бойынша primary chart-пен linked. Maximized secondary pane-де үш compare-ға дейін add/configure/remove жасауға болады; бірінші өзгерістен кейін set independent болып, session/workspace/export ішінде сақталады. Relink canonical primary set-ті қайтарады. Linked pane primary series-ті қайта пайдаланып, duplicate refresh request ашпайды.
- Drawing әрқашан нақты pane және symbol-ға тиесілі: екі терезеде бір pair ашылса да, line, level және Anchored VWAP жиындары бөлек болады. Олар reload-тан кейін қалпына келеді, бірақ автоматты copy/link жасалмайды. Ескі symbol-only drawing бір рет primary chart-қа көшіріледі; corrupt не шамадан тыс үлкен payload қауіпсіз түрде еленбейді.
- Pane ішінде click не focus оны active етеді. Diagonal-arrow батырмасы chart-ты symbol, zoom, pan және WebSocket state жоғалтпай бүкіл орталық area-ға ашады; `Esc` grid-ті қайтарады. Default `Alt+Enter` active pane-ді ауыстырады және **Keyboard shortcuts** терезесінде өзгертіледі. Maximized secondary pane full drawing rail мен indicator editor-ды қайта көрсетеді.
- Active pane тек color арқылы емес, contrast double border және нөмірленген **Active chart** badge арқылы көрсетіледі. `Alt+J` focus-ты келесі chart-қа, `Alt+K` алдыңғы chart-қа циклмен ауыстырады; binding **Keyboard shortcuts** ішінде өзгертіледі. Maximized mode-де олар full-screen chart-тарды zoom, pan және stream state жоғалтпай парақтайды. Input және modal ашық кезде navigation іске қосылмайды.
- Жоғарғы панельдегі symbol, timeframe және chart type, command palette және сандық timeframe shortcut-тары active pane-ге қолданылады. Secondary chart symbol немесе timeframe қолмен өзгертілсе, primary chart өзгермей, тек сол field link-тен ажырайды; chain батырмасы synchronization-ды қайта қосады.
- Market list, connection state және quote, OHLC, data quality мен alert көрсететін оң жақ panel де active chart-пен бірге ауысады. Олар selected pane-нің ашық stream snapshot-ын пайдаланады және қосымша WebSocket connection жасамайды.
- Exchange, symbol және timeframe бірдей pane-дер бір physical browser WebSocket connection-ды ортақ пайдаланады. Field өзгерсе жеке market key ашылады; соңғы consumer кеткенде connection жабылады.
- Соңғы layout, pair, timeframe, chart type және link setting reload-тан кейін named workspace жасамай-ақ автоматты қалпына келеді. Уақытша focus/maximize сақталмайды, сондықтан app толық grid-ке оралады. Corrupt, oversized немесе future-version state қауіпсіз түрде еленбейді.
- Chain батырмалары symbol, timeframe, crosshair және visible time range-ті primary chart-пен бөлек байланыстырады. Linked zoom/pan absolute UTC boundary жібереді, сондықтан әртүрлі timeframe candle index бойынша drift жасамайды; loaded history-ден тыс range chart-ты секіртпейді.
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
