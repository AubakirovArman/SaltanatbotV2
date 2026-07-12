# HTTP & WebSocket API reference

SaltanatbotV2 exposes an Express + WebSocket backend that serves market data (catalog, candles, sparklines), live candle/quote streams, and a paper/live trading engine. All HTTP endpoints return JSON, CORS is allowlist-based, and request bodies are parsed as JSON with a 1 MB limit. By default the server listens on `http://127.0.0.1:4180` (override with the `PORT` and `HOST` environment variables). Market endpoints live under `/api/*`, trading endpoints under `/api/trade/*`, and three WebSocket endpoints are exposed at `/stream`, `/quotes` and `/trade-stream`. Any unmatched non-API path falls through to the bundled frontend single-page app.

Public market catalog, candle, sparkline and WebSocket payloads have canonical TypeScript contracts
plus fail-closed runtime parsers in `packages/contracts`. The frontend validates untrusted JSON at
the transport edge before updating state; malformed or unknown stream messages produce an explicit
connection error instead of being trusted through a type assertion.

The generated [API endpoint index](./API_ENDPOINTS.generated.md) is the route-presence contract and is checked against the Express sources in CI.

- Base URL (default): `http://localhost:4180`
- Content type: `application/json`
- Validation: query parameters on `/api/candles`, `/api/sparklines`, `/stream` and `/quotes` are validated with [zod](https://zod.dev); invalid HTTP input returns `400`, while invalid WebSocket input receives a typed error and closes.

## Trading auth

Public market data endpoints are open. Trading endpoints are closed.

Browser flow:

1. `POST /api/trade/session` with `{ "token": "<AUTH_TOKEN>" }`.
2. Server sets an HttpOnly `sbv2_session` cookie and returns `{ role, csrfToken }`.
3. Send `X-CSRF-Token: <csrfToken>` on mutating `/api/trade/*` requests.
4. Before connecting to `/trade-stream`, call `POST /api/trade/ws-ticket` and pass the returned one-time ticket as websocket subprotocol `sbv2.ticket.<base64url(ticket)>`.

Bearer `Authorization: Bearer <AUTH_TOKEN>` is still accepted for scripts and local automation, but the bundled frontend does not persist the admin token in web storage.

Roles are hierarchical:

| Role | Token | Can do |
| --- | --- | --- |
| `read-only` | `AUTH_READONLY_TOKEN` | View bots, live state, fills, logs, order journal, portfolio, and trade stream. |
| `paper-trade` | `AUTH_PAPER_TRADE_TOKEN` | Read-only plus create/start/stop/command paper bots and deliver price alerts. |
| `live-trade` | `AUTH_LIVE_TRADE_TOKEN` | Paper permissions plus start/stop/command live bots after admin arming. |
| `admin` | `AUTH_TOKEN` | Full access: keys, notification config, live arming, deletion, reset-state, audit log. |

Every mutating trade API call is written to `audit_log` with the session role, status code, target, and redacted request data. View recent events with `GET /api/trade/audit?limit=200` as admin.

## Shared types

### `Instrument`

Returned by `/api/catalog` and embedded in the `/api/candles` response.

| Field | Type | Notes |
| --- | --- | --- |
| `symbol` | `string` | e.g. `BTCUSDT` |
| `displayName` | `string` | e.g. `Bitcoin / Tether` |
| `assetClass` | `"crypto" \| "forex" \| "stock" \| "index"` | |
| `exchange` | `string` | Descriptive label, e.g. `Binance / Bybit` |
| `currency` | `string` | Quote currency, e.g. `USDT` |
| `provider` | `"binance" \| "synthetic"` | Data source used for the instrument |
| `basePrice` | `number` | Reference price used by the synthetic provider |
| `decimals` | `number` | Price precision |

### `Candle`

| Field | Type | Notes |
| --- | --- | --- |
| `time` | `number` | Bar open time (ms epoch) |
| `open` | `number` | |
| `high` | `number` | |
| `low` | `number` | |
| `close` | `number` | |
| `volume` | `number` | |
| `final` | `boolean` *(optional)* | Present when the bar is closed |
| `source` | `string` *(optional)* | Origin of the bar, e.g. `binance`, `bybit` |

### Timeframes

Valid values for any `timeframe` parameter:

```
1m  5m  15m  1h  4h  1d
```

### Chart types

Enumerated by `/api/catalog` (`chartTypes`):

```
candles  hollow  heikin  bars  line  step  area  baseline  renko
```

---

## Market REST endpoints

### `GET /api/health`

Liveness probe. Takes no parameters.

**Response `200`**

```json
{
  "ok": true,
  "service": "saltanatbotv2-backend",
  "ts": 1751932800000
}
```

```bash
curl http://localhost:4180/api/health
```

---

### `GET /api/catalog`

Returns the full instrument catalog plus the supported timeframes and chart types. Takes no parameters.

**Response `200`** (`CatalogResponse`)

| Field | Type |
| --- | --- |
| `instruments` | `Instrument[]` |
| `timeframes` | `Timeframe[]` |
| `chartTypes` | `ChartType[]` |

```json
{
  "instruments": [
    {
      "symbol": "BTCUSDT",
      "displayName": "Bitcoin / Tether",
      "assetClass": "crypto",
      "exchange": "Binance / Bybit",
      "currency": "USDT",
      "provider": "binance",
      "basePrice": 64000,
      "decimals": 2
    }
  ],
  "timeframes": ["1m", "5m", "15m", "1h", "4h", "1d"],
  "chartTypes": ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko"]
}
```

```bash
curl http://localhost:4180/api/catalog
```

---

### `GET /api/candles`

Fetches OHLCV candles for a single instrument.

**Query parameters**

| Param | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `symbol` | `string` | yes | — | min length 1; resolved case-insensitively against the catalog |
| `timeframe` | enum | no | `1m` | one of `1m,5m,15m,1h,4h,1d` |
| `limit` | integer | no | `320` | min `10`, max `1000` |
| `endTime` | integer | no | — | positive; ms epoch upper bound |
| `startTime` | integer | no | — | positive; ms epoch lower bound |
| `exchange` | enum | no | `binance` | `binance` or `bybit` |

The `exchange` parameter selects which crypto exchange (Binance or Bybit) supplies the candles for crypto symbols.

**Response `200`**

| Field | Type | Notes |
| --- | --- | --- |
| `instrument` | `Instrument` | Resolved instrument |
| `candles` | `Candle[]` | Ordered oldest → newest |
| `provider` | `string` | `source` of the last candle, or the router's provider name as fallback |
| `hasMore` | `boolean` | `true` when `candles.length >= limit` (paging hint for older history) |

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": <flattened zod error> }` | Query failed validation |
| `404` | `{ "error": "Unknown symbol: <symbol>" }` | Symbol not in catalog |

```json
{
  "instrument": {
    "symbol": "BTCUSDT",
    "displayName": "Bitcoin / Tether",
    "assetClass": "crypto",
    "exchange": "Binance / Bybit",
    "currency": "USDT",
    "provider": "binance",
    "basePrice": 64000,
    "decimals": 2
  },
  "candles": [
    { "time": 1751932740000, "open": 64010.1, "high": 64080.0, "low": 63990.5, "close": 64050.2, "volume": 12.34, "final": true, "source": "binance" }
  ],
  "provider": "binance",
  "hasMore": true
}
```

```bash
curl "http://localhost:4180/api/candles?symbol=BTCUSDT&timeframe=1h&limit=500&exchange=bybit"
```

---

### `GET /api/sparklines`

Returns compact close-price series for one or more symbols, suitable for sparkline previews.

**Query parameters**

| Param | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `symbols` | `string` | yes | — | min length 1; comma-separated list, trimmed, blanks dropped, capped at 40 symbols |
| `timeframe` | enum | no | `1h` | one of `1m,5m,15m,1h,4h,1d` |
| `points` | integer | no | `32` | min `2`, max `120` |
| `exchange` | enum | no | `binance` | `binance` or `bybit` |

**Response `200`**

| Field | Type | Notes |
| --- | --- | --- |
| `timeframe` | `Timeframe` | Echoes the requested timeframe |
| `series` | `object` | Map of `symbol` → series entry or `null` |

Each series entry (when the symbol resolves and data is fetched) has:

| Field | Type | Notes |
| --- | --- | --- |
| `last` | `number \| null` | Last close, or `null` if no closes |
| `changePct` | `number` | Percent change from first to last close (`0` when it cannot be computed) |
| `points` | `number[]` | Close prices, oldest → newest |

Unknown symbols and fetch failures map to `null` for that symbol.

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": <flattened zod error> }` | Query failed validation |

```json
{
  "timeframe": "1h",
  "series": {
    "BTCUSDT": { "last": 64050.2, "changePct": 1.42, "points": [63120.0, 63500.5, 64050.2] },
    "ETHUSDT": { "last": 3520.7, "changePct": -0.31, "points": [3531.0, 3510.2, 3520.7] },
    "FOOUSDT": null
  }
}
```

```bash
curl "http://localhost:4180/api/sparklines?symbols=BTCUSDT,ETHUSDT&timeframe=1h&points=48"
```

---

## Market WebSocket: `/stream`

Streams an initial snapshot followed by live candle and status updates for a single instrument. Connect with the same query parameters as `GET /api/candles` (validated by the identical schema): `symbol`, `timeframe`, `limit`, `endTime`, `startTime`, `exchange`.

```
ws://localhost:4180/stream?symbol=BTCUSDT&timeframe=1m&exchange=binance
```

On connect the server:

1. Validates the query. On failure it sends an `error` message and closes.
2. Resolves the symbol. If unknown, it sends an `error` message and closes.
3. Sends a `snapshot` message with the initial candles.
4. Subscribes to the provider and streams `candle` and `status` messages until the socket closes.

All messages are JSON objects with a `type` discriminator and a `ts` (ms epoch) field.

### `snapshot`

| Field | Type |
| --- | --- |
| `type` | `"snapshot"` |
| `symbol` | `string` |
| `timeframe` | `Timeframe` |
| `candles` | `Candle[]` |
| `provider` | `string` |
| `ts` | `number` |

```json
{
  "type": "snapshot",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "candles": [ { "time": 1751932740000, "open": 64010.1, "high": 64080.0, "low": 63990.5, "close": 64050.2, "volume": 12.34, "final": true, "source": "binance" } ],
  "provider": "binance",
  "ts": 1751932800000
}
```

### `candle`

Sent on each live candle update.

| Field | Type |
| --- | --- |
| `type` | `"candle"` |
| `symbol` | `string` |
| `timeframe` | `Timeframe` |
| `candle` | `Candle` |
| `provider` | `string` |
| `ts` | `number` |

```json
{
  "type": "candle",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "candle": { "time": 1751932800000, "open": 64050.2, "high": 64075.0, "low": 64040.0, "close": 64068.9, "volume": 3.1, "final": false, "source": "binance" },
  "provider": "binance",
  "ts": 1751932803000
}
```

### `status`

Connection/health status. `status` is `fallback` when the underlying message contains `"Fallback"`, otherwise `connected`.

| Field | Type |
| --- | --- |
| `type` | `"status"` |
| `status` | `"connected" \| "fallback"` |
| `provider` | `string` |
| `message` | `string` |
| `ts` | `number` |

```json
{ "type": "status", "status": "connected", "provider": "binance", "message": "Live", "ts": 1751932803000 }
```

### `error`

| Field | Type |
| --- | --- |
| `type` | `"error"` |
| `message` | `string` |
| `ts` | `number` |

```json
{ "type": "error", "message": "Unknown symbol: FOOUSDT", "ts": 1751932800000 }
```

> Note: the `MarketStatus` type also defines `"error"` as a possible status value, but the `/stream` endpoint only emits `connected` or `fallback` in `status` messages.

---

## Aggregated quote WebSocket: `/quotes`

The watchlist uses one browser connection instead of opening one connection per symbol. Query parameters match `GET /api/sparklines`: `symbols` (comma-separated, deduplicated and capped at 40), `timeframe`, `points` and `exchange`.

```
ws://localhost:4180/quotes?symbols=BTCUSDT,ETHUSDT&timeframe=1m&points=32&exchange=binance
```

The first `quotes_snapshot` message contains a nullable series map. Each subsequent `quote` replaces one symbol's series. `SparklineSeries` contains `last`, `changePct` and bounded `points`. All variants are validated by `parseQuoteStreamMessage` from `@saltanatbotv2/contracts`; malformed input is rejected by the frontend and activates its batched REST polling fallback.

```json
{
  "type": "quotes_snapshot",
  "timeframe": "1m",
  "series": { "BTCUSDT": { "last": 64050.2, "changePct": 0.8, "points": [63540.1, 64050.2] } },
  "provider": "binance",
  "ts": 1751932800000
}
```

```json
{
  "type": "quote",
  "symbol": "BTCUSDT",
  "timeframe": "1m",
  "series": { "last": 64068.9, "changePct": 0.83, "points": [63540.1, 64068.9] },
  "provider": "binance",
  "ts": 1751932803000
}
```

---

## Trading REST endpoints

All trading endpoints are mounted under `/api/trade`. A bot's `status` field in responses is computed live from the engine (`running` when the engine reports the bot as running, otherwise `stopped`).

### `BotConfig`

The core object accepted and returned by the bot endpoints.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | UUID; generated if omitted on create |
| `name` | `string` | Falls back to `strategyName` then `"Bot"` |
| `strategyName` | `string` | Defaults to `"Strategy"` |
| `ir` | `StrategyIR` | Compiled strategy intermediate representation (required) |
| `symbol` | `string` | Upper-cased on save (required) |
| `timeframe` | `Timeframe` | Required |
| `exchange` | `"paper" \| "binance" \| "bybit"` | Defaults to `paper` |
| `market` | `"spot" \| "futures"` | `spot` only when explicitly `"spot"`, otherwise `futures` |
| `sizeMode` | `"quote" \| "base" \| "equity_pct" \| "risk_pct"` | Defaults to `quote` |
| `sizeValue` | `number` | Defaults to `100` |
| `leverage` | `number` | Floored at `1` |
| `notifyMarkers` | `boolean` | Defaults to `false` |
| `status` | `"stopped" \| "running" \| "error"` | Live-computed in responses |
| `createdAt` | `number` | ms epoch; preserved across updates |
| `updatedAt` | `number` | ms epoch |

---

### `GET /api/trade/bots`

Lists all configured bots with live status.

**Response `200`**

```json
{ "bots": [ { "id": "…", "name": "Bot", "symbol": "BTCUSDT", "timeframe": "1m", "status": "stopped", "…": "…" } ] }
```

```bash
curl http://localhost:4180/api/trade/bots
```

---

### `POST /api/trade/bots`

Creates or upserts a bot. The request body is a partial `BotConfig`. If `id` matches an existing bot, its `createdAt` is preserved.

**Required body fields:** `symbol`, `timeframe`, `ir`. If any is missing the endpoint returns `400`.

| Body field | Type | Default |
| --- | --- | --- |
| `symbol` | `string` (required) | — |
| `timeframe` | `Timeframe` (required) | — |
| `ir` | `StrategyIR` (required) | — |
| `id` | `string` | new UUID |
| `name` | `string` | `strategyName` or `"Bot"` |
| `strategyName` | `string` | `"Strategy"` |
| `exchange` | `"paper" \| "binance" \| "bybit"` | `paper` |
| `market` | `"spot" \| "futures"` | `futures` |
| `sizeMode` | `"quote" \| "base" \| "equity_pct" \| "risk_pct"` | `quote` |
| `sizeValue` | `number` | `100` |
| `leverage` | `number` | `1` (floored at 1) |
| `notifyMarkers` | `boolean` | `false` |

**Response `200`**

```json
{ "bot": { "id": "…", "symbol": "BTCUSDT", "timeframe": "1m", "status": "stopped", "…": "…" } }
```

**Error `400`**

```json
{ "error": "symbol, timeframe and ir are required" }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","timeframe":"1m","ir":{},"exchange":"paper","sizeMode":"quote","sizeValue":100}'
```

---

### `DELETE /api/trade/bots/:id`

Stops the bot (if running) and deletes it.

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X DELETE http://localhost:4180/api/trade/bots/<bot-id>
```

---

### `POST /api/trade/bots/:id/start`

Starts the bot's strategy engine.

**Response `200`**

```json
{ "ok": true, "bot": { "id": "…", "status": "running", "…": "…" } }
```

**Error responses**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{ "error": "Bot not found" }` | No bot with that id |
| `400` | `{ "error": "<reason>" }` | Engine failed to start (message from the thrown error, or `"Failed to start"`) |

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/start
```

---

### `POST /api/trade/bots/:id/stop`

Stops the bot's engine. Always returns success.

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/stop
```

---

### `POST /api/trade/bots/:id/command`

Runs a manual command string against the bot's exchange adapter (e.g. an order instruction).

**Body**

| Field | Type | Required |
| --- | --- | --- |
| `command` | `string` | yes |

**Response `200`** — the engine's `ExecResult`:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | `boolean` | |
| `message` | `string` | |
| `fills` | `FillRecord[]` | |
| `order` | `OrderRecord` *(optional)* | |
| `orders` | `PendingOrder[]` *(optional)* | |
| `position` | `PositionState \| null` *(optional)* | |
| `account` | `AccountState` *(optional)* | |
| `data` | `unknown` *(optional)* | Free-form payload for `get`-style commands |

**Error `400`**

```json
{ "error": "command is required" }
```

```bash
curl -X POST http://localhost:4180/api/trade/bots/<bot-id>/command \
  -H "Content-Type: application/json" \
  -d '{"command":"open buy 100"}'
```

---

### `GET /api/trade/bots/:id/fills`

Returns up to the 200 most recent fills for the bot.

**Response `200`** — `{ "fills": FillRecord[] }`

`FillRecord`:

| Field | Type |
| --- | --- |
| `id` | `string` |
| `botId` | `string` |
| `symbol` | `string` |
| `side` | `"buy" \| "sell"` |
| `qty` | `number` |
| `price` | `number` |
| `fee` | `number` |
| `realizedPnl` | `number` |
| `kind` | `"open" \| "close"` |
| `reason` | `string` |
| `ts` | `number` |

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/fills
```

---

### `GET /api/trade/bots/:id/logs`

Returns up to the 200 most recent log entries for the bot.

**Response `200`** — `{ "logs": [ … ] }`

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/logs
```

---

### `GET /api/trade/bots/:id/live`

Returns the bot's live account/position/price state from the engine, or `{ "price": 0 }` when no live state is available.

**Response `200`**

```json
{ "price": 64050.2 }
```

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/live
```

---

### `GET /api/trade/bots/:id/orders`

Returns the resting/open orders known to the engine for the bot.

**Response `200`** — `{ "orders": PendingOrder[] }`

`PendingOrder`:

| Field | Type |
| --- | --- |
| `id` | `string` |
| `clientId` | `string` *(optional)* |
| `symbol` | `string` |
| `side` | `"buy" \| "sell"` |
| `type` | `"market" \| "limit" \| "stop_market" \| "stop_limit" \| "tp_market" \| "tp_limit"` |
| `qty` | `number` |
| `price` | `number` *(optional)* |
| `trgPrice` | `number` *(optional)* |
| `reduceOnly` | `boolean` |
| `tif` | `"GTC" \| "IOC" \| "FOK"` |
| `createdAt` | `number` |

```bash
curl http://localhost:4180/api/trade/bots/<bot-id>/orders
```

---

### `GET /api/trade/keys`

Reports whether API keys are stored for each exchange. Keys themselves are never returned.

**Response `200`**

```json
{ "binance": true, "bybit": false }
```

```bash
curl http://localhost:4180/api/trade/keys
```

---

### `POST /api/trade/keys`

Stores (encrypted) API credentials for an exchange.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `exchange` | `"binance" \| "bybit"` | yes | Any other value returns `400` |
| `apiKey` | `string` | no | Stored as empty string if omitted |
| `apiSecret` | `string` | no | Stored as empty string if omitted |

**Response `200`**

```json
{ "ok": true }
```

**Error `400`**

```json
{ "error": "exchange must be binance or bybit" }
```

```bash
curl -X POST http://localhost:4180/api/trade/keys \
  -H "Content-Type: application/json" \
  -d '{"exchange":"binance","apiKey":"<key>","apiSecret":"<secret>"}'
```

---

### `GET /api/trade/notify`

Returns the current notification configuration. Tokens are never returned in plaintext; only a `hasToken` boolean is exposed.

**Response `200`**

```json
{
  "telegram": { "enabled": false, "chatId": "", "hasToken": false },
  "vk": { "enabled": false, "peerId": "", "hasToken": false }
}
```

```bash
curl http://localhost:4180/api/trade/notify
```

---

### `POST /api/trade/notify`

Updates notification configuration. Any omitted field keeps its current value; a blank `token` also keeps the existing token.

**Body** (`Partial<NotifyConfig>`)

| Field | Type |
| --- | --- |
| `telegram.enabled` | `boolean` |
| `telegram.token` | `string` |
| `telegram.chatId` | `string` |
| `vk.enabled` | `boolean` |
| `vk.token` | `string` |
| `vk.peerId` | `string` |

**Response `200`**

```json
{ "ok": true }
```

```bash
curl -X POST http://localhost:4180/api/trade/notify \
  -H "Content-Type: application/json" \
  -d '{"telegram":{"enabled":true,"chatId":"123456","token":"<token>"}}'
```

---

### `POST /api/trade/notify/test`

Sends a test notification through the configured channels and returns the result.

**Response `200`** — result of the notification attempt.

```bash
curl -X POST http://localhost:4180/api/trade/notify/test
```

---

## Trading WebSocket: `/trade-stream`

A broadcast-only WebSocket that pushes every `TradeEvent` emitted by the trading engine to all connected clients. It takes no query parameters and rejects token-in-URL auth. Browser clients first request a short-lived one-time ticket:

```
POST /api/trade/ws-ticket
X-CSRF-Token: <csrfToken>
Cookie: sbv2_session=...

→ { "ticket": "...", "expiresAt": 1751932800000 }
```

Then connect with a websocket subprotocol:

```
ws://localhost:4180/trade-stream
Sec-WebSocket-Protocol: sbv2.ticket.<base64url(ticket)>
```

Each message is a JSON-serialized `TradeEvent` produced by the engine (fills, order updates, log lines, and status changes for running bots). Clients are tracked server-side and removed automatically on socket close or error.

```bash
# Script fallback using the admin token subprotocol still works.
TOKEN="<AUTH_TOKEN>"
PROTO="sbv2.auth.$(printf '%s' "$TOKEN" | base64 | tr '+/' '-_' | tr -d '=')"
websocat -H "Sec-WebSocket-Protocol: $PROTO" ws://localhost:4180/trade-stream
```

---

## See also

- [Project README](../README.md)
- [Architecture overview](./ARCHITECTURE.md)
- [Trading engine guide](./TRADING.md)
- [Strategy reference](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
