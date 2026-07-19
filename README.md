<div align="center">

**English** · [Русский](README.ru.md) · [Қазақша](README.kk.md)

<img src="assets/logo.svg" alt="SaltanatbotV2 logo" width="140" height="140" />

# SaltanatbotV2 🐘

**A self-hosted, open-source crypto research and paper-trading terminal.**
Live charts · a no-code visual strategy builder · one-click backtests · paper automation.

[![CI](https://github.com/AubakirovArman/SaltanatbotV2/actions/workflows/ci.yml/badge.svg)](https://github.com/AubakirovArman/SaltanatbotV2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-14b8a6.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vite.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## What is this?

**SaltanatbotV2** is a trading terminal you run yourself. It streams live crypto candles from **Binance, Bybit or first-DEX perpetual Hyperliquid** (switchable at runtime), renders them on a fast custom canvas chart with indicators and drawing tools, lets you **assemble trading strategies from visual blocks** (no code), **backtest them on historical data in seconds**, and run them as isolated **paper bots**. The current release is deliberately Research / Paper only: dormant experimental live-adapter code cannot be activated until a separate HTTPS and security release.

Application state and credentials stay on your self-hosted SaltanatbotV2 instance: there is no
Saltanatbot cloud account or built-in telemetry. Live public market data and optional Telegram/VK
delivery still require outbound network requests to the services you enable.

> 🐘 *Why the elephant with a raised trunk?* A raised trunk is the classic symbol of good fortune — and the candlesticks rising over its back point the way we all hope the market goes.

<div align="center">
<img src="docs/screenshots/01-chart.png" alt="Chart view with the market source selector, indicators and live feed" width="900" />
<br/><em>Chart workspace — 50+ crypto pairs, Binance/Bybit/Hyperliquid sources, indicators, volume, RSI sub-panel and a live websocket feed.</em>
</div>

---

## Features

### 🧭 Monitoring, automation & research
- The primary navigation separates **Monitoring** (charts and manual research), **Automation** (Strategies and Robots) and the read-only **Screener** instead of mixing those workflows in one tab.
- A global **Running** counter opens the browser robots/portfolio center. It groups the current owner's saved account metadata and isolated paper robots. In `public-http-paper`, paper balance/equity, realized P&L, positions and open orders are available where modeled; private exchange telemetry, margin and borrowing remain unavailable rather than being inferred.
- Trading-account metadata and dormant legacy credentials are isolated by owner and concrete account. Administrator activation or role management does not grant access to another user's accounts, credentials, workspaces or paper portfolio, and the current profile neither accepts nor decrypts exchange credentials for use.

### 📈 Charting
- Custom **canvas chart engine** (no heavy chart library) with its own viewport / time-scale coordinate system.
- Chart types: **candles, hollow candles, Heikin-Ashi, bars, line, step line, area, baseline, Renko, Three Line Break, Kagi and Point & Figure**. Ten timeframes from **1m to 1M**.
- Stable close-only Renko uses fixed 0.05%-seeded bricks, a true two-brick reversal, aggregated source volume and actual discarded-close wicks; live tails never rewrite confirmed bricks.
- Confirmed close-only Kagi uses a fixed 0.10%-seeded reversal to filter noise into continuous up/down legs with shoulder and waist turns; the provisional live tail is excluded.
- Renko brick percentage, Kagi reversal percentage, Line Break depth and Point & Figure construction are adjustable from each chart, validated to safe ranges and persisted by pane + symbol; changing one rebuilds only that displayed series without changing sibling panes or backtest execution candles.
- Point & Figure uses alternating confirmed X/O columns with a fixed seeded percentage box and configurable reversal-box count; its synthetic columns are display analysis, not executable prices.
- OHLCV-estimated visible-range Volume Profile (VPVR) with directional volume, Point of Control and a contiguous 70% value area. Its source can follow the chart or use an independent **1m/5m/15m/1h/4h/1d timeframe**; incomplete, synthetic or oversized source ranges fail closed.
- Real Binance/Bybit/Hyperliquid public top-20 order-book heatmap with a shared backend upstream, 60-second liquidity history and explicit reconnect/stale states.
- Real-time Binance/Bybit/Hyperliquid trade footprint with aggressor cells, delta/CVD, diagonal and stacked imbalance highlighting, and explicitly provisional absorption heuristics; no synthetic prints or reconstructed history.
- Configurable in-chart microstructure alerts for stacked imbalance, potential absorption, CVD spikes and large prints, with local persistence, bounded history and optional sound/desktop delivery.
- UTC session-liquidity map with OHLCV bar-based VWAP ±1σ, session O/H/L, exchange daily PDH/PDL and confirmed wick-and-reclaim sweep markers.
- Confirmed HH/LH/HL/LL market structure with close-based BOS/CHOCH, adjustable swing strength and optional fully mitigated three-candle FVG zones on every timeframe.
- One-click Anchored VWAP drawings with editable/persisted anchors, a ±1σ value area, ±1σ/±2σ bands and a semantic current-value legend.
- DST-aware Asia, London and New York session high/low boxes with independent accessible toggles on precise intraday charts.
- Every chart pane can display exchange UTC, browser-local time or a selected IANA city zone; axis, crosshair, OHLC tables and overlays stay consistent across DST and the choice survives workspace export/reload.
- Indicators: **SMA, EMA, Bollinger, RSI, MACD, VWAP, ATR, Stochastic, OBV** and arrow **signal** overlays (e.g. EMA crossovers).
- **Price alerts** (browser notification + sound), **symbol compare** overlay, crosshair with OHLC legend, persistent drawing tools, a zero-persistence **Shift-drag ruler** for price/%/bars/time, and **lazy-loaded history** on scroll-back.
- Independent right-axis price scaling supports wheel/trackpad, vertical drag, keyboard arrows, `Home` and double-click reset without changing the visible candle range.
- Retina/HiDPI Canvas backing keeps candles, axes, footprint and depth crisp without changing mouse, trackpad or HUD geometry.
- Touchscreens support one-finger pan and a data-anchored two-finger pinch/pan gesture; lifting one finger continues panning without moving or zooming the surrounding page. Repeated pinch-in at the 40% time-range limit becomes a stable no-op instead of competing with single-finger pan or reloading the interface.
- On narrow screens, markets and instrument details open as exclusive focus-managed bottom sheets, leaving the chart unobstructed by default and respecting device safe areas.
- One-, two- and four-chart layouts have direct numbered pane selectors, a one-click **Four different markets** preset, an explicit numbered active badge, customizable `Alt+J` / `Alt+K` keyboard cycling, adaptive compact chrome and a state-preserving active-pane maximize mode. The top bar, command palette, watchlist, live statistics and timeframe shortcuts follow the focused pane; drawings are always isolated by pane and symbol, while secondary symbols, timeframes, chart types, indicator sets and compare overlays become independent when edited and can explicitly relink comparisons, indicators, symbol, timeframe, chart type, crosshair and the absolute visible **time range**. Identical pane market keys share one ref-counted browser WebSocket.
- Watchlist with **favorites** and **%-change sorting**; automatic last-session recovery plus **saved workspaces** for named/versioned layouts; overlay a saved strategy directly on the chart with its **plotted indicator lines**, **buy/sell signal points** and simulated trades.

### 🧱 Visual strategy builder + backtester
- **Blockly** no-code builder — snap together Market / Indicators / Math / Logic / Time / Signals / Risk & Size / State & Alerts blocks. Start from a **template gallery**.
- Blocks compile to a safe **JSON intermediate representation (IR)** — **no `eval`, ever**.
- **Trustworthy backtests**: next-bar-open fills, gap-aware stops, slippage/funding costs, warm-up exclusion, Monte Carlo robustness, drawdown/MAE-MFE, and a **parameter optimizer with walk-forward** (in-/out-of-sample, Web Worker).
- The optimizer offers bounded grid and seeded **genetic parameter search** with crossover, mutation, elitism and train/validation fitness. Only the frozen #1 candidate receives the untouched final test gate; a passing assignment is written back to Blockly under its exact research scope. A separate structural generator creates validated trend, mean-reversion, breakout and momentum IR candidates with reproducible provenance; its browser panel generates diversity but does **not** yet run or rank multi-market fitness.
- Metrics + trade markers on the chart; share a strategy as a **URL** or a **`.strategy` file** (import as a remixable copy).

### 🤖 Paper trading and automation
- Run saved strategies as isolated **paper** bots, optionally using Hyperliquid first-DEX perpetual market data. Binance/Bybit live execution and Hyperliquid wallet execution are disabled by the immutable `public-http-paper` runtime profile.
- Strategy signals are translated into an **Antares-style command language**: `param=value;` params, `::` command chaining, `pause` / `randpause`, `!`/`^` flags and **14 order actions** (market/limit/stop/take-profit, partial closes, reverses, and more).
- Built-in **paper order engine** with pending limit/stop/TP orders and tick-based fills at public market prices. Dormant live formatting code remains unavailable to the deployed runtime.
- A cross-bot portfolio API and dedicated browser robots/portfolio center, Telegram summary, per-bot risk caps + a **kill switch**, and **two-way Telegram control** (`/status` `/stop` `/start` `/kill`).
- UI-configurable **Telegram** notifications and an authenticated backend configuration path for **VK**, covering start/stop/open/close/error/signal events.

### 🔀 Multi-exchange market data
- **Binance**, **Bybit** and first-DEX perpetual **Hyperliquid** public providers (REST candles + live WebSocket) with **auto-reconnect + gap backfill**, plus a deterministic **synthetic** feed for FX/stocks/indices.
- A read-only **arbitrage research workspace** covers strict venue-native basis plus reviewed BTC/ETH cross-venue Binance/Bybit basis, directional top-book triangular simulations and Bybit native spreads. Operator-allowlisted continuous public feeds for OKX/Gate/Hyperliquid/Deribit/Kraken/Coinbase/dYdX/KuCoin/MEXC can show only fail-closed top-book entry quote-value/basis evidence with public taker quote-equivalent fee estimates—not a trading return. Identity provenance, refresh coverage and arithmetic are validated, and every route stays strategy-blocked and non-actionable. The public SDK and bounded adapters for all nine generic venues plus a strict options-parity HTTP/SDK evaluator expose no credential or order methods.
- Basis, triangular, native-spread and compatible continuous results can be handed to **Automation** as a validated `market-opportunity-v1` research card with legs, economics, evidence and blockers. The handoff is not an order plan: live execution is always blocked and the exact paper multi-leg plan remains a separate short-lived artifact.
- An admin-only **Order-book ML research** workflow accepts uploaded, reconstructed and sequence-verified aggregate L2 snapshots, builds leakage-controlled datasets and trains an inspectable ridge baseline. Sessions are temporary and in-memory; the system identifies no participant, emits no calibrated probability and cannot place paper or live orders.
- **USDT spot pairs discovered dynamically** from each exchange (with a curated offline fallback), a **persistent SQLite candle store** for deep history, and rate-limit-aware fetching. The exact instrument count changes with exchange listings.
- Pick the crypto **data source** (Binance ⇄ Bybit) right in the Markets panel — the whole chart, sparklines and stream re-point instantly.

### 🔒 Local-first & secure
- Legacy exchange API keys, if present from an older installation, remain **encrypted at rest** with AES-256-GCM (`node:crypto`) and are never sent back to the browser. The current Research / Paper profile does not accept or decrypt them for use.
- PostgreSQL stores accounts, revocable sessions, named workspaces and durable research jobs; the existing built-in **`node:sqlite`** stores keep legacy trading state, encrypted exchange settings and candle/paper journals without an automatic destructive migration.
- The production terminal is **installable as a PWA** and can reopen its static interface offline. APIs, authentication, quotes, order books, trades and trading commands are never cached or replayed; offline does not mean fresh market data or available execution.
- Strategy Studio can be made available offline from the top bar as an optional static research bundle; local artifacts stay on-device and trading remains network-only. See [Offline local research](docs/OFFLINE_RESEARCH.md).
- Installed Chromium-family PWAs can open or receive shared `.pine`, `.strategy` and `.saltanat-plugin` files through a mandatory local review flow; manual import remains available everywhere else. See [PWA file opening and sharing](docs/PWA_FILE_HANDLING.md).
- Core application navigation and stable user journeys are available in **English, Russian and Kazakh**. The native language control cycles EN → RU → KK and persists the selected locale with matching document metadata and regional number/date formatting; exact API/developer references remain canonical English.

---

<div align="center">
<img src="docs/screenshots/02-strategy.png" alt="Blockly strategy builder with a compiled preview and backtest settings" width="900" />
<br/><em>Strategy Lab — build from blocks on the left, watch it compile to readable rules on the right, then backtest.</em>
</div>

---

## Tech stack

| Layer | Stack |
| --- | --- |
| **Frontend** | React 18 · Vite 8 · TypeScript · Blockly · a custom canvas chart engine · `lucide-react` |
| **Backend** | Node 24 · Express 5 · PostgreSQL 17 · `ws` · `zod` · built-in `node:sqlite` & `node:crypto` |
| **Market data** | Binance & Bybit public REST + WebSocket · synthetic generator |
| **Tooling** | npm workspaces monorepo · TypeScript ESM (NodeNext) · Playwright |

---

## Quick start

**Recommended prerequisites:** Docker Engine and the Compose plugin. A direct host install uses
[Node.js **24+**](https://nodejs.org), npm and PostgreSQL.

```bash
# 1. Clone
git clone https://github.com/AubakirovArman/SaltanatbotV2.git
cd SaltanatbotV2

# 2. Create the local database secret (git-ignored, owner-only)
mkdir -p .secrets
umask 077
openssl rand -base64 48 > .secrets/postgres_password

# 3. Build and start the app, PostgreSQL and the bounded research worker
docker compose up -d --build

# 4. Create the first administrator; the generated password is shown once
docker compose exec saltanatbotv2 \
  node backend/dist/cli/bootstrapAdmin.js --login your-admin-login
#    open → http://localhost:4180 and change that password immediately
```

Registration creates an inactive account. An administrator activates it from the account panel.
Passwords are stored as Argon2id hashes, browser sessions use an HttpOnly cookie plus CSRF, and
disabling an account revokes its sessions. The isolated project database is exposed only on
`127.0.0.1:55434`; set `POSTGRES_HOST_PORT` if that port is occupied.

For development with hot reload, start only PostgreSQL, export the absolute password-file path, then
run the workspaces:

```bash
docker compose up -d postgres
npm install
export AUTH_MODE=database PGPASSWORD_FILE="$PWD/.secrets/postgres_password"
npm run dev
# frontend → http://localhost:4180   backend/API → http://localhost:4181
```

> Existing `backend/data/trading.db`, candle data and encrypted keys are preserved. The schema-v6
> migration assigns legacy trading rows to one selected administrator; every account, credential,
> bot, order, fill, event, log and private stream is owner-scoped after migration. Application
> administrators manage access but cannot browse another user's trading resources or exchange
> secrets. Do not start two API processes against that SQLite file. See the complete
> [self-hosting guide](docs/SELF_HOSTING.md).

### …or with Docker

```bash
# See the Quick start above; volumes persist PostgreSQL and legacy SQLite state.
docker compose up -d --build
```

**Tests & CI:** `npm test` (Vitest — command parser, paper engine, backtest honesty, evaluator parity), `npm run lint`, `npm run check`, the complete production-build Chromium suite (`npm run test:e2e`), tagged Firefox critical journeys (`npm run test:e2e:firefox-smoke`) and six deterministic visual baselines (`npm run test:visual`) run in [CI](.github/workflows/ci.yml) on every push and pull request. The scheduled and release-tagged [browser matrix](.github/workflows/browser-matrix.yml) runs all production journeys on Chromium, Firefox and WebKit. Failed browser runs retain their Playwright report, trace, screenshots and video. Authenticated exchange release checks are isolated in the manually dispatched, protected [testnet smoke workflow](.github/workflows/exchange-testnet-smoke.yml).

---

## Documentation

Public multilingual overview: **GitHub Pages** (English · Русский · Қазақша). The deployment URL is
published by the `Deploy documentation site` workflow and is also set as the repository homepage.

| Guide | What's inside |
| --- | --- |
| [**Architecture**](docs/ARCHITECTURE.md) | Monorepo layout, backend/frontend tiers, the provider router, the shared strategy IR, end-to-end data flow |
| [**API reference**](docs/API.md) | Every REST endpoint and WebSocket message — params, types, and `curl` examples |
| [**Generated endpoint index**](docs/API_ENDPOINTS.generated.md) | Route-presence and access-level index generated from Express sources |
| [**Strategies & backtesting**](docs/STRATEGIES.md) | Building from blocks, the IR, `runBacktest` / `previewStrategy`, sharing, and deterministic replay/paper parity |
| [**Declarative plugins**](docs/PLUGINS.md) | Checksummed local indicator/strategy packages, permissions, limits and trust boundaries |
| [**Generated block catalog**](docs/BLOCK_CATALOG.generated.md) | Stable Blockly type identifiers and canonical trader-facing help generated from metadata |
| [**Generated Pine compatibility**](docs/PINE_COMPATIBILITY.generated.md) | Corpus-backed exact, display-only, approximation and rejected feature matrix |
| [**Arbitrage screener and research reference**](docs/ARBITRAGE_SCREENER.md) | Read-only triangular L2 verification, funding scenarios, fork guide and fail-closed continuous entry basis plus canonical [vocabulary](docs/ARBITRAGE_TAXONOMY.md), [math](docs/ARBITRAGE_MATH_AND_ASSUMPTIONS.md), [data quality](docs/MARKET_DATA_QUALITY.md), [venue status](docs/VENUE_CAPABILITIES.md) and [test gates](docs/ARBITRAGE_TEST_MATRIX.md) |
| [**Research alerts**](docs/RESEARCH_ALERTS.md) | Protected notification-only policy/outbox UI and runtime, including the still-unconnected engine-producer boundary |
| [**Owner-scoped server alerts**](docs/ALERTS.md) | R5.1 price-alert contracts, closed-candle evaluator, durable cursor/outbox, quotas, retention and schema-13 recovery boundary |
| [**Network identity**](docs/NETWORK_IDENTITY.md) | Synthetic-only reviewed identity/transfer-proof contract; no real network mapping or transfer execution claim |
| [**Trading & command language**](docs/TRADING.md) | The Trade tab, all 14 Antares-style actions, paper mode, dormant legacy exchange contracts and notifications |
| [**Configuration & deployment**](docs/CONFIGURATION.md) | Env vars, runtime data, exchange keys, encryption, production & hardening checklist |
| [**Self-hosting with accounts**](docs/SELF_HOSTING.md) | Clone, PostgreSQL secret, first admin, pending-user approval, updates and storage boundaries |
| [**Capacity for 100 users**](docs/CAPACITY_100_USERS.md) | Measured host headroom, queue/worker limits, monitoring and safe scaling order |
| [**Pre-HTTPS development roadmap**](docs/PRE_HTTPS_ROADMAP.md) | The active R2-R12 Research/Paper plan, delivered baselines, remaining work, dependencies and release gates |
| [**Backup & restore**](docs/BACKUP_RESTORE.md) | Paired PostgreSQL/SQLite generations, checksums, replacement-only restore and isolated recovery drills |
| [**Release policy & verification**](docs/RELEASING.md) | Nightly/alpha/beta/stable channels, SBOM, SHA-256 and Sigstore attestation verification |
| [**Roadmap**](docs/ROADMAP.md) | What has shipped and what's next |
| [**Master improvement plan**](docs/MASTER_IMPROVEMENT_PLAN.md) | Product gaps, priorities, release gates and delivery milestones |
| [**Implementation status**](docs/IMPLEMENTATION_STATUS.md) | Completed commits, verification evidence, active work and remaining checklist |
| [**Modular architecture**](docs/MODULAR_ARCHITECTURE.md) | Target packages, module boundaries and safe decomposition sequence |
| [**Testing strategy**](docs/TESTING_STRATEGY.md) | Unit, parity, browser E2E, visual, accessibility, performance and recovery testing |
| [**Internationalization & docs**](docs/I18N_AND_DOCUMENTATION.md) | EN/RU/KK UI structure, terminology and documentation quality gates |
| [**Documentation status**](docs/DOCUMENTATION_STATUS.md) | Currency audit, ownership, verification dates and EN/RU/KK user-guide coverage |
| [**Russian user guide**](docs/ru/README.md) | Chart, Strategy Studio, Pine/backtest, trading, traces and safety in Russian |
| [**Kazakh user guide**](docs/kk/README.md) | Chart, Strategy Studio, Pine/backtest, trading, traces and safety in Kazakh |
| [**Contributing**](CONTRIBUTING.md) | Dev setup, repo conventions, and how to add instruments / blocks / commands |
| [**Security policy**](SECURITY.md) | Private vulnerability reporting, supported versions and secret-handling rules |
| [**Threat model**](docs/THREAT_MODEL.md) | Assets, trust boundaries, threats, mitigations, non-goals and residual risks |
| [**Support**](SUPPORT.md) | How to request help or file a reproducible issue safely |
| [**Code of conduct**](CODE_OF_CONDUCT.md) | Community participation and moderation expectations |
| [**Changelog**](CHANGELOG.md) | User-visible changes grouped by release |

---

## Project structure

```text
SaltanatbotV2/
├── backend/                 # Express/ws API, PostgreSQL identity/jobs, legacy node:sqlite trading
│   └── src/
│       ├── server.ts        # HTTP + WebSocket on one port, static SPA hosting
│       ├── market/          # instrument catalog + timeframe/interval maps
│       ├── providers/       # binance · bybit · synthetic · router · cache
│       └── trading/         # command parser, engine, exchange adapters, strategy runtime
├── frontend/                # @saltanatbotv2/frontend — React + Vite
│   └── src/
│       ├── chart/           # canvas chart engine + renderers + objects
│       ├── strategy/        # Blockly builder, IR compiler, backtest
│       ├── trading/         # Trade tab UI
│       ├── components/  hooks/  api/  styles/
│       └── App.tsx
├── packages/                # contracts, Pine, strategy, execution, backtest and test-fixture cores
├── docs/                    # architecture, API, trading, strategies, configuration
└── assets/                  # logo
```

---

## Security & responsible use

- **The application requires an activated account.** Registration is pending until an administrator approves it. The browser receives an HttpOnly, SameSite session cookie; mutations require CSRF and the trade socket uses a session-bound one-time ticket. Token login remains only as an explicit legacy test/demo mode. Database mode protects application REST and market WebSockets; foreign browser origins are also constrained by the CORS allowlist.
- **Binds to `127.0.0.1` by default.** Before HTTPS exists, expose it only through a private network/VPN/IP allowlist with a firewall; do not place login traffic on an untrusted public HTTP network. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Public HTTP is research/paper only.** The fail-closed default `RUNTIME_PROFILE=public-http-paper` blocks live bots, key writes/decryption for use, signed REST and private exchange WebSockets in the engine as well as the UI. `DEMO_MODE=1` remains a deprecated alias. Keep this profile until a separately audited HTTPS deployment exists.
- **Do not enter exchange keys over public HTTP.** Existing encrypted values remain dormant. **Never commit `backend/data/`, `.secrets/` or a PostgreSQL dump.**

> ⚠️ **Disclaimer.** SaltanatbotV2 is provided as-is for research and educational purposes. Trading cryptocurrencies carries substantial risk. Nothing here is financial advice — you are solely responsible for any orders placed with your keys. Test on paper first.

---

## Acknowledgements

- The block builder is powered by [**Blockly**](https://developers.google.com/blockly).
- The trading command syntax is inspired by the [**Antares**](https://antares-ts.gitbook.io/doc) command language.
- Market data comes from the public [Binance](https://developers.binance.com/en/docs/products/spot/rest-api), [Bybit](https://bybit-exchange.github.io/docs/) and [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api) APIs.

## License

Released under the [MIT License](LICENSE).
