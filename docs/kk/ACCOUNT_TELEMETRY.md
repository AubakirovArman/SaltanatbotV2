# Аккаунт экономикасының телеметриясы

Мәртебе: Binance және Bybit үшін қорғалған read-only P0 API іске асырылды. Бұл зерттеу мен operator
үшін evidence көзі; саудаға рұқсат немесе mainnet-ready мәлімдемесі емес.

## Қолжетімділік

`GET /api/trade/account-telemetry` бұрыннан бар trading session ішінде орналасқан және `admin` рөлін
талап етеді. Кілттер тек сервердің шифрланған settings қоймасынан алынады. Request арқылы кілт беру
мүмкін емес, response ішінде кілт, signature немесе secret болмайды. Exchange сұраулары тек GET,
сондықтан оқу үшін live trading-ті arm ету қажет емес.

Параметрлер қатаң шектелген: `venues` — Binance/Bybit (ең көбі 2), `symbols` — 1–2 symbol,
`assets` — 1–4 asset, `stableAssets` — USDT-ден басқа 1–3 asset. Әдепкі мәндер:
`BTCUSDT,ETHUSDT`, `BTC,USDT,USDC` және `USDC`.

## Қандай evidence қайтарылады

- Binance: signed Spot commission компоненттері, USDⓈ-M ағымдағы rate және tier, BNB fee-burn күйі,
  cross-margin available borrow және келесі hourly rate, сондай-ақ deposit/withdraw network күйі мен
  fee мәндері.
- Bybit: signed Spot/Linear fee rate, UTA `availableToBorrow` және hourly rate, chain бойынша
  deposit/withdraw күйі мен fee.
- Stablecoin FX: Binance және Bybit bid/ask. Binance REST `bookTicker` venue timestamp бермейді,
  сондықтан receive-time дерегі provenance ретінде көрінеді, бірақ жалғыз өзі economics readiness
  талабын орындамайды. Bybit envelope уақыты қолданылады.

Әр evidence ішінде `source`, `version`, `asOf`, `validUntil`, `timestampQuality` және `fresh` бар;
жарамдылық мерзімі — 30 секунд. Ескі немесе қате жауап соңғы сәтті snapshot-пен алмастырылмайды.

## Интерфейс

Administrator **Сауда → Баптаулар → Ағымдағы аккаунт экономикасы** арқылы сол bounded snapshot-ты
қолмен жаңарта алады. EN/RU/KK панелі browser шекарасында contract-ты қайта тексеріп, қауіпті
readiness flag, crossed FX book, белгісіз version және шектен үлкен array-ді қабылдамайды. Fee,
borrow, network және FX semantic table ретінде көрсетіледі. Snapshot browser storage-да сақталмайды,
order action жоқ, admin емес session үшін панель көрсетілмейді.

## Неліктен `executable=false`

- Болашақ commission asset нақты execution-ға тәуелді. BNB тек шартты discount asset ретінде
  көрсетіледі; соңғы asset-ті authenticated fill дәлелдейді.
- Exchange API ағымдағы borrow capacity және rate береді, бірақ loan қайтарып шақырылмайтынын
  дәлелдемейді. Сондықтан `recallStatus=unknown`, non-recallable borrow талап ететін route жабық.
- Network тек fresh evidence, қосулы deposit+withdraw және белгілі fee болғанда usable. Екі venue-дағы
  network identity бөлек сәйкестендірілуі керек.
- Бұл API sequence-verified order book, capital reservation, transfer arrival proof және нақты fill
  accounting орнына жүрмейді.

I/O шектеулі: әр private venue үшін бір refresh, бір мезетте ең көбі үш ішкі request, fetch timeout —
5 секунд, толық refresh — 20 секунд және response size cap бар. Үш толық сәтсіздіктен кейін circuit
30 секундқа ашылады. Толық емес нәтиже `partial` мәртебесімен және `issues` тізімімен қайтады.

Official endpoint сілтемелері мен дәл field сипаттамалары: [ағылшын канондық нұсқасы](../ACCOUNT_TELEMETRY.md).
