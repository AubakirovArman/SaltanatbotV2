# Paper және live trading

SaltanatbotV2 сақталған стратегияларды paper режимінде немесе Binance/Bybit арқылы іске қосады.
Backtest пен paper болашақ нәтижеге кепілдік бермейді; live нақты қаражатты қолданады.

## Paper бот

1. Strategy Studio-да стратегияны сақтап, тексеріңіз.
2. **Жаңа бот** ішінен стратегия, symbol және timeframe таңдаңыз.
3. **Paper (simulation)** режимін, position size және leverage орнатыңыз.
4. Ботты жасап, іске қосыңыз; orders, fills және logs журналдарын бақылаңыз.

## Live қауіпсіздігі

- Қаражат шығаруға рұқсаты жоқ бөлек API кілтін пайдаланыңыз және IP allowlist орнатыңыз.
- Алдымен testnet және paper режимінде тексеріңіз.
- Live әдепкіде өшірулі және global arm мен per-bot confirmation қажет етеді.
- **Emergency stop** барлық ботты тоқтатып, live-ті қарусыздандырады; биржа аккаунтын да тексеріңіз.

## Bybit UTA: BTC-ні фьючерске кепіл ету

Сауда баптауларындағы **Bybit UTA кепілі мен қарызы** экраны IMR/MMR, қолжетімді маржа, кепіл құны, қарыз, пайыз, айнымалы мөлшерлеме және әр монетаның қарыз лимитін көрсетеді.

- Bybit futures ботында **Bybit UTA ортақ кепілін пайдалану** параметрін қосыңыз. Іске қосу кезінде сервер Unified Trading Account, балансы бар қосылған кепіл және тәуекел шектерін тексереді.
- Қолмен қарыз алу тек әкімшіге, live сауда қосулы кезде және анық растаудан кейін қолжетімді. Стратегия өздігінен қарыз ала алмайды.
- Әдепкі өтеу тек қарыз монетасының балансын пайдаланады және BTC-ні сатпайды. Кепілді айырбастау бөлек екінші растауды талап етеді.
- MMR 50%-дан асса, қарыз лимиті 80%-дан асса, isolated margin қолданылса немесе Bybit collateral шектеуі болса, жаңа қарыз бұғатталады.
- Public HTTP бетінде өзгертетін операциялар өшірілген. Нақты кілттер мен қарызды пайдаланбас бұрын HTTPS орнатыңыз.

## Ордер күйі және қалпына келтіру

Order intent желі сұрауына дейін durable журналға жазылады. Белгісіз желі нәтижесі `unknown` болып,
соқыр түрде қайта жіберілмейді. Private streams және REST polling `accepted`, `partially_filled` және
terminal күйлерін жаңартады. Restart кезінде барлық in-flight order биржамен салыстырылады; қорғаныс
не outcome дәлелденбесе, бот pause жасап, operator action сұрайды.

Trading schema v2 orders, events, confirmed fills, соңғы position snapshot және logical strategy
runs деректерін сақтайды. Protected entry lifecycle `entry_submitted` күйінен `open_protected` немесе
`open_unprotected/error` күйіне дейін жазылады. Binance entry/SL/TP IDs береді; Bybit entry ID мен
position-level `trading-stop` acknowledgement сақтайды.

## Live spot inventory

Live spot үшін `ENABLE_LIVE_SPOT` анық қосылуы керек. Confirmed fills әр боттың attributed quantity,
weighted average және fee assets күйін жасайды. 100% close account-тағы басқа монеталарды емес, тек
осы боттың көлемін сатады. Restart-тан кейін exchange balance қолмен тексерілгенше бот pause күйінде қалады.

## Rate limit және server уақыты

Signed requests әр exchange үшін ортақ circuit breaker қолданады. HTTP `429` немесе Binance `418`
жаңа signed requests-ті `Retry-After` мерзіміне тоқтатады; mutating request автоматты қайталанбайды.
Binance `-1021` және Bybit `10002` host clock-skew қатесі ретінде көрсетіледі. Live execution-ды
тоқтатып, operating-system уақытын NTP/chrony арқылы синхрондаңыз.

Antares командалары мен параметрлері аударылмайды. Live алдында **Test** режимін қолданыңыз.

Канондық техникалық құжаттар: [Trading](../TRADING.md) және [Configuration](../CONFIGURATION.md).
