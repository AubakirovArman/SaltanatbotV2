# Возможности биржевого исполнения

Подробная каноническая таблица: [Exchange capability matrix](../EXCHANGE_CAPABILITIES.md).
Текущий `public-http-paper` отклоняет `private-live`, credential use, signed
requests, private streams и live orders; `ENABLE_LIVE_SPOT=true` останавливает
startup. Все live-строки ниже — только **неактивный future/private-live
справочник**, а не доступная экспериментальная функция.

Поля `scopes` в `/api/venues` задают точные product/operation/status. Отсутствующая комбинация не
поддерживается; общие boolean-поля намеренно остаются `false` для experimental/manual-only путей и
не могут использоваться как разрешение на торговую операцию.

- Paper поддерживает market/limit/conditional orders и локальные исполнения.
- Retained-код Binance USDⓈ-M и Bybit USDT linear содержит market/limit,
  защитные ордера, обязательное подтверждение SL/TP, private stream и REST
  polling fallback, но текущий runtime не может его активировать.
- Binance live spot полностью отключён до появления authenticated spot execution accounting.
  Retained Bybit live spot требует `ENABLE_LIVE_SPOT` и bot-attributed
  inventory, однако этот флаг несовместим с текущим runtime и останавливает
  startup; inverse-рынки не поддерживаются.
- Private execution сохраняет execution ID, partial quantity, цену, реальную
  сумму/валюту комиссии и venue realized PnL; повтор ID идемпотентен.
- Bybit UTA cross collateral показывает IMR/MMR, BTC-залог, долги и проценты. Займ выполняется только вручную с подтверждением; погашение по умолчанию не конвертирует залог. Для бота нужен явный opt-in, а UI-операциям требуется HTTPS.
- Запуски live-ботов сериализуются по exchange+symbol. Ошибка защиты после принятого entry не
  превращает его в rejected: managed state и резерв сохраняются, бот ставится на паузу, а отдельный
  reduce-only emergency close получает уникальный `…-safety` client ID и собственный venue order ID
  либо явную ошибку. Принятый обычный live close тоже не очищает managed state до authenticated
  execution accounting.

Перед возможным будущим live-релизом потребуется отдельная HTTPS/security
проверка ключей без withdrawal, IP allowlist, NTP, kill switch, testnet,
filters, protection и recovery. Это не инструкция для текущего релиза.
