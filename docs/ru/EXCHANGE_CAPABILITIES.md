# Возможности биржевого исполнения

Подробная каноническая таблица: [Exchange capability matrix](../EXCHANGE_CAPABILITIES.md).
Live trading остаётся **экспериментальным** и по умолчанию отключено.

- Paper поддерживает market/limit/conditional orders и локальные исполнения.
- Binance USDⓈ-M и Bybit USDT linear поддерживают market/limit, защитные ордера,
  обязательное подтверждение SL/TP, private stream и REST polling fallback.
- Live spot требует explicit experimental inventory override и не обещает
  защищённый strategy entry; inverse-рынки не поддерживаются.
- Private execution сохраняет execution ID, partial quantity, цену, реальную
  сумму/валюту комиссии и venue realized PnL; повтор ID идемпотентен.

Перед live использованием проверьте ключи без withdrawal, IP allowlist, NTP,
kill switch, CI/testnet read smoke, backtest/paper, filters/leverage/position mode,
защиту и restart/disconnect/timeout/duplicate/rejection. Исключённый решением
проекта 7–14-дневный testnet soak не выполняется, поэтому mainnet-ready статус
не заявляется.
