# Architecture

SaltanatbotV2 is an open-source crypto trading terminal built as an npm-workspaces monorepo. The Express 5 + `ws` backend proxies public market data and drives a persisted trading engine; the React 18 + Vite 8 frontend renders a custom canvas chart and Blockly strategy builder; shared workspaces own canonical transport and strategy contracts. Market data is normalized behind a `ProviderRouter`, and strategies compile to a shared intermediate representation (IR).

## Monorepo layout

The repository is a private npm workspace root that owns two applications and incremental shared packages:

| Package | Name | Location | Role |
| --- | --- | --- | --- |
| Root | `saltanatbotv2` | `/` | Workspace host + orchestration scripts |
| Backend | `@saltanatbotv2/backend` | `backend/` | HTTP + WebSocket server, market providers, trading engine |
| Frontend | `@saltanatbotv2/frontend` | `frontend/` | React SPA, canvas chart engine, strategy lab |
| Contracts | `@saltanatbotv2/contracts` | `packages/contracts/` | Canonical market and WebSocket types |
| Strategy core | `@saltanatbotv2/strategy-core` | `packages/strategy-core/` | Canonical IR types, version and shared runtime primitives |
| Backtest core | `@saltanatbotv2/backtest-core` | `packages/backtest-core/` | Broker, portfolio, warm-up, metrics, provenance and traces |
| Execution core | `@saltanatbotv2/execution-core` | `packages/execution-core/` | Canonical sizing, slippage, protection and durable order-state rules |
| Pine compiler | `@saltanatbotv2/pine-compiler` | `packages/pine-compiler/` | Lexer, parser, semantic analysis, lowering and diagnostics |
| Test fixtures | `@saltanatbotv2/test-fixtures` | `packages/test-fixtures/` | Deterministic candles and scripted Fetch responses for all tiers |

The root `package.json` declares the workspaces and the scripts that fan out into them:

```json
{
  "name": "saltanatbotv2",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "backend", "frontend"],
  "scripts": {
    "dev": "concurrently -n backend,frontend -c cyan,green \"PORT=4181 npm --workspace backend run dev\" \"npm --workspace frontend run dev -- --host 0.0.0.0\"",
    "build": "npm --workspaces run build",
    "start": "npm --workspace backend run start",
    "check": "npm --workspaces run check"
  }
}
```

| Root script | What it does |
| --- | --- |
| `npm run dev` | Runs backend on `4181` (`tsx watch`) and frontend on `4180` (`vite`) together via `concurrently` |
| `npm run build` | Builds every workspace with a build script (`tsc` backend, `tsc -b && vite build` frontend) |
| `npm start` | Starts the compiled backend (`node dist/server.js`), which also serves the built frontend |
| `npm run check` | Type-checks both workspaces without emitting |

Both workspaces are ESM (`"type": "module"`) and TypeScript 5.8.

## Backend (`@saltanatbotv2/backend`)

The backend is an Express 5 application fronted by a Node `http` server so that HTTP and WebSocket traffic share a single port. It depends only on `cors`, `express`, `ws`, and `zod` at runtime — market-data providers and persistence use built-in Node modules rather than third-party SDKs.

Key pieces wired up in `backend/src/server.ts`:

- **HTTP + WebSocket on one port** — `createServer(app)` plus a `WebSocketServer({ noServer: true })`. The server's `upgrade` handler dispatches on the URL path: `/stream` goes to the market-data socket server, `/trade-stream` goes to the trading API's socket server, and anything else is destroyed.
- **REST endpoints** — `GET /api/health`, `GET /api/catalog`, `GET /api/candles`, `GET /api/sparklines`, plus the trading router mounted at `/api/trade`.
- **Validation** — every query is parsed with `zod` (e.g. `candleQuery` enforces `symbol`, an enum `timeframe`, a `limit` clamped to `10..1000`, and an `exchange` enum of `binance | bybit` defaulting to `binance`).
- **Static hosting** — after the API routes, `express.static` serves `../../frontend/dist` and a catch-all route (`app.get(/.*/, ...)`) returns `index.html` so the SPA can deep-link.
- **Configuration** — `PORT` (default `4180`) and `HOST` (default `127.0.0.1`) come from the environment. A wider bind must be explicitly requested.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` stop Telegram control, call `trading.engine.shutdown()` so desired bot state remains resumable, and close the server.

### Persistence and secrets

The trading tier persists to disk using Node's **built-in** `node:sqlite` (`DatabaseSync`) in `backend/src/trading/store.ts` — there is no external database driver. Exchange API credentials are encrypted at rest with `node:crypto` using **AES-256-GCM**: `createCipheriv("aes-256-gcm", …)` / `createDecipheriv("aes-256-gcm", …)`, with the 32-byte key derived via `scryptSync`. Identifiers throughout the engine use `randomUUID()` from `node:crypto`.

### Backend source tree

```text
backend/src/
├── server.ts                 # Express app, WS upgrade routing, static SPA hosting
├── types.ts                  # Instrument, Candle, StreamMessage, CatalogResponse
├── market/
│   ├── catalog.ts            # Instrument catalog + findInstrument/getCatalog
│   └── timeframes.ts         # Timeframe tables + Binance/Bybit interval maps, alignTime
├── providers/
│   ├── provider.ts           # MarketProvider / MarketSubscription / CandleRange interfaces
│   ├── router.ts             # ProviderRouter — routing, fallback, caching
│   ├── binance.ts            # Binance public REST klines + WS kline stream
│   ├── bybit.ts              # Bybit v5 public spot REST + WS kline stream
│   ├── synthetic.ts          # Deterministic synthetic OHLCV feed
│   └── cache.ts              # CandleCache — TTL/LRU window cache
└── trading/
    ├── routes.ts             # /api/trade router + /trade-stream WebSocketServer
    ├── engine.ts             # TradingEngine — live bar evaluation & order management
    ├── engineRisk.ts         # Pure sizing and stop/target resolution
    ├── orderLifecycle.ts     # Durable intent/result/fill state transitions
    ├── orderPolling.ts       # Bounded private REST status fallback
    ├── reconciliation.ts     # Resume-time exchange/runtime comparison
    ├── commands.ts           # Notification/command parsing helpers
    ├── notifications.ts      # Outbound notifications
    ├── store.ts              # node:sqlite persistence + AES-256-GCM key storage
    ├── types.ts              # BotConfig, ExchangeAdapter, account/position types
    ├── exchange/             # paper / binance / bybit execution adapters
    └── strategy/             # Backend evaluator plus facades over shared IR and TA
```

## Frontend (`@saltanatbotv2/frontend`)

The frontend is a React 18 single-page app built with Vite 8. Its notable dependencies are `blockly` (visual strategy builder), `lucide-react` (icons), and `react`/`react-dom`. There is no third-party charting library — charts are drawn by a hand-written engine.

`frontend/src/App.tsx` is the workspace composition root. It retains selected market/chart routing state and switches between `chart`, `strategy`, and `trade`. `frontend/src/app/useAppShell.ts` owns cross-workspace preferences, panels, exchange, named workspaces and compare overlays; `useAppCommands.ts` owns commands and global shortcuts.

- **Custom canvas chart engine** — `frontend/src/chart/ChartEngine.ts` prepares one viewport/indicator render plan consumed by five cached canvases: background/axes, primary series, indicators, drawing/strategy overlays, and pointer interaction. `useChartRenderer` owns sizing and dirty invalidation, while a coalescing scheduler preserves pass order. Supporting modules handle viewport/scales, Heikin-Ashi transforms, indicator math, chrome and drawing objects. The chart supports `candles`, `heikin`, `bars`, `line`, `area`, `baseline`, and `renko`.
- **Blockly strategy builder** — the Strategy Lab (`frontend/src/strategy/`) uses Blockly blocks that compile to the shared strategy IR (`compileArtifact.ts` → `compile.ts` → `ir.ts`) and runs a backtest (`backtest.ts`) against the current candle window.
- **Lazy-loaded views** — the heavier `StrategyLab` and `TradingView` views are code-split with `React.lazy` and rendered inside `<Suspense>`. Shell and command controllers warm those chunks ahead of likely navigation.
- **Runtime exchange selector** — for crypto instruments the user can pick `binance` or `bybit`; the choice is persisted in `localStorage` (`mf:cryptoExchange`) and threaded through candle/sparkline/stream requests.
- **Command palette + hotkeys** — `⌘/Ctrl-K` toggles a command palette; number keys `1..6` select timeframes.
- **Local workspace persistence** — indicators, the strategy library, theme, and panel state are stored in `localStorage`; a strategy can be imported from a `#s=…` URL hash as a remixable copy.

### Frontend source tree

```text
frontend/src/
├── App.tsx                   # Workspace composition and market routing state
├── app/                      # Shell preferences, workspaces, commands and storage migration
├── types.ts                  # Instrument, Candle, StreamMessage, DataExchange, ...
├── api/
│   └── marketClient.ts       # REST helpers + createMarketSocket (WebSocket URL)
├── hooks/
│   ├── useCatalog.ts         # Loads /api/catalog
│   ├── useMarketStream.ts    # Snapshot + live stream, history paging, latency
│   └── useSparklines.ts      # Watchlist sparkline series
├── components/               # Shell UI plus ChartCanvas and its semantic ChartDataPanel fallback
├── chart/                    # Canvas ChartEngine, renderers, indicators, drawings
├── strategy/                 # Blockly blocks, shared IR, compiler, backtester, library
├── trading/                  # TradingView (lazy) client
└── styles/                   # CSS (theme variables)
```

The five Canvas render passes are visual acceleration, not the sole data representation. `ChartDataPanel` supplies a keyboard-operable, browser-readable DOM alternative with native tables for focused/recent OHLC, strategy signals and trades. The visual chart references its synchronized text summary with `aria-describedby`; the fallback stays available regardless of experimental HTML-in-Canvas support.

## Market-data layer

All market data flows through `ProviderRouter` (`backend/src/providers/router.ts`), which implements the same `MarketProvider` interface as the concrete providers and composes three of them plus a cache:

```text
                       ┌──────────────────────────────┐
   getCandles /        │        ProviderRouter        │
   subscribe   ─────►  │  (implements MarketProvider)  │
                       │                                │
                       │  primary(instrument, exchange) │
                       └───────────────┬───────────────┘
                                       │
        instrument.provider === "binance" ?          else
                   │                                    │
        exchange === "bybit" ?                          ▼
           │            │                       ┌───────────────┐
           ▼            ▼                        │  Synthetic    │
    ┌───────────┐ ┌───────────┐                 │  (forex /     │
    │  Bybit    │ │  Binance  │                 │  stock /      │
    │  public   │ │  public   │                 │  index)       │
    └───────────┘ └───────────┘                 └───────────────┘
```

### Routing rules

The routing decision lives in `ProviderRouter.primary`:

| Instrument | `exchange` param | Provider used |
| --- | --- | --- |
| `provider === "binance"` (crypto) | `binance` (default) | `BinanceProvider` |
| `provider === "binance"` (crypto) | `bybit` | `BybitProvider` |
| `provider === "synthetic"` (forex/stock/index) | *(ignored)* | `SyntheticProvider` |

The `exchange` value is the **runtime exchange selector**: it only takes effect for crypto instruments (all catalog crypto pairs carry `provider: "binance"` and `exchange: "Binance / Bybit"`), letting the user flip the same `BTCUSDT` chart between Binance and Bybit live data. Non-crypto instruments in the catalog are marked `provider: "synthetic"` and always resolve to the synthetic feed regardless of the `exchange` parameter.

### Providers

| Provider | Source | REST endpoint | WebSocket |
| --- | --- | --- | --- |
| `BinanceProvider` | Binance public | `GET api.binance.com/api/v3/klines` | `stream.binance.com:9443/ws/<symbol>@kline_<interval>` |
| `BybitProvider` | Bybit v5 public spot | `GET api.bybit.com/v5/market/kline?category=spot` | `stream.bybit.com/v5/public/spot`, topic `kline.<interval>.<symbol>` |
| `SyntheticProvider` | In-process generator | *(none)* | 1 Hz `setInterval` forming-bar ticks |

Notes grounded in the code:

- **No API keys** for market data — both Binance and Bybit use public REST + public WebSocket. Timeframes are mapped per exchange in `market/timeframes.ts` (`binanceIntervals`, `bybitIntervals`; e.g. Bybit uses `"60"` for `1h` and `"D"` for `1d`).
- **Bybit normalization** — Bybit returns klines newest-first, so `BybitProvider` reverses them to ascending time; it also sends periodic `{ op: "ping" }` heartbeats every 20 s over its WebSocket.
- **Synthetic feed is deterministic** — closed bars are a pure function of the bar index (fractal value-noise random walk anchored on `instrument.basePrice`), so paginating into history always returns identical bars. Only the currently forming bar wiggles live around its deterministic anchor.
- **Fallback** — if the primary provider throws in `getCandles`, the router silently falls back to synthetic candles tagged with a `source` of `Fallback after <error>`. On `subscribe` failure it reports a status message containing `Fallback stream: …` and streams synthetic ticks. The server maps a message containing `"Fallback"` to a `status: "fallback"` stream event.

### Candle cache

`CandleCache` (`backend/src/providers/cache.ts`) is a TTL + LRU cache keyed by `source:symbol:timeframe:limit:endTime:startTime`. Windows that include the forming bar get a short **2 s** TTL so live data stays fresh; historical windows (an `endTime` strictly in the past) are treated as immutable and cached for **10 minutes**. The store is bounded to **512** entries, evicting the oldest on overflow, and reordering entries on access to approximate LRU.

## Shared strategy IR

Strategies are not stored as executable code — they compile to a typed **intermediate representation** that both tiers understand. Canonical IR declarations, evaluator, intent types, security-series alignment and TA live in `packages/strategy-core`. Slippage, protection-price resolution, sizing and monotonic order-state semantics live in `packages/execution-core`. Historical fills, portfolio accounting, warm-up, reporting contracts, metrics and chart/external candle-source provenance live in `packages/backtest-core`. Frontend and backend strategy files retain narrow compatibility facades.

This is what lets a strategy backtested in the browser be executed identically on the server for live trading. The IR is a small algebra of numeric expressions, boolean expressions, and statements:

```ts
export interface StrategyIR {
  name: string;
  inputs: StrategyInput[];   // named numeric parameters
  body: Stmt[];
}
```

| Category | Kinds (`.k`) |
| --- | --- |
| `NumExpr` | `num`, `input`, `var`, `price`, `ma` (sma/ema/wma/vwma), `rsi`, `bollinger`, `macd`, `atr`, `stdev`, `extreme`, `change`, `stoch`, `wpr`, `cci`, `roc`, `minmax`, `arith`, `unary` |
| `BoolExpr` | `bool`, `compare`, `logic`, `not`, `cross`, `trend`, `between`, `session`, `dayofweek` |
| `Stmt` | `entry`, `exit`, `stop`, `target`, `trail`, `size`, `setvar`, `alert`, `plot`, `marker`, `if` |

The frontend backtest facade delegates trading bars to the reusable `strategy-core` runtime. Its execution adapter composes the pure `backtest-core` broker and portfolio functions, then delegates measured-range, metrics, trace and provenance assembly to `backtest-core/report.ts`. Every report records sources for chart and `request.security` candles. The backend live engine uses the same evaluator through its compatibility facade. `strategy/backtest/preview.ts` executes display-only statements itself but evaluates all numeric and boolean expressions through the core runtime. Stateful cross-runtime parity fixtures protect these adapters.

## Request and data flow

Two transports connect the SPA to the backend, both over the same origin/port:

- **REST** (`fetch`) for the catalog, initial/historical candle windows, and sparklines. Requests are same-origin relative paths (`/api/...`).
- **WebSocket** for live streaming. `createMarketSocket` builds `ws(s)://<host>/stream?symbol&timeframe&limit=1000&exchange`, choosing `wss` when the page is served over HTTPS.

### End-to-end diagram

```text
 ┌───────────────────────── Frontend (React + Vite) ─────────────────────────┐
 │                                                                            │
 │  useCatalog ──────GET /api/catalog───────────────┐                         │
 │  useSparklines ───GET /api/sparklines?symbols… ──┤                         │
 │  useMarketStream                                 │                         │
 │     │  (1) initial:   WS /stream?symbol&tf&exch  │                         │
 │     │  (2) history:   GET /api/candles?…endTime  │                         │
 │     ▼                                            ▼                         │
 └─────┼────────────────────────────────────────────┼────────────────────────┘
       │ REST (fetch)                    WebSocket   │ REST (fetch)
       ▼                                             ▼
 ┌────────────────────────── Backend (Express 5 + ws) ───────────────────────┐
 │  /api/catalog  /api/candles  /api/sparklines      server "upgrade"         │
 │        │             │              │              ├── /stream ──► market  │
 │        │             │              │              └── /trade-stream ─►     │
 │        ▼             ▼              ▼                     trading engine    │
 │                 ProviderRouter (cache → primary → synthetic fallback)      │
 │                        │                                                   │
 └────────────────────────┼───────────────────────────────────────────────────┘
                          ▼
             Binance / Bybit public API   ·   Synthetic generator
```

### Live stream lifecycle

On a `/stream` WebSocket connection (`server.ts`), the backend:

1. Validates the query with the same `candleQuery` zod schema used by REST.
2. Resolves the `Instrument` via `findInstrument`; on failure it sends an `error` message and closes.
3. Fetches an initial window with `provider.getCandles(...)` and sends a **`snapshot`** message.
4. Calls `provider.subscribe(...)`, forwarding each live bar as a **`candle`** message and provider status changes as **`status`** messages (`connected` / `fallback`).
5. Closes the underlying market subscription when the client socket closes.

`useMarketStream` on the client applies the snapshot, merges each live `candle` (replacing the last bar when times match, otherwise appending into a bounded ring so lazily-loaded history survives new bars), tracks connection state, derives a `latencyMs` from the message `ts`, and exposes `loadOlder()` which pages further into history via `GET /api/candles` using `endTime`. The stream message union is:

| `type` | Payload | Meaning |
| --- | --- | --- |
| `snapshot` | `candles[]`, `provider`, `ts` | Initial window on connect |
| `candle` | `candle`, `provider`, `ts` | A new or updated live bar |
| `status` | `status`, `provider`, `message`, `ts` | Connection / fallback status |
| `error` | `message`, `ts` | Bad query or unknown symbol |

The `/api/candles` response additionally returns a `hasMore` flag (true when a full page was returned) as a paging hint, and reports the effective `provider` from the last candle's `source`.

## See also

- [README](../README.md)
- [API reference](./API.md)
- [Trading engine](./TRADING.md)
- [Strategies & IR](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
