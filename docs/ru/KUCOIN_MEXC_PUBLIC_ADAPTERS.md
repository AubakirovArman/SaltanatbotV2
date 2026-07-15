# Современные публичные адаптеры KuCoin и MEXC

Статус: public/read-only адаптеры зарегистрированы в общем registry, public HTTP, generic SDK,
каталоге инструментов и REST governor; официальная документация проверена 2026-07-14. Есть fixtures
и детерминированные тесты ошибок/reconnect. Для KuCoin и MEXC подключены bounded public WebSocket к
shared protocol factory/hub. Оба Spot-target прошли локальный schema-v3 credential-free canary
2026-07-14; остаются повторяемые scheduled-артефакты и browser-workflow. Private execution, soak и
mainnet readiness не заявлены.

Обе биржи доступны через существующие динамические venue/source filters общего read-only
continuous view. Отдельных venue workflow, diagnostic page или chart selector нет; это отдельная
UX-задача, а bounded socket/factory/hub paths уже подключены.

## Граница возможностей

| Биржа | Реализовано | Явно не поддерживается |
| --- | --- | --- |
| KuCoin | Spot и linear USDT perpetual metadata, bulk/selected BBO, REST depth, current/predicted/history funding, bounded Spot/Futures public sockets для `increment@10ms` | снятый `depth=increment`, inverse/delivery, аккаунт/ордера/borrow/transfers |
| MEXC | Spot и linear USDT perpetual metadata/depth/funding, Spot BBO, selected perpetual BBO через depth, bounded Spot Protobuf decoder/socket и отдельный Futures `version + 1` socket | старый Spot JSON WS, perpetual bulk BBO без размеров, аккаунт/ордера/borrow/transfers |

Во всех manifest `privateExecution`, `borrow`, `depositWithdrawal` равны `false`; фабрики не
принимают ключи или подписи.

## Протоколы и единицы

KuCoin принимает только `obu` с `depth=increment@10ms`, введённый вместо legacy-режима,
отключённого 2026-07-15. Сначала обязателен snapshot с `O=C`; затем абсолютные delta должны
выполнять `O <= previous C + 1` и `C > previous C`. Нулевой размер удаляет уровень, reconnect
требует новый snapshot, каждая сторона ограничена 500 уровнями. Spot size — base units;
perpetual size — contracts, а `multiplier` — base amount одного контракта. Inverse и delivery
отклоняются fail-closed.

Shared continuous protocol ждёт `welcome` конкретного поколения на документированных public
endpoint `wss://x-push-spot.kucoin.com` / `wss://x-push-futures.kucoin.com`, затем отправляет только
`obu`, `rpiFilter: 0`, `depth=increment@10ms` и поддерживает application ping/pong. Числовые токены
`O/C/M/P` сохраняются точно до разбора. В route-ready input книга попадает только после начального
self-seeded snapshot с положительным safe sequence. Gap, регресс времени, повторный snapshot,
malformed/oversized message, пропущенный pong или reconnect немедленно снимают поколение.
Если KuCoin помечает JSON как binary frame, применяется лимит 2 MiB и fatal UTF-8 decode перед тем
же lossless parser; повреждённые байты не заменяются молча.
Текущая документация KuCoin отдельно называет UTA API активно разрабатываемым и запрещает считать
его production live-trading контуром; поэтому даже sequence-verified книга остаётся только public
research input.

MEXC Spot использует только новый `wss://wbs-api.mexc.com/ws` и опубликованные Protobuf-схемы.
Binary frame не преобразуется в текст: explicit decoder принимает только public wire tags
`PushDataV3ApiWrapper.publicAggreDepths` и отклоняет остальные oneof body, включая private/account.
Через тот же узкий интерфейс можно внедрить protoc-generated decoder, но frame/update bounds
сохраняются независимо. Open/ack/control-сообщения не запускают REST. Первый настоящий depth delta
буферизуется и запускает один single-flight snapshot-запрос для текущего поколения соединения;
следующие delta остаются в буфере, пока REST не завершится. Reducer связывает snapshot version с
`[fromVersion,toVersion]`, затем требует точное `fromVersion = previous toVersion + 1`.
MEXC Futures — отдельный native JSON `push.depth` с явным `compress: false`: merged/zipped mode не
может доказать получение каждого промежуточного version. После snapshot каждый новый `version` обязан быть
предыдущим плюс один. Spot и Futures не делят sequence-правила.

Оба socket зарегистрированы в shared hub и используют process-wide MEXC REST/WS governors. Запуск
REST только после первого depth delta закрывает гонку subscribe/snapshot. Close/reconnect отменяет
ожидающий запрос поколения, а его запоздавший результат игнорируется. Один REST snapshot не
публикуется как WebSocket evidence: нужен реальный delta, продвинувший version. Только fresh
positive safe version текущего поколения допускается в route-ready research. Ответ по-прежнему
`readOnly`, `research-only`, `executable: false`; разрешения на ордера нет.

REST по умолчанию использует актуальный `https://api.mexc.com` и для futures. Futures size —
contracts; `contractSize`, `priceUnit`, `volUnit`, `minVol` сохраняются. `collectCycle` и
`nextSettleTime` задают funding schedule. Bulk perpetual ticker не имеет bid/ask size, поэтому он
не публикуется; selected BBO строится из bounded depth.

Если MEXC публикует нулевой `baseSizePrecision`/`quoteAmountPrecision`, ноль сохраняется только как
«minimum неизвестен», а не как доказательство отсутствия лимита биржи.

## Защита и доказательства

- только анонимный `GET`, timeout 8 секунд, caller cancellation;
- body cap 4 MiB и максимум 8 запросов без очереди;
- depth: KuCoin 1–100, MEXC 1–500;
- gap, reconnect, oversized buffer/message, crossed/empty/unsorted book отклоняются fail-closed;
- структурированные timeout/cancel/rate-limit/HTTP/exchange/validation ошибки.

Тесты: `backend/tests/kucoinPublicAdapter.test.ts`, `backend/tests/mexcPublicAdapter.test.ts`,
`backend/tests/modernVenueBookProtocols.test.ts`, `backend/tests/kucoinContinuousProtocol.test.ts`,
`backend/tests/mexcSpotProtobufDecoder.test.ts` и `backend/tests/mexcContinuousProtocol.test.ts`;
проверяются также delta-triggered single-flight REST, буферизация во время snapshot, отмена и
игнорирование stale результата после reconnect.
Расширенный live-прогон 2026-07-14 прошёл для обоих Spot-target. Он выявил binary-marked JSON у
KuCoin и гонку subscribe/snapshot у MEXC; bounded fatal UTF-8 path и delta-triggered single-flight
REST bridge теперь являются детерминированными regression-тестами этих случаев. Остаются
browser-workflow, повторяемые scheduled canary-артефакты и проверка региональных условий. Один
public-прогон не является soak или readiness evidence; streaming funding MEXC пока REST-only.
Private Bitget остаётся исключённым.
Канонические источники находятся в
[английской версии](../KUCOIN_MEXC_PUBLIC_ADAPTERS.md).
