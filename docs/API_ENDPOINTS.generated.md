# Generated API endpoint index

> Generated from the backend server and modular route registrars. Do not edit by hand. See [API.md](./API.md) for schemas, examples and authentication flow.

This index is a route-presence contract. A change to an Express route makes `npm run docs:check` fail until the generated reference is refreshed.

## HTTP endpoints

| Method | Path | Access | Source |
| --- | --- | --- | --- |
| `GET` | `/api/arbitrage` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/clock-health` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/continuous-feed-health` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/depth` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/funding-curve` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/funding-curve/universe` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/history` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/lifecycle` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/n-leg/evaluate` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/native-spreads` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/options-parity/evaluate` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/pairwise/evaluate` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/route-families/evaluate` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/route-families/live` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/triangular` | Public | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/triangular/verify-depth` | Public | `backend/src/server.ts` |
| `GET` | `/api/candles` | Public | `backend/src/server.ts` |
| `GET` | `/api/catalog` | Public | `backend/src/server.ts` |
| `GET` | `/api/health` | Public | `backend/src/server.ts` |
| `GET` | `/api/instruments` | Public | `backend/src/server.ts` |
| `GET` | `/api/market-data/:venue/depth` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/funding` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/instruments` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/ticker` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/tickers` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/health/upstreams` | Public · read-only | `backend/src/venues/publicRoutes.ts` |
| `POST` | `/api/network-identity/preflight` | Public | `backend/src/server.ts` |
| `GET` | `/api/network-identity/registry` | Public | `backend/src/server.ts` |
| `GET` | `/api/orderbook-ml/research/health` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `GET` | `/api/orderbook-ml/research/sessions` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `POST` | `/api/orderbook-ml/research/sessions` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `DELETE` | `/api/orderbook-ml/research/sessions/:sessionId` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `GET` | `/api/orderbook-ml/research/sessions/:sessionId` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `POST` | `/api/orderbook-ml/research/sessions/:sessionId/models` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `GET` | `/api/orderbook-ml/research/sessions/:sessionId/models/:modelId` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `POST` | `/api/orderbook-ml/research/sessions/:sessionId/predictions` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `POST` | `/api/orderbook-ml/research/sessions/:sessionId/snapshots` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `GET` | `/api/orderbook-ml/research/status` | Authenticated · admin · research-only | `backend/src/orderbook/ml/researchRoutes.ts` |
| `GET` | `/api/sparklines` | Public | `backend/src/server.ts` |
| `GET` | `/api/trade/account-telemetry` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/accounts` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/accounts` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `DELETE` | `/api/trade/accounts/:id` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/accounts/:id` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `PATCH` | `/api/trade/accounts/:id` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `POST` | `/api/trade/arbitrage-alerts` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `DELETE` | `/api/trade/arbitrage-alerts/:id` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/deliveries` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/research` | Authenticated · paper-trade | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `POST` | `/api/trade/arbitrage-alerts/research` | Authenticated · paper-trade | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `DELETE` | `/api/trade/arbitrage-alerts/research/:id` | Authenticated · paper-trade | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/research/deliveries` | Authenticated · paper-trade | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `GET` | `/api/trade/audit` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/auth` | Public | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `DELETE` | `/api/trade/bots/:id` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/command` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/confirm-resume` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/fills` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/live` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/logs` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/order-journal` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/order-journal/:orderId/events` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/orders` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/reset-state` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/start` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/stop` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bybit/uta` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/borrow` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/collateral` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/repay` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/keys` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/keys` | Authenticated · admin | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/kill` | Authenticated · live-trade | `backend/src/trading/emergencyStopRoutes.ts` |
| `POST` | `/api/trade/kill` | Authenticated · live-trade | `backend/src/trading/emergencyStopRoutes.ts` |
| `GET` | `/api/trade/notify` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify-alert` | Authenticated · paper-trade | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify-arbitrage` | Authenticated · paper-trade | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify/test` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/paper-multi-leg/recovery` | Authenticated · paper-trade | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/paper-multi-leg/runs` | Authenticated · paper-trade | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `POST` | `/api/trade/paper-multi-leg/runs` | Authenticated · paper-trade | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/paper-multi-leg/runs/:runId` | Authenticated · paper-trade | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/portfolio` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `DELETE` | `/api/trade/session` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/session` | Public | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/settings` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/settings` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/ws-ticket` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/venues` | Public | `backend/src/server.ts` |

## WebSocket endpoints

| Path | Access | Purpose |
| --- | --- | --- |
| `/stream` | Public | Market candle snapshot and updates |
| `/quotes` | Public | Multiplexed watchlist quote snapshots and updates |
| `/orderbook` | Public | Shared Binance/Bybit order-book snapshots and status |
| `/trade-flow` | Public | Shared Binance/Bybit aggressor-trade batches and status |
| `/arbitrage-stream` | Public | Shared read-only cross-exchange arbitrage snapshots |
| `/trade-stream` | One-time authenticated WebSocket ticket | Bot, order, fill and runtime updates |

Generated totals: **93 HTTP endpoints** and **6 WebSocket endpoints**.
