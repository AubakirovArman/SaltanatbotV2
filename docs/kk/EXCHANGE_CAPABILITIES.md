# Exchange execution мүмкіндіктері

Толық canonical кесте: [Exchange capability matrix](../EXCHANGE_CAPABILITIES.md).
Қазіргі `public-http-paper` `private-live`, credential use, signed requests,
private streams және live orders жолдарын қабылдамайды; `ENABLE_LIVE_SPOT=true`
startup-ты тоқтатады. Төмендегі live жолдары тек **белсенді емес
future/private-live анықтамасы**.

`/api/venues` ішіндегі `scopes` өрістері нақты product/operation/status шекарасын береді. Жоқ
комбинация қолдау көрсетілмейді; жалпы boolean өрістері experimental/manual-only жолдар үшін әдейі
`false` болып қалады және сауда операциясына рұқсат ретінде қолданылмайды.

- Paper market/limit/conditional orders және local fills қолдайды.
- Retained Binance USDⓈ-M және Bybit USDT linear коды market/limit, protective
  orders, міндетті SL/TP acknowledgement, private stream және REST polling
  fallback қамтиды, бірақ қазіргі runtime оны іске қоспайды.
- Binance live spot authenticated spot execution accounting дайын болғанша толық өшірілген.
  Retained Bybit live spot `ENABLE_LIVE_SPOT` және bot-attributed inventory
  талап етеді, бірақ бұл flag қазіргі runtime-қа қайшы болып, startup-ты
  тоқтатады; inverse markets қолдау таппайды.
- Private execution ID, partial qty, price, нақты fee amount/asset және venue
  realized PnL сақталады; replayed ID idempotent.
- Bybit UTA cross collateral IMR/MMR, BTC кепілі, қарыз және пайызды көрсетеді. Қарыз тек қолмен растаудан кейін алынады; әдепкі өтеу кепілді айырбастамайды. Ботқа анық opt-in, UI операцияларына HTTPS қажет.
- Live bot start exchange+symbol бойынша сериалданады. Қабылданған entry-ден кейін protection
  сәтсіз болса, entry `rejected` болып өзгермейді: managed state пен reservation сақталып, bot pause
  күйіне өтеді. Бөлек reduce-only emergency close unique `…-safety` client ID және өзінің venue order
  ID мәнін не анық қатені береді. Қабылданған кәдімгі live close та authenticated execution
  accounting-ке дейін managed state-ті өшірмейді.

Болашақ live release алдында бөлек HTTPS/security review, withdrawal-сыз keys,
IP allowlist, NTP, kill switch, testnet, protection және recovery gate қажет.
Бұл қазіргі release үшін operator нұсқаулығы емес.
