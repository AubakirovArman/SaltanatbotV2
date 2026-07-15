# Публичные данные Deribit и исследование опционного паритета

Статус: публичный адаптер доступен через `/api/market-data/deribit/*`; pure parity engine опубликован
через ограниченный `POST /api/arbitrage/options-parity/evaluate` и публичный TypeScript SDK. Scanner
UI содержит EN/RU/KK лабораторию сценариев; торговля и приватный доступ к Deribit не реализованы.

## Публичный адаптер

`backend/src/venues/deribit` — read-only JSON-RPC-адаптер без ключей и токенов. Разрешены только получение фьючерсов, perpetual и опционов, ticker/top book, глубины стакана и истории funding. В capability manifest всегда указано `privateExecution: false`.

У Deribit нет ограниченного bulk-метода исполнимых ticker. Поэтому `tickers()` явно возвращает
`unsupported`: клиент выбирает один точный инструмент и вызывает `ticker()` или `depth()`, не создавая
неограниченный JSON-RPC fan-out по тысячам опционов.

Транспорт независимо проверяет HTTP и JSON-RPC: размер ответа, timeout/отмену вызывающей стороны, версию `2.0`, точное совпадение `id`, взаимоисключающие `result`/`error`, известные служебные поля Deribit, ошибки биржи и структуру payload. Противоречивый ответ отклоняется.

Единицы Deribit не смешиваются:

- `amount` для perpetual и inverse futures выражен в quote/USD;
- `amount` для options и linear futures выражен в базовом активе;
- `contract_size` хранится отдельно как множитель контракта;
- шаг берётся из `qty_tick_size`, а fallback на `min_trade_amount` явно помечается;
- отдельно сохраняются валюта премии и расчёта, экспирация, strike, call/put, European exercise и двухэтапный расчёт linear option через future с немедленным cash settlement.

Funding Deribit начисляется непрерывно. `funding_8h` используется только как оценка на восьмичасовом горизонте, поэтому `scheduleVerified` остаётся `false`: адаптер не выдумывает дискретную дату выплаты.

## Движок опционного паритета

`backend/src/arbitrage/engines/optionsParity` моделирует put-call parity, conversion/reversal, long/short box и synthetic forward. Это чистый исследовательский модуль без счетов и исполнения.

Call и put обязаны совпадать по underlying, expiry, strike, валюте strike, валюте/процессу расчёта и быть европейскими. Box использует два разных strike, но одну экспирацию и одинаковые параметры расчёта.

Объём рассчитывается только по исполнимым bid/ask уровням стакана. Все ноги приводятся к одному base-equivalent объёму с учётом шага и множителя. Комиссии, FX премии, risk-free/dividend rates, exercise и settlement задаются явно с источником и временем. Денежные потоки расчёта принимаются только при `settlementAsset === valuationAsset`: без явной модели FX на момент экспирации движок отклоняет сценарий, а не подставляет несуществующую конвертацию. Для каждой короткой опционной ноги нужна подтверждённая доступность и margin capacity; для reversal дополнительно обязательны подтверждённый займ underlying, лимит и ставка займа.

Любой результат навсегда помечен `research-simulation`, `visible-depth-taker`, `executable: false`. Это не обещание безрисковой прибыли, доходности на капитал или возможности немедленно отправить ордера.

## Публичная граница HTTP и SDK

`POST /api/arbitrage/options-parity/evaluate` принимает полную основную пару call/put, необязательную
полную вторую серию для box, стакан underlying, целевой base-объём и явные timestamped assumptions.
Каждая сторона стакана ограничена 400 уровнями, каждая карта assumptions — восемью записями,
pairing — 4–64 итерациями, ответ — 16 кандидатами и 64 отказами. Строгая схема отклоняет неизвестные
поля, включая API keys, secrets и order-like данные. Ответ имеет `no-store` и неизменные
`readOnly: true`, `researchOnly: true`, `executable: false`, `execution: "none"`.

В ответе явно повторяется caller-supplied контракт: точная expiry инструмента; European automatic
hold-to-expiry cash-equivalent settlement; отсутствие settlement FX, пока settlement и valuation
asset не совпадают; отдельный premium FX; отдельные комиссии options и underlying. Метод SDK
`optionsParity()` использует те же типы и строгий runtime parser. Он отклоняет неизвестные поля,
поддельный executable, неверные формы стратегий/ног, несогласованные PnL/fee/edge, арифметику времени
и изменённую политику assumptions. Ни HTTP, ни SDK не читают аккаунт, не принимают credentials и не
создают ордера.

## Лаборатория сценариев

В режиме **Скринер → Паритет опционов** можно задать одну европейскую пару call/put и underlying:
top-book цены, strike, горизонт expiry, base quantity, short capacity, ставки и комиссии. Браузер
формирует тот же строгий public request, явно называет все значения допущениями пользователя и
показывает экономику кандидатов, ноги видимой глубины и причины отказа. Snapshot не считается
account entitlement, не сохраняет ключи и не содержит кнопок ордера. Component-тесты и Chromium E2E
проверяют crossed-book rejection, локализацию и реальный pure HTTP route.

## Проверка

Recorded fixtures охватывают inverse BTC options, linear USDC options с multiplier, inverse perpetual, ticker/depth, continuous funding и JSON-RPC errors. Unit/conformance-тесты проверяют единицы, settlement и отклонение отсутствующего settlement FX, строгий envelope/id, timeout/abort, проход глубины, fee cap, все виды кандидатов, fail-closed поведение при stale/skew/missing legs, HTTP bounds и adversarial SDK parsing.

Использованы только официальные источники: [JSON-RPC](https://docs.deribit.com/articles/json-rpc-overview), [ошибки](https://docs.deribit.com/articles/errors), [инструменты](https://docs.deribit.com/api-reference/market-data/public-get_instruments), [ticker](https://docs.deribit.com/api-reference/market-data/public-ticker), [стакан](https://docs.deribit.com/api-reference/market-data/public-get_order_book), [funding history](https://docs.deribit.com/api-reference/market-data/public-get_funding_rate_history), [inverse options](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options), [linear USDC options](https://support.deribit.com/hc/en-us/articles/31424932728093-Linear-USDC-Options).
