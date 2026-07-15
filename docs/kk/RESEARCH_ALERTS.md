# Account-aware зерттеу арбитражы ескертулері

Күйі: тестіленген policy/outbox runtime application composition root-қа `paper-trade` қорғалған
boundary арқылы қосылған және server lifecycle-мен бірге іске қосылып/тоқтайды. Қорғалған EN/RU/KK
operator UI `paper-trade`, `live-trade` және `admin` role-дары үшін policy мен delivery/retry
evidence-ті басқарады. Engine-owned candidate/economics producers әлі қосылмаған, сондықтан mount
пен UI өздігінен notification жасамайды.

## Қауіпсіздік және evidence

Бұл контур тек notification үшін. Барлық нәтиже мен outbox intent ішінде `researchOnly: true` және
`executionPermission: false` бекітілген; модуль exchange credential немесе order adapter
импорттамайды.

Сигнал мына талаптардың барлығы орындалғанда ғана өтеді:

1. Source/version және жарамдылық аралығы бар current reviewed `economicAssetId`.
2. Venue/instrument/market type/side реті `RouteEconomicsRequest` legs-пен дәл сәйкес; display
   ticker identity дәлелі емес.
3. Route lifecycle дәл сәйкес, `confirmed`, complete және policy талабына сай fresh/verified.
4. Backend `route-economics-v1` моделін fee, funding, borrow, transfer, margin, capital және
   stablecoin/FX evidence-пен қайта есептейді. Missing немесе stale evidence fail-closed болады.
5. Capital shortfall жоқ, required capital conservative бағаланған және capacity, net profit,
   net edge, maximum risk capital шектері орындалады.

Нормаланған taxonomy basis, алты pairwise family, triangular, native-spread, options parity, N-leg
және болашақ CEX-DEX түрлерін қамтиды. Schema-дағы family автоматты live adapter бар дегенді
білдірмейді.

## Dedup және durable outbox

Dedup key family атауын және display symbol-ды қоспайды. Ол canonical `economicAssetId` пен нақты
бағытталған venue/instrument/market/side legs жиынынан құрылады. Осылай бір economic route екі
engine-де табылса, бір deterministic winner қалады; әртүрлі route біріктірілмейді.

Бірінші snapshot policy-ді startup spam-сыз іске дайындайды. Notification тек
`ineligible → eligible` ауысуында және cooldown өткенде жасалады. Route absence тек complete universe
дәлелімен есептеледі; snapshot equivocation қабылданбайды. Бөлек bounded persistent outbox
`queued/sending/retrying/delivered/failed/cancelled`, lease, exponential retry және restart recovery
қолдайды.

## Қалған интеграция

- Барлық engine үшін server-owned adapter жасау; browser payload trusted account evidence болмауы
  керек, сондықтан router-де snapshot ingest үшін HTTP endpoint әдейі жоқ.
- Protected account telemetry-ді point-in-time economics builder және provenance history-мен қосу.
- Policy/delivery UI-ды тек protected session ішінде ұстау; account evidence үшін public SDK қажет
  емес.

Live order readiness немесе funded testnet/mainnet soak туралы мәлімдеме жасалмайды.
