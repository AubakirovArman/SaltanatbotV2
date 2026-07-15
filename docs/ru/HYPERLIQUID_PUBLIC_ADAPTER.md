# Публичный адаптер Hyperliquid

Статус: публичный backend-адаптер сверён с официальным API 14 июля 2026 года и доступен через
`/api/market-data/hyperliquid/*`. Он не входит в `/api/instruments`, live-сканер/chart UI или
private execution.

Адаптер без ключей вызывает только публичный `POST /info`: метаданные spot/default-perp DEX,
`l2Book`, `predictedFundings` и `fundingHistory`. В нём нет `/exchange`, кошелька, agent key,
подписи, пользовательского адреса, исполнения, займа или перевода. HyperEVM, indexer, HIP-3 DEX и
outcome-активы `#...` не входят в текущий scope.

Для spot отдельно сохраняются token ID, token index и pair index; execution asset ID равен
`10000 + pairIndex`. PURR использует `PURR/USDC`, остальные пары — нативный `@{pairIndex}`.
Идентификатор включает mainnet/testnet и token ID, поэтому UI-переименование вроде UBTC → BTC не
склеивает разные активы. У perp сохраняется индекс строки metadata universe. `isDelisted` даёт
проверенный статус `closed`; для spot аналогичного официального флага нет, что отражено явно.

Размер измеряется в базовом активе, шаг равен `10^-szDecimals`. Единого статического tick size нет:
цена ограничена пятью значащими цифрами и `6 - szDecimals` знаками после запятой для perp либо
`8 - szDecimals` для spot. Поэтому `tickSize: 0` означает динамическое/неизвестное значение, а не
отсутствие проверки; точное правило находится в `priceRules`.

Исполнимые bid/ask берутся только из `l2Book`. `allMids` не используется, потому что при пустом
стакане API может вернуть последнюю сделку. Mid, mark и oracle находятся в отдельном
`referenceContext` с `executable: false`. REST-стакан ограничен 20 уровнями и не имеет sequence или
checksum; это отмечено `sequenceVerified: false`. Поскольку каждый `l2Book` принимает только одну
coin, bulk `tickers()` явно возвращает `unsupported`: один анонимный запрос не превращается в сотни
upstream-вызовов. Для одной выбранной пары используются `ticker()` или `depth()`.

Текущий funding берётся из `HlPerp` в `predictedFundings`, история — из `fundingHistory`. Проверенный
интервал составляет один час, лимит — ±4% в час. Ошибка прогноза блокирует результат; недоступная
история не удаляет текущую оценку и попадает в `sourceErrors`. У прогноза нет server timestamp,
поэтому время наблюдения явно помечено как `local-receive`.

Все запросы имеют timeout, отмену, ограничение размера и строгую валидацию. Полное описание и
официальные ссылки: [Hyperliquid public adapter](../HYPERLIQUID_PUBLIC_ADAPTER.md).
