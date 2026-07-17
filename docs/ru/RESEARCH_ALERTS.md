# Account-aware уведомления об исследовательском арбитраже

Статус: runtime политик/outbox подключён за аутентифицированной границей `paper-trade` и
запускается/останавливается вместе с сервером. Защищённый интерфейс EN/RU/KK управляет политиками и
показывает delivery/retry evidence для ролей `paper-trade`, `live-trade` и `admin`. Server-owned
producers кандидатов и экономики пока не подключены, поэтому mount и UI сами по себе не могут
создать уведомление.

Production остаётся принятым R4 на PostgreSQL schema 12. Ни этот контур без
producer-ов, ни schema-13 implementation candidate R5.1 не считаются принятыми
или развёрнутыми.

## Отличие от generic price alerts R5.1

Этот документ описывает старый account-aware workflow политик и экономики
арбитража. Это не generic owner-scoped control plane R5.1; их policy state нельзя
объединять с обычным price rule только потому, что оба контура используют
notification/outbox.

Implementation candidate R5.1 поддерживает только `price-threshold` по публичным
закрытым last-price свечам Binance/Bybit и in-app delivery. Он не читает account
evidence или exchange credentials и не может торговать. Beta limits: 100 active
и 200 non-archived rules на owner, 400 total rule/history rows на owner и 480
globally active rules. Scheduler допускает четыре concurrent public reads, 16
unique reads за sweep и восемь на provider. Evaluation receipts хранятся 2 дня,
event/outbox/archive history — 30 дней.

R5.1 использует owner-bound forward event cursor и намеренную at-least-once
семантику publish-before-checkpoint. До релиза остаются browser-closed
restart/dedup, same-owner multi-tab convergence, local-storage failure и
desktop/mobile accessibility/visual gates. R5.2 technical screener, R5.3
notification worker/Telegram и integrated 100-user proof R11 остаются pending и
не доказаны.

См. [owner-scoped server alerts](../ALERTS.md),
[русскую версию](ALERTS.md) и [казахскую версию](../kk/ALERTS.md).

## Что проверяется

Контур предназначен только для уведомлений. В каждом результате и outbox intent зафиксированы
`researchOnly: true` и `executionPermission: false`; модуль не импортирует ключи бирж и order
adapter.

Сигнал проходит только при одновременном выполнении условий:

1. Есть актуальный reviewed `economicAssetId` с source/version и сроком действия.
2. Порядок venue/instrument/market type/side во всех legs точно совпадает с
   `RouteEconomicsRequest`; тикер не является доказательством идентичности.
3. Lifecycle точно относится к route, имеет `confirmed`, полное и достаточно свежее evidence.
4. Backend заново считает `route-economics-v1`: комиссии, funding, borrow, transfer, margin,
   capital, stablecoin/FX. Любой пробел или устаревшее evidence блокирует сигнал.
5. Нет дефицита капитала, весь required capital консервативно оценён, а capacity, net profit,
   net edge и максимальный risk capital проходят политику.

Поддерживаемая нормализованная taxonomy включает basis, шесть pairwise-family, triangular,
native-spread, options parity, N-leg и будущий CEX-DEX. Наличие типа в schema не означает, что у
каждого engine уже есть подключённый live lifecycle adapter.

## Dedup и outbox

Dedup-ключ не включает название family и display symbol. Он строится из канонического
`economicAssetId` и точного набора направленных legs с venue/instrument/market/side. Поэтому один
экономический маршрут из двух engine даёт один детерминированно выбранный сигнал, а реально разные
маршруты не склеиваются.

Первый snapshot только активирует policy без стартового спама. Повторный сигнал появляется при
переходе `ineligible → eligible` с cooldown. Отсутствие route учитывается только при доказанно
полном universe. Snapshot equivocation блокируется. Отдельный bounded persistent outbox поддерживает
`queued/sending/retrying/delivered/failed/cancelled`, lease, exponential retry и восстановление после
рестарта.

## Что осталось подключить

- Сделать server-owned adapters всех engine; browser payload не должен быть доверенным источником
  account evidence, поэтому router намеренно не имеет HTTP endpoint для ingest snapshot.
- Связать защищённую account telemetry с point-in-time economics builder и историей provenance.
- Сохранять интерфейс политик/delivery только внутри защищённой сессии; публичный SDK для account
  evidence не нужен.

Готовность к live orders и funded testnet/mainnet soak не заявляется.
Отсутствующие producer integrations остаются отдельной работой и не наследуют
статус generic implementation candidate R5.1.
