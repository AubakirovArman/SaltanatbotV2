# Roadmap

> This page tracks feature direction. The prioritized engineering and release program is maintained in [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md), with separate [modular architecture](./MODULAR_ARCHITECTURE.md), [testing](./TESTING_STRATEGY.md), and [internationalization/documentation](./I18N_AND_DOCUMENTATION.md) specifications.

This tracks what a multi-dimension code audit surfaced and what has shipped. The app has a strong alpha foundation, but live-trading safety is not considered production-ready until the release gates in [Code Improvement Plan](./CODE_IMPROVEMENT_PLAN.md) are proven by tests and testnet/live reconciliation. Some remaining items need a funded exchange account / third-party keys / deploy infra to validate.

## Shipped

**Security**
- Access-token auth on the trading API + `/trade-stream`; loopback bind default; CORS allowlist; zod validation on all trade routes; live-trading arming + per-request confirmation + global kill switch; `DEMO_MODE`.

**Live-trading safety & correctness**
- Strict market-data routing (no synthetic fallback for live bots); exchange WebSocket auto-reconnect with backoff + gap backfill; bot resume after restart/crash; per-bot risk caps (max notional, max daily loss); exchange-side protective stops with fail-loud; dry-run for manual commands; `clientOrderId`.
- **Exchange precision rounding** (LOT_SIZE/PRICE_FILTER/minNotional from exchangeInfo — prevents -1013 rejections); **portfolio view** (`GET /api/trade/portfolio`); **cross-bot collision guard** (no two live bots on one exchange+symbol).

**Backtest realism & power**
- Next-bar-open fills; gap-aware stop/target fills with slippage; trailing-stop look-ahead fix; sizing/margin guardrails + simulated liquidation; warm-up exclusion; Monte Carlo robustness; drawdown curve, trade table, MAE/MFE; slippage + cost presets; backend↔frontend `setvar` parity.
- **Parameter optimizer** (grid/random search, in-/out-of-sample split, Web Worker) + **walk-forward**; **funding/borrow cost** model.

**Market data**
- Binance + Bybit providers with runtime source selector; timeframes 1m–1M; **persistent SQLite candle store** (deep history / instant re-backtest); **dynamic instrument catalog** (~200 USDT-spot pairs from exchangeInfo ∩ instruments-info, curated fallback); **rate-limit handling** (429/418 backoff, Retry-After).

**UX**
- VWAP/ATR/Stochastic/OBV indicators; watchlist favorites + %-change sort; price alerts (notification + sound); **symbol compare overlay** (normalized, engine-rendered).

**Product**
- **Strategy template gallery** (categorized); **`.strategy` export/import**; **saved workspaces** (named chart layouts); **two-way Telegram control** (`/status` `/stop` `/start` `/kill`, chatId-authorized).

**Engineering**
- 262 Vitest tests (commands, paper engine, filters, collision, Telegram, backtest, Pine and evaluator parity) plus an initial Playwright production E2E suite; GitHub Actions CI, Docker and Biome gates.

## Remaining

| Item | Layer | Impact | Effort | Notes |
| --- | --- | --- | --- | --- |
| Parse live exchange fills into the journal (real PnL) | trading | high | L | Needs a funded testnet/live account to validate. |
| Live order-status polling (partial fills, resting-order lifecycle) | trading | high | L | Private user-data stream or REST poll; funded account. |
| Idempotent placement (query-by-clientId on timeout) | trading | high | M | Plumbing exists; needs live retry validation. |
| Share one upstream WS per (exchange, symbol, tf) | data | high | M | Fan out to browser clients from one socket. |
| OKX (and KuCoin/MEXC) as data sources | data | medium | M | |
| Multi-symbol portfolio backtests | backtest | medium | XL | Shared capital pool across symbols. |
| AI strategy generation (NL → blocks) | product | high | M | BYO LLM key; validates against the JSON IR. |
| Hosted read-only demo instance | product | critical | M | Deploy-time; `DEMO_MODE` is ready. |
| Docs site + tutorials; mobile PWA; plugin API | product | medium | L–XL | |
| RU/EN localization | ux | medium | M | Large mechanical string externalization. |
| Multi-chart layouts / saved multi-pane grids | ux | high | L | Symbol compare shipped; multi-pane grid remains. |
| Timezone/session-aware time axis; touch gestures | ux | medium | M | |
| Order book depth + trade tape; funding/OI display | data | medium/low | L | |

## See also

- [Configuration & deployment](./CONFIGURATION.md)
- [Trading engine](./TRADING.md)
- [Strategies & backtesting](./STRATEGIES.md)
