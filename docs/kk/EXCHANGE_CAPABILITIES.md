# Exchange execution мүмкіндіктері

Толық canonical кесте: [Exchange capability matrix](../EXCHANGE_CAPABILITIES.md).
Live trading **эксперименттік** және default бойынша сөндірілген.

- Paper market/limit/conditional orders және local fills қолдайды.
- Binance USDⓈ-M және Bybit USDT linear market/limit, protective orders,
  міндетті SL/TP acknowledgement, private stream және REST polling fallback береді.
- Live spot explicit experimental inventory override талап етеді; inverse markets
  қолдау көрсетпейді.
- Private execution ID, partial qty, price, нақты fee amount/asset және venue
  realized PnL сақталады; replayed ID idempotent.

Live алдында withdrawal-сыз keys, IP allowlist, NTP, kill switch, CI/testnet read
smoke, backtest/paper, filters/leverage/position mode және recovery сценарийлерін
тексеріңіз. Алып тасталған 7–14 күндік testnet soak орындалмайды, сондықтан
mainnet-ready мәртебесі жарияланбайды.
