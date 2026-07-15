# Таксономия арбитражных «вилок»

Статус: русская пользовательская версия канонического словаря, проверена 2026-07-14. Точные wire
ID и инженерные требования определяет [английский источник](../ARBITRAGE_TAXONOMY.md).

Слово «вилка» не означает гарантированную прибыль. В SaltanatbotV2 сохраняются канонический тип,
порядок ног, биржа, точный instrument ID, сторона, единицы, расчётный актив и качество данных.

## Двойная, тройная и внутрибиржевая вилка

| Разговорное название | Канонический смысл | Пример | Главный риск |
| --- | --- | --- | --- |
| двойная вилка | pairwise-маршрут из двух ног | купить spot на A, продать spot/perpetual на B | inventory, collateral, transfer, legging |
| тройная вилка | triangular cycle из трёх конверсий | `USDT → BTC → ETH → USDT` на одной бирже | глубина, комиссия после каждой ноги, округление, partial fill |
| внутрибиржевая | любые ноги на одной бирже | spot-perpetual, calendar, native spread или triangle | это не атомарно, если биржа не дала единый spread-инструмент |
| межбиржевая | маршрут через две и более биржи | spot-spot, perpetual-perpetual | разные часы, custody, settlement и rebalance |
| многоногая | цикл из 4–8 конверсий | `USDT → BTC → ETH → SOL → USDT` | сумма комиссий, комбинаторика и восстановление после partial fill |

## Основные семейства

- `cross-venue-spot-perpetual` и `same-venue-spot-perpetual`: projected basis; будущие funding и
  exit basis неизвестны.
- `cross-venue-spot-spot`: нужны заранее размещённые quote/base balances и проверенная стоимость
  rebalance; перевод обычно не является атомарной третьей ногой входа.
- `reverse-cash-and-carry`: short borrowed spot + long derivative; требуется свежая доступность,
  APR, margin и модель recall.
- `perpetual-perpetual`: две perpetual-позиции; нужны обе funding curves, collateral и exit basis.
- `spot-dated-future`, `calendar-spread`, `perpetual-future`: обязательны expiry, multiplier,
  settlement/delivery и roll assumptions.
- `triangular`: три направленные сделки на одной бирже с общей сохраняемой стартовой суммой.
- `n-leg`: четыре–восемь ног с точным учётом fee asset, lot/minimum и residual dust.
- native spread: биржа публикует комбинацию как отдельный инструмент; атомарность всё равно должна
  быть доказана правилами этого инструмента.
- options parity: put-call parity, conversion/reversal, box и synthetic forward по точным
  strike/expiry/settlement и явным assumptions.

Три ребра могут проходить через несколько бирж, но такой маршрут должен называться
**multi-venue cycle**, а не смешиваться с текущим внутрибиржевым triangle. На каждой бирже заранее
нужны входной inventory и collateral, каждой ноге — отдельные clock/generation доказательства, а
переводы относятся к последующему rebalance, а не к атомарному входу. Автоматического
межбиржевого triangular discovery пока нет.

## Что уже есть в продукте

Basis Binance/Bybit, REST top-book triangle, Bybit native spread, options-parity scenario lab,
operator-allowlisted continuous route identities, bounded pairwise/N-leg HTTP+SDK и paper-only
multi-leg recovery journal. Research-кандидат остаётся `executable:false`; наличие зелёной строки,
paper journal или lifecycle `confirmed` не выдаёт права на приватный ордер.

## Что обязана показывать строка

Outcome (`locked before operational risks`, `projected` или `statistical`), ordered legs, bid/ask
side, requested/executable quantity, depth и timestamps, gross/cost/net, funding/borrow/transfer,
capital/margin, residuals, freshness/skew и причины fail-closed. Тикер `BTCUSDT` сам по себе не
является безопасной economic identity.

См. также [математику](../ARBITRAGE_MATH_AND_ASSUMPTIONS.md),
[качество данных](../MARKET_DATA_QUALITY.md) и [возможности бирж](../VENUE_CAPABILITIES.md).
