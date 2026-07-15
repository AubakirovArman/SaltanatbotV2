# Публичные и chain-aware данные dYdX

Статус: read-only адаптер зарегистрирован в общем public facade, REST governor и instrument
registry; generic continuous hub теперь умеет открывать ограниченный публичный Indexer socket для
operator-allowlisted инструмента. Реализация проверена 2026-07-14. Поток виден через существующие
динамические venue/source filters в read-only continuous view; отдельного dYdX workflow или chart
selector нет. Подключение не меняет границу: все стаканы неканонические, research-only и
`routeReady: false`.

`backend/src/venues/dydx` без ключей получает perpetual metadata, один выбранный top book/depth,
текущую оценку и историю funding из публичного Indexer. Код не принимает wallet, mnemonic, private
key, subaccount, signature или order-команду. Транспорт разрешает только три ограниченных `GET`
маршрута, имеет timeout, caller cancellation и лимит ответа; custom origin не может содержать
credentials, path, query или fragment.

## Почему стакан только исследовательский

У dYdX off-chain стакан зависит от mempool текущего proposer. Indexer не видит этот канонический
для конкретного блока mempool напрямую, поэтому его стакан иногда может быть пересечён. REST-ответ
явно содержит `canonical: false`, `executable: false`, `executionStatus: research-only`,
`sequenceAvailable: false` и `timestampSource: local-receive`. Пересечённый REST-стакан отклоняется:
в нём нет logical offset, позволяющего корректно убрать пересечение.

WebSocket-обвязка сначала привязывает официальный `connected` identity и подписывается только на
unbatched `v4_orderbook`. Reducer начинает с `subscribed`, требует непрерывный `message_id` и
сбрасывает generation при gap, replacement snapshot или смене connection. Он применяет официальное
offset-uncrossing, но возвращает `sequence-observed` и `routeReady: false`: последовательность
Indexer не доказывает состояние mempool текущего proposer и не допускается в market economics.

## Full-node и finality

`DydxNodeBookReconciler` принимает уже декодированные ограниченные batches с `block_height`,
`exec_mode`, snapshot и place/fill/remove. До snapshot updates игнорируются. `execMode=7` сохраняет
finalized checkpoint, остальные режимы считаются optimistic; optimistic изменения можно откатить к
последнему checkpoint. Регресс finalized height, неизвестный order, неверный `clobPairId`, unsafe
integer и превышение лимитов переводят состояние в fail-closed.

Reducer сам не подключается к gRPC/WebSocket. Для production нужен собственный full node, официальный
protobuf decoder, reconnect/resnapshot, resource governor и повторяемые reorg-тесты. Даже finalized
локальный off-chain стакан остаётся `routeReady: false` и не является обещанием исполнения.

Текущий funding estimate берётся из `nextFundingRate`; settled history сохраняет `effectiveAtHeight`.
Точное время следующего начисления в market row отсутствует, поэтому граница следующего UTC-часа
помечена как локальное допущение и `scheduleVerified: false`.
Continuous Indexer socket публикует только стакан: funding не синтезируется и не стримится, а
остаётся bounded REST-данными с указанным ограничением schedule.

Канонические детали, команды проверки и ссылки на официальную документацию находятся в
[английском документе](../DYDX_PUBLIC_ADAPTER.md).
