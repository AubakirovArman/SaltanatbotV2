# Exchange execution мүмкіндіктері

Толық canonical кесте: [Exchange capability matrix](../EXCHANGE_CAPABILITIES.md).
Live trading **эксперименттік** және default бойынша сөндірілген.

`/api/venues` ішіндегі `scopes` өрістері нақты product/operation/status шекарасын береді. Жоқ
комбинация қолдау көрсетілмейді; жалпы boolean өрістері experimental/manual-only жолдар үшін әдейі
`false` болып қалады және сауда операциясына рұқсат ретінде қолданылмайды.

- Paper market/limit/conditional orders және local fills қолдайды.
- Binance USDⓈ-M және Bybit USDT linear market/limit, protective orders,
  міндетті SL/TP acknowledgement, private stream және REST polling fallback береді.
- Binance live spot authenticated spot execution accounting дайын болғанша толық өшірілген.
  Тек Bybit live spot эксперименттік түрде қолжетімді: оған анық `ENABLE_LIVE_SPOT`,
  bot-attributed inventory қажет; қорғалған strategy entry мен inverse markets қолдау көрсетпейді.
- Private execution ID, partial qty, price, нақты fee amount/asset және venue
  realized PnL сақталады; replayed ID idempotent.
- Bybit UTA cross collateral IMR/MMR, BTC кепілі, қарыз және пайызды көрсетеді. Қарыз тек қолмен растаудан кейін алынады; әдепкі өтеу кепілді айырбастамайды. Ботқа анық opt-in, UI операцияларына HTTPS қажет.
- Live bot start exchange+symbol бойынша сериалданады. Қабылданған entry-ден кейін protection
  сәтсіз болса, entry `rejected` болып өзгермейді: managed state пен reservation сақталып, bot pause
  күйіне өтеді. Бөлек reduce-only emergency close unique `…-safety` client ID және өзінің venue order
  ID мәнін не анық қатені береді. Қабылданған кәдімгі live close та authenticated execution
  accounting-ке дейін managed state-ті өшірмейді.

Live алдында withdrawal-сыз keys, IP allowlist, NTP, kill switch, CI/testnet read
smoke, backtest/paper, filters/leverage/position mode және recovery сценарийлерін
тексеріңіз. Алып тасталған 7–14 күндік testnet soak орындалмайды, сондықтан
mainnet-ready мәртебесі жарияланбайды.
