# Публичный REST-адаптер Gate

Статус: публичный backend-адаптер проверен 14 июля 2026 года и доступен через
`/api/market-data/gate/*`. Он не входит в `/api/instruments`, live-сканер/chart UI или private trading.

Адаптер без API-ключей поддерживает публичный Gate API v4:

- метаданные SPOT и прямых бессрочных USDT-контрактов;
- исполнимый perpetual all/single top-of-book и single top-of-book для SPOT;
- полный REST-снимок стакана глубиной 1–100 уровней;
- текущий funding, проверяемое расписание и 1–100 исторических расчётов.

SPOT-количество измеряется в базовом активе. `precision` задаёт шаг цены, `amount_precision` — шаг
количества. Для perpetual размеры измеряются в контрактах, а `quanto_multiplier` сохраняет объём
базового актива в одном контракте. `order_price_round` и `order_size_min` не теряются. Значение
`minimumNotional: 0` означает «неизвестно», а не отсутствие ограничения.

Если Gate возвращает `enable_decimal=true`, публичная схема подтверждает десятичный размер, но не
даёт отдельный шаг количества. Адаптер безопасно отклоняет такую строку вместо угадывания lot step.
Также отклоняются неизвестные settlement/direction/status, пересечённый top-book, стакан без
sequence, несортированные/пересечённые уровни и отсутствующие размеры.

Отфильтрованный SPOT ticker возвращает `lowest_size`/`highest_size`, но текущий список всех пар их
не содержит. Поэтому `tickers("spot")` явно возвращает `unsupported`: адаптер не публикует
неисполнимые котировки и не создаёт fan-out примерно из 2000 запросов. SPOT `ticker()` и
perpetual all/single полностью поддерживаются.

У стакана используется нативный `update`: миллисекунды для SPOT и секунды с переводом в
миллисекунды для perpetual. В ticker и contract-funding Gate не возвращает exchange timestamp,
поэтому `exchangeTs` явно равен локальному времени получения и не считается точным временем биржи.

Funding применяется в `funding_next_apply`; следующий момент вычисляется только из корректного
`funding_interval`. Ошибка текущих данных блокирует результат, ошибка только истории сохраняет
текущую оценку и попадает в `sourceErrors`.

Есть timeout, caller cancellation, отдельные ошибки rate-limit/HTTP/exchange/validation, лимит
ответа 2 MiB и записанные offline fixtures. Capability manifest оставляет private execution,
аккаунт, займы и переводы выключенными.

Полное описание: [Gate public adapter](../GATE_PUBLIC_ADAPTER.md). Официальные источники:
[Gate API v4](https://www.gate.com/docs/developers/apiv4/en/) и
[Gate perpetual futures API](https://www.gate.com/docs/developers/apiv4/en/futures/).
