# Architecture

The cross-store authority boundary and single-executor constraint are normative in
[ADR 0001](adr/0001-execution-authority-and-system-of-record.md).

SaltanatbotV2 is an open-source crypto trading terminal built as an npm-workspaces monorepo. The Express 5 + `ws` backend proxies public market data, runs a read-only arbitrage research hub and drives a persisted trading engine; the React 18 + Vite 8 frontend renders a custom canvas chart, arbitrage screener and Blockly strategy builder; shared workspaces own canonical transport and strategy contracts. Candle data is normalized behind a `ProviderRouter`, arbitrage quotes behind venue-specific public adapters, and strategies compile to a shared intermediate representation (IR).

## Monorepo layout

The repository is a private npm workspace root that owns two applications and incremental shared packages:

| Package | Name | Location | Role |
| --- | --- | --- | --- |
| Root | `saltanatbotv2` | `/` | Workspace host + orchestration scripts |
| Backend | `@saltanatbotv2/backend` | `backend/` | HTTP + WebSocket server, market providers, trading engine |
| Frontend | `@saltanatbotv2/frontend` | `frontend/` | React SPA, canvas chart engine, strategy lab |
| Contracts | `@saltanatbotv2/contracts` | `packages/contracts/` | Canonical market REST/WS types and runtime parsers |
| Strategy core | `@saltanatbotv2/strategy-core` | `packages/strategy-core/` | Canonical IR types, version and shared runtime primitives |
| Backtest core | `@saltanatbotv2/backtest-core` | `packages/backtest-core/` | Broker, portfolio, warm-up, metrics, provenance and traces |
| Execution core | `@saltanatbotv2/execution-core` | `packages/execution-core/` | Canonical sizing, slippage, protection and durable order-state rules |
| Plugin core | `@saltanatbotv2/plugin-core` | `packages/plugin-core/` | Strict declarative envelope, permissions, integrity, ECDSA signatures and dependency validation |
| Pine compiler | `@saltanatbotv2/pine-compiler` | `packages/pine-compiler/` | Lexer, parser, semantic analysis, lowering and diagnostics |
| Test fixtures | `@saltanatbotv2/test-fixtures` | `packages/test-fixtures/` | Deterministic candles and scripted Fetch responses for all tiers |
| Arbitrage SDK | `@saltanatbotv2/arbitrage-sdk` | `packages/arbitrage-sdk/` | Generated transport-safe client, public venue/registry types and runtime validation |

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
| `npm run build` | Builds every workspace; the frontend type-checks, builds to unique staging, verifies PWA/budgets, then atomically publishes into live `dist` |
| `npm start` | Starts the compiled backend (`node dist/server.js`), which also serves the built frontend |
| `npm run check` | Type-checks every workspace that exposes a `check` script without emitting |

Application and shared-package workspaces are ESM (`"type": "module"`) and TypeScript 5.8.

## Backend (`@saltanatbotv2/backend`)

The backend is an Express 5 application fronted by a Node `http` server so that HTTP and WebSocket
traffic share one port. Runtime dependencies include `pg`, `cors`, `express`, `ws` and `zod`; market
providers and legacy trading persistence continue to use built-in Node modules rather than exchange
SDKs.

Key pieces wired up in `backend/src/server.ts`:

- **HTTP + WebSocket on one port** — `createServer(app)` plus separate no-server WebSocket hubs. In
  database mode every application REST/WS route requires an active account; `/trade-stream` also
  consumes a session-bound one-time ticket. Every unknown upgrade path is destroyed.
- **REST endpoints** — health/catalog/instruments/venue capabilities, candles/sparklines, bounded
  read-only public venue data, basis/triangular/native-spread/pairwise arbitrage research and the
  authenticated onboarding, workspace, research-job and trading routers.
- **Admission and operational state** — API metrics and one process-wide admission controller run
  before route registration. Only cheap liveness bypasses admission; dependency-heavy readiness
  uses the bounded ordinary lane and then a separate bounded per-IP limiter. Accepted overlapping
  readiness calls share one process-wide dependency evaluation, and its result has a short typed
  TTL to impose an absolute probe-rate cap; rejected evaluations are retried rather than cached.
  Authentication and stop/cancel/kill controls use reserved capacity, while ordinary requests share
  a bounded FIFO queue. The public no-store readiness probe returns only categorical component
  states; exact migration/checksum, PostgreSQL latency, worker age/state, disk and admission
  measurements are exposed only through the administrator router, including readiness-limiter
  bounds and counters. Migration and worker-heartbeat queries run sequentially, and the supported
  PostgreSQL pool minimum of two leaves a connection beside the readiness probe.
- **Validation** — route inputs are parsed with bounded schemas (for example, `candleQuery` checks
  symbol, timeframe, page size, venue, market type and price type); shared public payloads have
  runtime parsers at the client boundary as well. Public upstream HTTP bodies are byte-limited while
  streaming, exchange WebSocket clients have explicit payload ceilings, and inbound application
  sockets accept at most 64 KiB per message.
- **Static hosting** — before identity storage or a listener opens, the API validates the frozen runtime configuration's frontend distribution. Local source runs default to the repository `frontend/dist`; direct-host production pins `FRONTEND_DIST_DIR` to one exact protected release generation. The directory, shell, service worker and local module entries must be real, bounded files. After the API routes, `express.static` serves only that validated directory and a catch-all returns its `index.html` so the SPA can deep-link. Candidate builds may still use atomic publication inside their own staging generation, but a build in the checkout cannot replace the UI of an API pinned to a separate release slot. Shell metadata and the worker revalidate; content-hashed Vite assets are immutable.
- **Configuration** — `PORT` (default `4180`) and `HOST` (default `127.0.0.1`) come from the environment. A wider bind must be explicitly requested.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` stop Telegram control and quiesce new trading
  submissions before closing the HTTP server. The R4 executor bridge first drains active callbacks,
  requests abort after the bounded deadline and performs one final bounded drain. Only after every
  callback settles may the engine persist resumable desired state and SQLite close. If a callback
  ignores abort and remains active, shutdown fails closed and deliberately refuses both
  `engine.shutdown()` and store close rather than racing an in-flight mutation.

### Persistence and secrets

PostgreSQL stores users, Argon2id password hashes, revocable sessions, one-use WebSocket tickets,
authentication audit events, owner-scoped onboarding/workspace revisions, durable research jobs,
the current research-worker heartbeat and, in the R4 candidate, the fenced executor-command queue.
Checked-in migrations run atomically under an advisory lock and refuse checksum drift.

The trading executor still uses built-in **`node:sqlite`** (`DatabaseSync`) in
`backend/src/trading/store.ts`. Accounts, credentials, bots and journals are owner-scoped; exchange
credentials are AES-256-GCM encrypted with a key derived by `scryptSync`. PostgreSQL authorization
revisions and SQLite account/credential/arm revisions are joined only through short-lived internal
execution permits, never through an unsafe dual write. R4 paper mutations instead cross a durable
PostgreSQL command plus an executor-owned SQLite receipt. The command is bound to owner, active
session hash, authorization revision/epoch, target, request hash and idempotency key; a renewable
lease token/generation fences apply and acknowledgement. A receipt committed with the SQLite
mutation makes recovery after a lost PostgreSQL acknowledgement idempotent. Each exact signed
exchange request crosses a mandatory fail-closed transport gate before timestamping, HMAC and
network I/O. CPU-heavy backtests are claimed fairly from PostgreSQL and run by a separate supervisor
in bounded worker threads; the API process never executes them synchronously. Queue telemetry uses
a bounded 24-hour/10,000-row
terminal sample and exposes only owner-scoped metrics to HTTP clients. Accepted production remains
on PostgreSQL schema v11 while R4 is under review; the current R4 candidate's latest schema is v12:
v7 adds an owner-scoped prepared-step replay ledger, v8 adds bounded terminal-job artifact
retention, v9 adds the administrator control plane, v10 adds bounded versioned workspace workflow,
v11 adds owner onboarding plus runtime-component heartbeats, and v12 adds the durable executor
queue. Trading SQLite schema 9 adds canonical owner-scoped paper portfolios, monotonic ledger
epochs, fixed capital reservations, mutation receipts, immutable robot-revision evidence, durable
valuation marks and append-only portfolio events. Existing accounts are seeded with
dismissed onboarding state; future accounts remain virtual revision-0 until their first onboarding
mutation. A stable per-step `intentId` is checked against
the exact permit-binding digest, compact keys are durable and owner-capped, and non-secret
reservation metadata has bounded retention. It provides durable at-most-once network admission, not
proof that an exchange accepted an order; unknown outcomes still require venue idempotency and
reconciliation. `ExecutionAuthority` reserves before permit handoff and consumes before its signed
network callback in the future boundary implementation. This is integrated and tested, but the
production factory is intentionally not called by routes or adapters. Production call sites remain
deny-only and the pre-HTTPS configuration loader rejects `private-live`, so that boundary is
unreachable in the current release.

Canonical paper projections are versioned as `paper-portfolio-v1` with `paper-metrics-v1` formulas.
The singleton executor rebuilds them only from exact robot-revision evidence, paper ledgers, capital
reservations and current durable valuation marks. Missing/expired market evidence remains
`unavailable`/`stale`; borrowing is not modeled. Portfolio reset closes one epoch and creates the
next without deleting prior journals. See [Canonical paper portfolios](./PAPER_PORTFOLIOS.md).

### Recovery boundary

Root recovery commands create one checksummed generation containing a PostgreSQL custom dump from
an exported read-only snapshot plus the existing verified SQLite runtime backup. The manifest binds
the release/profile, capture window, complete migration chain, PostgreSQL row counts (including
onboarding), runtime file digests/user versions and a cross-store owner-set checksum. Verification
does not mutate either store. The schema-12/schema-9 candidate extends that bounded inventory with
the PostgreSQL `executor_commands` count and counts for every canonical SQLite paper-portfolio
table; verification and replacement restore compare those counts with the manifest. That
implementation evidence does not accept R4 by itself: the exact candidate must still pass the real
isolated paired restore/rollback drill.

Restore and drill operate only on a new database name and a separate absent/empty data directory.
Database creation is tagged with a generation/operation marker and its OID; cleanup refuses to drop
anything whose identity no longer matches. Paths reject symbolic-link components and are pinned
into tool-owned private staging before restore to close source/target replacement races. Successful
restore performs no service, Compose, `PGDATABASE` or active-path cutover; the drill removes only
the verified temporary resources.

### Backend source tree

```text
backend/src/
├── server.ts                 # Express app, WS upgrade routing, static SPA hosting
├── types.ts                  # Instrument, Candle, StreamMessage, CatalogResponse
├── database/                 # pg configuration, pool and checksum-locked migrations
├── http/                     # global admission, API rate limits and request gates
├── identity/                 # registration, sessions, roles, admin approval and audit
├── onboarding/               # owner-scoped goals, milestones and optimistic revisions
├── operations/               # API metrics, readiness and worker heartbeat repository
├── workspaces/               # owner-scoped documents, revisions and optimistic updates
├── jobs/                     # durable research queue, leases, quotas and API
├── workers/                  # isolated backtest supervisor/task entry points
├── market/
│   ├── catalog.ts            # Instrument catalog + findInstrument/getCatalog
│   ├── instrumentRegistry.ts # Normalized identities, filters, contracts and capabilities
│   ├── instrumentRoutes.ts   # Bounded registry/capability HTTP handlers
│   └── timeframes.ts         # Timeframe tables + Binance/Bybit interval maps, alignTime
├── providers/
│   ├── provider.ts           # MarketProvider / MarketSubscription / CandleRange interfaces
│   ├── router.ts             # ProviderRouter — routing, fallback, caching
│   ├── binance.ts            # Binance public REST klines + WS kline stream
│   ├── bybit.ts              # Bybit v5 public spot REST + WS kline stream
│   ├── synthetic.ts          # Deterministic synthetic OHLCV feed
│   └── cache.ts              # CandleCache — TTL/LRU window cache
├── orderbook/                # Shared public Binance/Bybit depth streams
├── tradeflow/                # Shared public trades, footprint/CVD inputs
├── arbitrage/
│   ├── service.ts            # Bounded REST discovery and route normalization
│   ├── upstream/             # Shared direct public ticker sockets + health watchdog
│   ├── stream.ts             # REST bootstrap, live merge and browser broadcast
│   ├── depth.ts              # On-demand two-book matched-quantity depth analysis
│   ├── history.ts            # Minute sampling and seven-day pruning
│   ├── alerts.ts             # Persistent rules plus retryable notification outbox
│   ├── engines/              # Triangular, pairwise and options-parity pure evaluators
│   ├── nativeSpreads/        # Bybit venue-native spread discovery/books
│   ├── replay/               # Immutable point-in-time basis replay/backtest
│   └── routeDependencyIndex.ts # Dependency-indexed 10k-route recomputation
├── venues/                   # Credential-free public venue adapters + HTTP facade
└── trading/
    ├── routes.ts             # /api/trade router + /trade-stream WebSocketServer
    ├── engine.ts             # TradingEngine — live bar evaluation & order management
    ├── engineRisk.ts         # Pure sizing and stop/target resolution
    ├── orderLifecycle.ts     # Durable intent/result/fill state transitions
    ├── orderPolling.ts       # Bounded private REST status fallback
    ├── reconciliation.ts     # Resume-time exchange/runtime comparison
    ├── liveRisk.ts           # Live preflight caps and fail-closed health policy
    ├── emergencyStop.ts      # Persistent kill switch, cancel/reconcile/optional flatten
    ├── paperLedger*.ts       # Durable append-only server paper execution ledger
    ├── commands.ts           # Notification/command parsing helpers
    ├── notifications.ts      # Outbound notifications
    ├── store.ts              # node:sqlite persistence + AES-256-GCM key storage
    ├── types.ts              # BotConfig, ExchangeAdapter, account/position types
    ├── exchange/             # paper / binance / bybit execution adapters
    └── strategy/             # Backend evaluator plus facades over shared IR and TA
```

## Frontend (`@saltanatbotv2/frontend`)

The frontend is a React 18 single-page app built with Vite 8. Its notable dependencies are `blockly` (visual strategy builder), `lucide-react` (icons), and `react`/`react-dom`. There is no third-party charting library — charts are drawn by a hand-written engine.

`frontend/src/App.tsx` is the workspace composition root. It restores selected market/chart routing
from the bounded `chartSession.ts` schema and switches between `chart`, `strategy`, `screener`, and
`trade`. The owner-scoped onboarding controller selects one first-use goal and records only actual
chart, alert, backtest or confirmed paper-bot milestones. `frontend/src/app/useAppShell.ts` owns
cross-workspace preferences, panels, exchange, named workspaces and compare overlays;
`useAppCommands.ts` owns commands and global shortcuts.

- **Custom canvas chart engine** — `frontend/src/chart/ChartEngine.ts` prepares one viewport/indicator render plan consumed by five cached canvases: background/axes, primary series, indicators, drawing/strategy overlays, and pointer interaction. `useChartRenderer` owns sizing and dirty invalidation, while `canvasDensity.ts` sizes every backing store to CSS size × DPR and transforms all renderers back into one logical CSS-pixel space. A coalescing scheduler preserves pass order. `priceRepresentation.ts` prepares full-history Heikin-Ashi, confirmed Renko, Three-Line-Break, Kagi or Point-and-Figure columns once for every Canvas/DOM consumer; exact timestamp interpolation preserves alignment. The chart supports `candles`, `hollow`, `heikin`, `bars`, `line`, `step`, `area`, `baseline`, `renko`, `linebreak`, `kagi`, and `pnf`.
- **Price-representation settings** — `priceRepresentationSettings.ts` validates and stores Renko/Kagi/P&F percentages, Line Break depth and P&F reversal boxes, then synchronizes same-page panes and other tabs. `PriceRepresentationControl.tsx` uses one native disclosure and explicitly labelled numeric inputs; updates cross the same preparation boundary, so Canvas, pointer math, indicators, market structure and semantic data never disagree.
- **Blockly strategy builder** — the Strategy Lab (`frontend/src/strategy/`) uses Blockly blocks that compile to the shared strategy IR (`compileArtifact.ts` → `compile.ts` → `ir.ts`) and runs a backtest (`backtest.ts`) against the current candle window.
- **Lazy-loaded views** — the heavier `StrategyLab` and `TradingView` views are code-split with `React.lazy` and rendered inside `<Suspense>`. Shell and command controllers warm those chunks ahead of likely navigation.
- **Runtime exchange selector** — for crypto instruments the user can pick `binance` or `bybit`; the choice is persisted in `localStorage` (`mf:cryptoExchange`) and threaded through candle/sparkline/stream requests.
- **Command palette + hotkeys** — `⌘/Ctrl-K` toggles a command palette; number keys `1..6` select timeframes.
- **Local workspace persistence** — indicators, the strategy library, theme, and panel state are stored in `localStorage`; a bounded versioned last-chart-session record restores layout/panes independently of named workspace revision history and rejects corrupt, oversized or future payloads. A strategy can be imported from a `#s=…` URL hash as a remixable copy.
- **Safe installable shell** — `pwa/registerServiceWorker.ts` registers only in a production build
  and only in a secure context (or localhost development). Public-IP HTTP therefore exposes neither
  a service worker nor an install launcher. `vite/pwaPlugin.ts` fingerprints the emitted Vite graph
  and generates an exact initial-shell precache without eager Strategy Studio/Blockly chunks.
  Publication copies the candidate assets first, atomically swaps `index.html`, and only then
  exposes the new worker, so install-time precaching of `/` cannot capture the previous HTML under
  the new cache name. Navigations are network-first; APIs and every market/trading stream are
  network-only, with no background sync or deferred request replay.

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
├── onboarding/               # owner-fenced API state and first-use application flow
├── pwa/                      # capability boundary, lifecycle and offline research state
├── arbitrage/                # Lazy read-only screener, costs, depth, alerts and paper ledger
├── strategy/                 # Blockly blocks, shared IR, compiler, backtester, library
├── trading/                  # TradingView (lazy) client
└── styles/                   # CSS (theme variables)
```

The five Canvas render passes are visual acceleration, not the sole data representation. `ChartDataPanel` supplies a keyboard-operable, browser-readable DOM alternative with native tables for focused/recent OHLC, strategy signals and trades. The visual chart references its synchronized text summary with `aria-describedby`; the fallback stays available regardless of experimental HTML-in-Canvas support. The arbitrage workspace follows the same boundary with a native results table and SVG history that includes a text description.

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

## Arbitrage research subsystem

The arbitrage path is deliberately separate from candle providers and private execution. It consumes
credential-free Binance/Bybit spot and linear-perpetual data for its live basis mode. Additional
bounded engines cover triangular routes, Bybit native spreads, caller-supplied pairwise research and
deterministic six-family route discovery over normalized instruments/books with exact assumption scopes,
plus bounded caller-supplied options-parity evaluation through strict HTTP/SDK contracts;
OKX, Gate, Hyperliquid and Deribit are isolated public adapters behind a separate read-only facade.
No arbitrage component can submit an order.

```text
public REST discovery ──► normalized common routes ──► direct venue ticker sockets
          │                            │                          │
          └──────── 30 s refresh ──────┴──── live quote merge ───┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
             /arbitrage-stream        history recorder        server alerts/outbox
                     │                        │                        │
                     ▼                        ▼                        ▼
              browser table         seven-day SQLite        notification only
                     │
                     ├── on-demand matched entry/exit depth
                     └── append-only browser paper events
```

`ArbitrageStreamHub` bootstraps the route universe from REST, shares four direct upstream public
sockets, refreshes discovery every 30 seconds and coalesces rapid changes before sending full
snapshots to browsers. A source becomes healthy only after a valid market-data event; a watchdog
terminates silent sockets and reconnects with bounded exponential backoff plus jitter. Each route
retains venue and local receive timestamps; routes outside the current age/skew gates are suppressed.
The hub stays active without a browser only while at least one persistent server alert is enabled.

`ArbitrageDepthService` fetches both public books only on demand and preserves each book's original
exchange/receive timestamps through its short cache. It derives one base-asset quantity, reduces it
to visible two-leg liquidity and floors it to a common lot step. Entry walks spot asks plus
perpetual bids; exit walks spot bids plus perpetual asks for the exact open quantity. Paper actions
fail closed on stale/skewed/incomplete books, unverified lot precision or residual directional
exposure. Display-only depth remains explicitly unverified until both venue lot steps come from
instrument metadata.

`ArbitrageHistoryRecorder` stores at most the top 50 live research routes once per minute and prunes
samples older than seven days. `ArbitrageAlertService` persists at most 50 authenticated rules and
appends notification attempts to a bounded durable outbox with retry, restart recovery and visible
terminal state; it never routes into the trading engine. Browser paper state is a bounded,
schema-versioned append-only event ledger in localStorage. Opens and closes use matched depth VWAP;
funding enters PnL only as a manually confirmed settlement event with time/rate/reference-price
provenance. It is not exchange or server account state.

The scanner requires exact current registry identities for both legs; partial/offline/mismatched
registry state suppresses routes instead of falling back to a ticker string. Adapter-supplied
economic identity is removed before the exact versioned central BTC/ETH catalog is applied, and the
continuous environment must match that catalog rather than overriding it. The registry normalizes
Binance/Bybit/OKX metadata, lot/tick/minimum filters and funding intervals. REST filters before its cap, ranks expected executable dollars and exposes
`totalOpportunities` / `truncated`; the stream publishes the complete fresh route set found by its
bounded discovery refresh. Funding counts only registry-verified discrete settlements and remains a
projection of an unknown future rate.

The separate continuous route-family runtime evaluates only bounded public entry evidence. It
enumerates the complete compatible ordered universe under a 24-instrument/552-candidate proof,
evaluates all rows and only then publishes up to 500 by net entry quote value, basis, capacity,
continuity and freshness; evaluated and published counts remain distinct. For two
current-generation books with sequence/checksum continuity, acceptable local-receipt age and
cross-leg skew, `continuous-market-economics-v1` aligns normalized quantity models, matches the
maximum base quantity visible at the buy ask and sell bid, and reports the quote-value difference
and basis before/after operator-environment public taker quote-equivalent fee estimates. The fee
asset and resulting base/quote exposure impact are explicitly unverified. Each accepted row carries
ordered long/short economic identity source, version, `asOf` and `validUntil`; validity at evaluation
time, capacity, notionals, fee estimates and basis arithmetic are checked fail-closed and recomputed
by the strict SDK. Its contract is always read-only, research-only, projected, non-executable and
strategy-blocked. Account fee tier, balances, capital, inventory, network/withdrawal state, borrow,
margin, full-horizon funding, convergence, expiry/delivery, exit and order execution are absent
rather than synthesized.

Runtime coverage is mirrored into every continuous discovery snapshot as `complete`, `current`,
`retainedPriorDiscovery` and a bounded reason. Partial-instrument refreshes are current but
incomplete. A registry failure before replacement may preserve a previous discovery only with
`current: false`, `complete: false`, `retainedPriorDiscovery: true` and `refresh-failed`; a first
failure retains no data and no successful refresh timestamp. Lifecycle conversion scores only
market-only entry-basis observations. Market-data-blocked zero-evidence rows are skipped while their
actual failure codes are retained in coverage; refresh reasons, non-live feeds, rejected/excluded
inputs and discovery/economics truncation propagate into stale/incomplete/truncated state. Strategy
evidence remains incomplete and every continuous lifecycle row remains `actionable: false`.

Current limitations are architectural boundaries, not hidden implementation details: the live basis
stream still covers only Binance/Bybit; selected newer venues enter a separate allowlisted continuous
public-feed path but have no chart or private execution integration; pairwise/options/replay results
are explicitly non-executable; browser paper funding must be entered from a confirmed external
settlement; and no funded
7–14-day exchange soak has been performed.
See [Arbitrage taxonomy](./ARBITRAGE_TAXONOMY.md), [Math and assumptions](./ARBITRAGE_MATH_AND_ASSUMPTIONS.md)
and [Market-data quality](./MARKET_DATA_QUALITY.md).

## Shared strategy IR

Strategies are not stored as executable code — they compile to a typed **intermediate representation** that both tiers understand. Canonical IR declarations, evaluator, intent types, security-series alignment and TA live in `packages/strategy-core`. Slippage, protection-price resolution, sizing and monotonic order-state semantics live in `packages/execution-core`. Historical fills, portfolio accounting, warm-up, reporting contracts, metrics and chart/external candle-source provenance live in `packages/backtest-core`. Frontend and backend strategy files retain narrow compatibility facades.

Declarative `.saltanat-plugin` files are validated by `packages/plugin-core` before they can mutate
the local artifact library. The package rejects unknown fields, executable-code fields, invalid
permissions, incompatible versions and external/cyclic dependencies, then verifies SHA-256 over the
complete canonical manifest. Signed version-2 files additionally verify an embedded P-256 key and
domain-separated ECDSA signature. The frontend stores a device-local non-extractable signing key in
IndexedDB and independent fingerprint trust pins in bounded localStorage. Imported artifacts still
compile through the same Strategy IR path;
the plugin envelope cannot load code, access credentials or call an exchange directly.

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

REST and purpose-specific WebSocket hubs connect the SPA to the backend over the same origin/port:

- **REST** (`fetch`) for catalog, candle windows, sparklines, arbitrage scan/depth/history,
  owner-scoped onboarding/workspaces/jobs and authenticated trading operations. Requests are
  same-origin relative paths (`/api/...`).
- **Account-authenticated browser WebSocket** hubs at `/stream`, `/quotes`, `/orderbook`, `/trade-flow` and `/arbitrage-stream`; their payloads come from credential-free public market feeds but the hosted application no longer exposes them anonymously.
- **Authenticated WebSocket** at `/trade-stream`, opened only with a one-use ticket for account/order state. Every URL uses `wss` when the page is served over HTTPS.

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
- [Arbitrage taxonomy](./ARBITRAGE_TAXONOMY.md)
- [Venue capabilities](./VENUE_CAPABILITIES.md)
- [Exchange adapter contract](./EXCHANGE_ADAPTER_CONTRACT.md)
- [Arbitrage verification matrix](./ARBITRAGE_TEST_MATRIX.md)
- [Trading engine](./TRADING.md)
- [Strategies & IR](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
