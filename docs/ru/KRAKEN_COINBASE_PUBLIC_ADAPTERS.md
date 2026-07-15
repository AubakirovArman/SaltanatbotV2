# Публичные адаптеры Kraken и Coinbase

Статус: общие public-адаптеры и selected-instrument continuous backend; официальная документация
проверена 2026-07-14. Код строго public/read-only и может работать только в операторском allowlist
исследовательского сканера. Это не подтверждение исполнения или mainnet readiness.

## Реализованная граница

| Биржа | Реализовано | Явно не поддерживается |
| --- | --- | --- |
| Kraken | Spot metadata, bulk/selected BBO и L2; inverse/linear perpetual и future metadata/BBO/L2; current/predicted/history funding для inverse perpetual | private API, счета, ордера, borrow/transfers, options, непроверенные единицы `futures_vanilla`, конвертация current funding для linear |
| Coinbase Exchange | Spot products, L1 BBO выбранной пары и aggregated L2 | JWT/private API, ордера/счета, derivatives/funding, fan-out bulk BBO по всем продуктам |

В обоих manifest поля `privateExecution`, `borrow` и `depositWithdrawal` равны `false`; фабрики не
принимают ключи или JWT.

## Идентичность и единицы

Kraken Spot запрашивается с `assetVersion=1`: ID пары выглядит как `BTC/USD`, без устаревших
`X`/`Z`-префиксов. Официальная спецификация Kraken подтверждает эквивалентность API-кода `XBT` и
UI-кода `BTC`, поэтому только это соответствие применяется к derivatives; нативные символы
`PI_XBTUSD`, `PF_XBTUSD`, `FI_*`, `FF_*` сохраняются.

Spot и linear Multi-M используют размер в базовом активе. Inverse книги используют контракты:
`contractSize` задаёт quote-value, расчёт идёт в base. Для Coinbase размер книги и
`base_increment` — base units, а `quote_increment` — tick цены.

USD и USDC не объединяются. Даже `fx_stablecoin: true` не доказывает курс 1:1, поэтому для
`BTC-USD` и `BTC-USDC` не создаётся общий `economicAssetId`.

Kraken REST не публикует sequence для книг: `sequence: 0` означает честный unsequenced snapshot,
а не доказанную непрерывность. Coinbase sequence сохраняется. Auction-книги Coinbase отклоняются
как индикативные и потенциально crossed.

В continuous-потоке Kraken Spot v2 сохраняются точные decimal-токены JSON, обновления применяются
по порядку, книга обрезается строго до подписанной глубины и после каждого сообщения проверяется
официальный CRC32. Локальный ordinal действует только внутри connection generation. Kraken Futures
имеет отдельный `kraken-futures-seq`: `seq` обязан расти, но книга остаётся research-only, потому что
официальная спецификация не обещает contiguous sequence для одной пары.

Coinbase использует только публичные Advanced Trade `level2` и `heartbeats`. Credential-free
наблюдение production-потока 14 июля 2026 года показало, что `sequence_num` идёт глобально по
соединению и перемежает L2, подтверждения подписок, heartbeat и прочие конверты. Поэтому первый
номер обязан быть `0`, а каждый следующий — ровно `prior + 1` для любого non-error конверта ещё до
обработки или игнорирования канала. Отдельно проверяются snapshot-before-update, абсолютные
quantity и непрерывный heartbeat counter. Snapshot с sequence `0` публикуется как research-book,
но не допускается в route-ready до следующего положительного L2 sequence. Timestamp snapshot-
конверта не сравнивается с matching-engine `event_time` delta: официальный пример содержит epoch-
sentinel в snapshot, а production может прислать первый последовательный delta-event раньше
timestamp snapshot-конверта. Начиная с первого delta монотонность event-time всё равно проверяется
fail-closed. `market_trades` не
используется как книга. Большинство публичных `*-USDC` подписок отклоняется, так как Coinbase
возвращает для них данные соответствующей `*-USD` пары; исключения — документированные
`USDT-USDC` и `EURC-USDC`.

## Funding и защита ресурсов

Для inverse `PI_` текущая и прогнозная абсолютная ставка умножаются на index price и переводятся в
relative fraction; история использует `relativeFundingRate` напрямую. Положительный знак сохраняет
правило Kraken «long платит short». Расписание — почасовое. Ошибка истории не удаляет валидное
текущее расписание. Для linear current funding конвертация пока отключена, так как единица общего
ticker-поля недостаточно доказана.

- timeout по умолчанию 8 секунд и поддержка caller cancellation;
- body cap: 2 MiB Kraken, 4 MiB Coinbase;
- continuous WebSocket frame: 2 MiB по умолчанию и изолированные 8 MiB для полного Coinbase L2;
- Coinbase принимает не более 60 000 updates за frame и сохраняет не более 1 000 уровней;
- максимум восемь одновременных запросов без очереди;
- глубина результата 1–500 уровней;
- HTTP 429/local overload классифицируются как `rate-limit`;
- пустые, полностью повреждённые, crossed/locked/unsorted и identity-inconsistent ответы
  отклоняются fail-closed.

Оба Spot-потока включены в ежедневный/manual nine-target credential-free canary. Schema-v3 прогон
2026-07-14 прошёл для Coinbase и ещё семи бирж; Kraken остался заблокирован TLS egress этого
сервера. Live-наблюдения выявили реальный initial snapshot Coinbase 4,8 MiB/43k updates и
connection-global sequence между L2/control/heartbeat; оба случая имеют детерминированное
bounds/regression-покрытие. Один canary не является soak/readiness evidence. Тесты:
`backend/tests/krakenPublicAdapter.test.ts`,
`backend/tests/coinbasePublicAdapter.test.ts` и `backend/tests/krakenCoinbaseContinuousProtocols.test.ts`.
Каноническое описание, официальные источники и оставшийся успешный Kraken-canary находятся в
[английской версии](../KRAKEN_COINBASE_PUBLIC_ADAPTERS.md).
