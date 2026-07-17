# Generated API endpoint index

> Generated from the backend server and modular route registrars. Do not edit by hand. See [API.md](./API.md) for schemas, examples and authentication flow.

This index is a route-presence and access-classification contract. A change to an Express route or its canonical registrar metadata makes `npm run docs:check` fail until the generated reference is refreshed.

## HTTP endpoints

| Method | Path | Access | Source |
| --- | --- | --- | --- |
| `GET` | `/api/admin/audit` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `GET` | `/api/admin/operations/metrics` | Authenticated · admin | `backend/src/identity/serverRoutes.ts` |
| `GET` | `/api/admin/users` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `POST` | `/api/admin/users/:id/activate` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `POST` | `/api/admin/users/:id/disable` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `PATCH` | `/api/admin/users/:id/permissions` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `POST` | `/api/admin/users/:id/reactivate` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `GET` | `/api/admin/users/:id/sessions` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `POST` | `/api/admin/users/:id/sessions/:publicId/revoke` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `POST` | `/api/admin/users/:id/sessions/revoke-all` | Authenticated · admin | `backend/src/identity/routes.ts` |
| `GET` | `/api/alerts` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `POST` | `/api/alerts` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `DELETE` | `/api/alerts/:id` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `GET` | `/api/alerts/:id` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `PUT` | `/api/alerts/:id` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `POST` | `/api/alerts/:id/archive` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `POST` | `/api/alerts/:id/rearm` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `GET` | `/api/alerts/events` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `GET` | `/api/alerts/outbox` | Authenticated · owner-scoped · research-only | `backend/src/alerts/routes.ts` |
| `GET` | `/api/arbitrage` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/clock-health` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/continuous-feed-health` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/depth` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/funding-curve` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/funding-curve/universe` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/history` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/lifecycle` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/n-leg/evaluate` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/native-spreads` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/options-parity/evaluate` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/pairwise/evaluate` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/route-families/evaluate` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/route-families/live` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/triangular` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/arbitrage/triangular/verify-depth` | Authenticated account | `backend/src/server.ts` |
| `POST` | `/api/auth/change-password` | Authenticated account | `backend/src/identity/routes.ts` |
| `GET` | `/api/auth/config` | Public | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/login` | Public | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/logout` | Authenticated account | `backend/src/identity/routes.ts` |
| `GET` | `/api/auth/me` | Authenticated account | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/register` | Public | `backend/src/identity/routes.ts` |
| `GET` | `/api/auth/sessions` | Authenticated account | `backend/src/identity/routes.ts` |
| `DELETE` | `/api/auth/sessions/:publicId` | Authenticated account | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/sessions/:publicId/revoke` | Authenticated account | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/sessions/revoke-all` | Authenticated account | `backend/src/identity/routes.ts` |
| `POST` | `/api/auth/sessions/revoke-others` | Authenticated account | `backend/src/identity/routes.ts` |
| `GET` | `/api/candles` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/catalog` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/health` | Public | `backend/src/identity/serverRoutes.ts` |
| `GET` | `/api/instruments` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/jobs` | Authenticated · owner-scoped | `backend/src/jobs/routes.ts` |
| `POST` | `/api/jobs` | Authenticated · owner-scoped | `backend/src/jobs/routes.ts` |
| `GET` | `/api/jobs/:id` | Authenticated · owner-scoped | `backend/src/jobs/routes.ts` |
| `POST` | `/api/jobs/:id/cancel` | Authenticated · owner-scoped | `backend/src/jobs/routes.ts` |
| `GET` | `/api/jobs/metrics` | Authenticated · owner-scoped | `backend/src/jobs/routes.ts` |
| `GET` | `/api/market-data/:venue/depth` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/funding` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/instruments` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/ticker` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/:venue/tickers` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `GET` | `/api/market-data/health/upstreams` | Authenticated account · public-market read-only | `backend/src/venues/publicRoutes.ts` |
| `POST` | `/api/network-identity/preflight` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/network-identity/registry` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/onboarding` | Authenticated · owner-scoped | `backend/src/onboarding/routes.ts` |
| `POST` | `/api/onboarding/dismiss` | Authenticated · owner-scoped | `backend/src/onboarding/routes.ts` |
| `PUT` | `/api/onboarding/goal` | Authenticated · owner-scoped | `backend/src/onboarding/routes.ts` |
| `POST` | `/api/onboarding/milestones` | Authenticated · owner-scoped | `backend/src/onboarding/routes.ts` |
| `POST` | `/api/onboarding/restart` | Authenticated · owner-scoped | `backend/src/onboarding/routes.ts` |
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
| `GET` | `/api/ready` | Public | `backend/src/identity/serverRoutes.ts` |
| `GET` | `/api/screener/presets` | Authenticated · owner-scoped · research-only | `backend/src/screener/routes.ts` |
| `POST` | `/api/screener/presets` | Authenticated · owner-scoped · research-only | `backend/src/screener/routes.ts` |
| `PUT` | `/api/screener/presets/:id` | Authenticated · owner-scoped · research-only | `backend/src/screener/routes.ts` |
| `POST` | `/api/screener/presets/:id/archive` | Authenticated · owner-scoped · research-only | `backend/src/screener/routes.ts` |
| `GET` | `/api/sparklines` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/trade/account-telemetry` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/accounts` | Authenticated · read-only+ · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/accounts` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `DELETE` | `/api/trade/accounts/:id` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/accounts/:id` | Authenticated · read-only+ · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `PATCH` | `/api/trade/accounts/:id` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `DELETE` | `/api/trade/accounts/:id/credentials` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `PUT` | `/api/trade/accounts/:id/credentials` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts` | Authenticated · admin | `backend/src/arbitrage/alertRoutes.ts` |
| `POST` | `/api/trade/arbitrage-alerts` | Authenticated · admin | `backend/src/arbitrage/alertRoutes.ts` |
| `DELETE` | `/api/trade/arbitrage-alerts/:id` | Authenticated · admin | `backend/src/arbitrage/alertRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/deliveries` | Authenticated · admin | `backend/src/arbitrage/alertRoutes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/research` | Authenticated · admin | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `POST` | `/api/trade/arbitrage-alerts/research` | Authenticated · admin | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `DELETE` | `/api/trade/arbitrage-alerts/research/:id` | Authenticated · admin | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `GET` | `/api/trade/arbitrage-alerts/research/deliveries` | Authenticated · admin | `backend/src/arbitrage/researchAlerts/routes.ts` |
| `GET` | `/api/trade/audit` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/auth` | Public | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots` | Authenticated · paper/live role by bot | `backend/src/trading/botLifecycleMutationRoutes.ts` |
| `DELETE` | `/api/trade/bots/:id` | Authenticated · paper/live role by bot | `backend/src/trading/botLifecycleMutationRoutes.ts` |
| `POST` | `/api/trade/bots/:id/command` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/confirm-resume` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/fills` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/live` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/logs` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/order-journal` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/order-journal/:orderId/events` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bots/:id/orders` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/reset-state` | Authenticated · paper/live role by bot | `backend/src/trading/botLifecycleMutationRoutes.ts` |
| `POST` | `/api/trade/bots/:id/start` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bots/:id/stop` | Authenticated · paper/live role by bot | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/bybit/uta` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/borrow` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/collateral` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/bybit/uta/repay` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/keys` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `POST` | `/api/trade/keys` | Authenticated · live-trade · owner-scoped | `backend/src/trading/tradingAccountRoutes.ts` |
| `GET` | `/api/trade/kill` | Authenticated · live-trade | `backend/src/trading/emergencyStopRoutes.ts` |
| `POST` | `/api/trade/kill` | Authenticated · live-trade | `backend/src/trading/emergencyStopRoutes.ts` |
| `GET` | `/api/trade/notify` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/notificationRoutes.ts` |
| `POST` | `/api/trade/notify` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/notificationRoutes.ts` |
| `POST` | `/api/trade/notify-alert` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/notificationRoutes.ts` |
| `POST` | `/api/trade/notify-arbitrage` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/notificationRoutes.ts` |
| `POST` | `/api/trade/notify/test` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/notificationRoutes.ts` |
| `GET` | `/api/trade/paper-multi-leg/recovery` | Authenticated · admin | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/paper-multi-leg/runs` | Authenticated · admin | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `POST` | `/api/trade/paper-multi-leg/runs` | Authenticated · admin | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/paper-multi-leg/runs/:runId` | Authenticated · admin | `backend/src/arbitrage/paperMultiLeg/routes.ts` |
| `GET` | `/api/trade/paper-portfolios` | Authenticated · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `POST` | `/api/trade/paper-portfolios` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `GET` | `/api/trade/paper-portfolios/:portfolioId` | Authenticated · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `PATCH` | `/api/trade/paper-portfolios/:portfolioId` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/archive` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/default` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/reset` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `POST` | `/api/trade/paper-portfolios/:portfolioId/robots/:botId/actions` | Authenticated · paper-trade · owner-scoped | `backend/src/trading/paperPortfolioRoutes.ts` |
| `GET` | `/api/trade/portfolio` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `DELETE` | `/api/trade/session` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/session` | Public | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/settings` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/settings` | Authenticated · live-trade | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/ws-ticket` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `GET` | `/api/venues` | Authenticated account | `backend/src/server.ts` |
| `GET` | `/api/workspaces` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `DELETE` | `/api/workspaces/:id` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `GET` | `/api/workspaces/:id` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `PUT` | `/api/workspaces/:id` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces/:id/archive` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces/:id/duplicate` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `GET` | `/api/workspaces/:id/export` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `PATCH` | `/api/workspaces/:id/name` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `DELETE` | `/api/workspaces/:id/permanent` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces/:id/restore` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `GET` | `/api/workspaces/:id/revisions` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces/:id/rollback` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `POST` | `/api/workspaces/import` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |
| `GET` | `/api/workspaces/quota` | Authenticated · owner-scoped | `backend/src/workspaces/routes.ts` |

## WebSocket endpoints

| Path | Access | Purpose |
| --- | --- | --- |
| `/stream` | Authenticated account | Market candle snapshot and updates |
| `/quotes` | Authenticated account | Multiplexed watchlist quote snapshots and updates |
| `/orderbook` | Authenticated account | Shared Binance/Bybit order-book snapshots and status |
| `/trade-flow` | Authenticated account | Shared Binance/Bybit aggressor-trade batches and status |
| `/arbitrage-stream` | Authenticated account | Shared read-only cross-exchange arbitrage snapshots |
| `/trade-stream` | One-time authenticated WebSocket ticket | Bot, order, fill and runtime updates |

Generated totals: **163 HTTP endpoints** and **6 WebSocket endpoints**.
