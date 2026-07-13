# Generated API endpoint index

> Generated from the backend server and modular route registrars. Do not edit by hand. See [API.md](./API.md) for schemas, examples and authentication flow.

This index is a route-presence contract. A change to an Express route makes `npm run docs:check` fail until the generated reference is refreshed.

## HTTP endpoints

| Method | Path | Access | Source |
| --- | --- | --- | --- |
| `GET` | `/api/arbitrage` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/depth` | Public | `backend/src/server.ts` |
| `GET` | `/api/arbitrage/history` | Public | `backend/src/server.ts` |
| `GET` | `/api/candles` | Public | `backend/src/server.ts` |
| `GET` | `/api/catalog` | Public | `backend/src/server.ts` |
| `GET` | `/api/health` | Public | `backend/src/server.ts` |
| `GET` | `/api/sparklines` | Public | `backend/src/server.ts` |
| `GET` | `/api/trade/arbitrage-alerts` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `POST` | `/api/trade/arbitrage-alerts` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
| `DELETE` | `/api/trade/arbitrage-alerts/:id` | Authenticated · paper-trade | `backend/src/arbitrage/alertRoutes.ts` |
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
| `GET` | `/api/trade/bybit/uta` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bybit/uta/borrow` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bybit/uta/collateral` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/bybit/uta/repay` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/keys` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/keys` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/kill` | Authenticated · live-trade | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/notify` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify-alert` | Authenticated · paper-trade | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify-arbitrage` | Authenticated · paper-trade | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/notify/test` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/portfolio` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `DELETE` | `/api/trade/session` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/session` | Public | `backend/src/trading/routes.ts` |
| `GET` | `/api/trade/settings` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/settings` | Authenticated · admin | `backend/src/trading/routes.ts` |
| `POST` | `/api/trade/ws-ticket` | Authenticated · read-only+ | `backend/src/trading/routes.ts` |

## WebSocket endpoints

| Path | Access | Purpose |
| --- | --- | --- |
| `/stream` | Public | Market candle snapshot and updates |
| `/quotes` | Public | Multiplexed watchlist quote snapshots and updates |
| `/orderbook` | Public | Shared Binance/Bybit order-book snapshots and status |
| `/trade-flow` | Public | Shared Binance/Bybit aggressor-trade batches and status |
| `/arbitrage-stream` | Public | Shared read-only cross-exchange arbitrage snapshots |
| `/trade-stream` | One-time authenticated WebSocket ticket | Bot, order, fill and runtime updates |

Generated totals: **44 HTTP endpoints** and **6 WebSocket endpoints**.
