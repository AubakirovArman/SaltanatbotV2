# Арбитраж «вилкасының» таксономиясы

Мәртебе: канондық сөздіктің қазақша user нұсқасы, 2026-07-14 күні тексерілді. Нақты wire ID және
engineering талабы [ағылшын канонында](../ARBITRAGE_TAXONOMY.md) анықталады.

«Вилка» сөзі кепілді пайда дегенді білдірмейді. SaltanatbotV2 canonical family, ordered legs,
venue, exact instrument ID, side, unit, settlement asset және data-quality күйін сақтайды.

## Қос, үштік және бірбиржалық вилка

| Бейресми атау | Канондық мағына | Мысал | Негізгі жасырын тәуекел |
| --- | --- | --- | --- |
| қос вилка | екі leg pairwise route | A venue-да spot алу, B-де spot/perpetual сату | inventory, collateral, transfer, legging |
| үштік вилка | үш conversion triangular cycle | `USDT → BTC → ETH → USDT` бір venue-да | depth, әр leg fee, rounding, partial fill |
| бірбиржалық | барлық leg бір venue-да | spot-perpetual, calendar, native spread немесе triangle | venue бір native instrument бермесе atomic емес |
| көпбиржалық | екі не одан көп venue | spot-spot, perpetual-perpetual | бөлек clock, custody, settlement, rebalance |
| көпаяқты | 4–8 conversion cycle | `USDT → BTC → ETH → SOL → USDT` | fee жинақталуы, combinatorial search, recovery |

## Негізгі family-лер

- `cross-venue-spot-perpetual` / `same-venue-spot-perpetual`: projected basis; future funding және
  exit basis белгісіз.
- `cross-venue-spot-spot`: prefunded quote/base balance және тексерілген rebalance cost қажет;
  transfer әр entry-дің atomic үшінші leg-і емес.
- `reverse-cash-and-carry`: borrowed spot short + derivative long; fresh capacity, APR, margin және
  recall model қажет.
- `perpetual-perpetual`: екі funding curve, collateral және exit basis қажет.
- `spot-dated-future`, `calendar-spread`, `perpetual-future`: expiry, multiplier,
  settlement/delivery және roll assumption міндетті.
- `triangular`: бір venue-дағы conserved start quantity бар үш directional trade.
- `n-leg`: fee asset, lot/minimum және residual dust нақты есептелетін 4–8 leg.
- native spread: venue комбинацияны жеке instrument етеді; atomic semantics бәрібір дәлелденеді.
- options parity: exact strike/expiry/settlement және explicit assumption арқылы put-call parity,
  conversion/reversal, box, synthetic forward.

Үш edge бірнеше venue арқылы өте алады, бірақ мұндай бағыт current бірбиржалық triangle-мен
араласпай, **multi-venue cycle** деп аталуы тиіс. Әр venue-да input inventory мен collateral алдын
ала болуы, әр leg жеке clock/generation дәлелін беруі керек; transfer atomic entry емес, кейінгі
rebalance бөлігі. Автоматты көпбиржалық triangular discovery әзірге жоқ.

## Өнімде бар нәрсе

Binance/Bybit basis, REST top-book triangle, Bybit native spread, options-parity scenario lab,
operator-allowlisted continuous route identity, bounded pairwise/N-leg HTTP+SDK және paper-only
multi-leg recovery journal. Research candidate `executable:false` болып қалады; жасыл row, paper
journal немесе lifecycle `confirmed` private order рұқсатын бермейді.

## Әр row көрсетуге тиіс дәлел

Outcome (`locked before operational risks`, `projected`, `statistical`), ordered legs, bid/ask side,
requested/executable quantity, depth және timestamp, gross/cost/net, funding/borrow/transfer,
capital/margin, residual, freshness/skew және fail-closed себептері. `BTCUSDT` ticker-інің өзі safe
economic identity емес.

Қосымша: [математика](../ARBITRAGE_MATH_AND_ASSUMPTIONS.md),
[data quality](../MARKET_DATA_QUALITY.md), [venue capability](../VENUE_CAPABILITIES.md).
