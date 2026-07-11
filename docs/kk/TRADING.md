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

## Ордер күйі және қалпына келтіру

Order intent желі сұрауына дейін durable журналға жазылады. Белгісіз желі нәтижесі `unknown` болып,
соқыр түрде қайта жіберілмейді. Private streams және REST polling `accepted`, `partially_filled` және
terminal күйлерін жаңартады. Restart кезінде барлық in-flight order биржамен салыстырылады; қорғаныс
не outcome дәлелденбесе, бот pause жасап, operator action сұрайды.

## Rate limit және server уақыты

Signed requests әр exchange үшін ортақ circuit breaker қолданады. HTTP `429` немесе Binance `418`
жаңа signed requests-ті `Retry-After` мерзіміне тоқтатады; mutating request автоматты қайталанбайды.
Binance `-1021` және Bybit `10002` host clock-skew қатесі ретінде көрсетіледі. Live execution-ды
тоқтатып, operating-system уақытын NTP/chrony арқылы синхрондаңыз.

Antares командалары мен параметрлері аударылмайды. Live алдында **Test** режимін қолданыңыз.

Канондық техникалық құжаттар: [Trading](../TRADING.md) және [Configuration](../CONFIGURATION.md).
