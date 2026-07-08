# Roadmap

This tracks what a multi-dimension code audit surfaced and what has shipped. The safety-critical and quality-critical layers are **done**; the remaining items are larger features or need real exchange accounts / third-party keys to validate.

## Shipped

**Security**
- Access-token auth on the trading API + `/trade-stream`; loopback bind default; CORS allowlist; zod validation on all trade routes; live-trading arming + per-request confirmation + global kill switch; `DEMO_MODE`.

**Live-trading safety**
- Strict market-data routing (no synthetic fallback for live bots); exchange WebSocket auto-reconnect with backoff + gap backfill; bot resume after restart/crash; per-bot risk caps (max notional, max daily loss); exchange-side protective stops for live futures with fail-loud behavior; dry-run for manual commands; `clientOrderId` on orders.

**Backtest realism**
- Next-bar-open fills (no look-ahead); gap-aware stop/target fills with slippage; trailing-stop look-ahead fix; sizing/margin guardrails + simulated liquidation; warm-up exclusion; Monte Carlo robustness; drawdown curve, trade table, MAE/MFE; slippage + cost presets in the UI; backend↔frontend `setvar` parity.

**Data & UX**
- Timeframes 30m/2h/1w/1M; VWAP/ATR/Stochastic/OBV indicators; watchlist favorites + %-change sort; price alerts (browser notification + beep + toast).

**Engineering**
- Vitest suites (command parser, paper engine, backtest, evaluator parity, Monte Carlo); GitHub Actions CI (typecheck/lint/test/build + secret scan); multi-stage Dockerfile + docker-compose with persistent data volume; Biome lint gate.

## Remaining

| Item | Layer | Impact | Effort | Notes |
| --- | --- | --- | --- | --- |
| Parse live exchange fills into the journal (real PnL) | trading | high | L | Needs a funded testnet/live account to validate. |
| Round qty/price to exchange filters (`exchangeInfo`) | trading | high | M | Pair with live-fill work; live-account validation. |
| Live order-status polling (partial fills, resting-order lifecycle) | trading | high | L | Private user-data stream or REST poll. |
| Idempotent placement (query-by-clientId on timeout) | trading | high | M | Plumbing exists; needs live retry logic. |
| Portfolio view + cross-bot collision guard | trading | high | M | Aggregate across running live adapters. |
| Persist candles in SQLite for deep history | data | high | L | Enables long backtests without re-fetching. |
| Dynamic instrument catalog from `exchangeInfo` | data | high | M | Replace the hardcoded pair list. |
| Share one upstream WS per (exchange, symbol, tf) | data | high | M | Fan out to browser clients from one socket. |
| Rate-limit handling (429/418, Retry-After, coalescing) | data | high | M | |
| OKX (and KuCoin/MEXC) as data sources | data | medium | M | |
| Walk-forward + out-of-sample + parameter optimizer | backtest | high | L | Grid/random search in a Web Worker; IR inputs already typed. |
| Multi-symbol portfolio backtests | backtest | medium | XL | Shared capital pool across symbols. |
| Funding/borrow cost model for shorts | backtest | medium | M | |
| AI strategy generation (NL → blocks) | product | high | M | BYO LLM key; validates against the JSON IR. |
| Community template gallery + `.strategy` export/import | product | high | M | URL-hash sharing already exists. |
| Two-way Telegram control (start/stop/status) | product | high | M | Notifications exist; add a command poller. |
| Hosted read-only demo instance (`DEMO_MODE`) | product | critical | M | Deploy-time; synthetic data + paper. |
| Docs site + tutorials; mobile PWA; plugin API | product | medium | L–XL | |
| RU/EN localization | ux | medium | M | |
| Symbol compare / multi-chart layouts; saved workspaces | ux | high | L | |
| Timezone/session-aware time axis; touch gestures | ux | medium | M | |
| Order book depth + trade tape; funding/OI display | data | medium/low | L | |

## See also

- [Configuration & deployment](./CONFIGURATION.md)
- [Trading engine](./TRADING.md)
- [Strategies & backtesting](./STRATEGIES.md)
