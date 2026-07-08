<div align="center">

<img src="assets/logo.svg" alt="SaltanatbotV2 logo" width="140" height="140" />

# SaltanatbotV2 🐘

**A self-hosted, open-source crypto trading terminal.**
Live charts · a no-code visual strategy builder · one-click backtests · paper & live trading.

[![License: MIT](https://img.shields.io/badge/License-MIT-14b8a6.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vite.dev)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## What is this?

**SaltanatbotV2** is a trading terminal you run yourself. It streams live crypto candles from **Binance or Bybit** (switchable at runtime), renders them on a fast custom canvas chart with indicators and drawing tools, lets you **assemble trading strategies from visual blocks** (no code), **backtest them on historical data in seconds**, and then run them as **paper or live bots** driven by a compact Antares-style command language — with **Telegram / VK** notifications.

Everything is local: your keys, your data, your rules. There is no account, no cloud, no telemetry.

> 🐘 *Why the elephant with a raised trunk?* A raised trunk is the classic symbol of good fortune — and the candlesticks rising over its back point the way we all hope the market goes.

<div align="center">
<img src="docs/screenshots/01-chart.png" alt="Chart view with the Binance/Bybit market source selector, indicators and live feed" width="900" />
<br/><em>Chart workspace — 50+ crypto pairs, a Binance/Bybit source selector, indicators, volume, RSI sub-panel and a live websocket feed.</em>
</div>

---

## Features

### 📈 Charting
- Custom **canvas chart engine** (no heavy chart library) with its own viewport / time-scale coordinate system.
- Chart types: **candles, Heikin-Ashi, bars, line, area, baseline, renko**.
- Indicators: **SMA, EMA, Bollinger Bands, RSI, MACD** and arrow **signal** overlays (e.g. EMA crossovers).
- Crosshair with OHLC legend, volume histogram, drawing tools, and **lazy-loaded history** on scroll-back.
- Overlay a saved strategy directly on the chart: its **plotted indicator lines** plus **buy/sell signal points** and simulated trades.

### 🧱 Visual strategy builder + backtester
- **Blockly** no-code builder — snap together Market / Indicators / Math / Logic / Time / Signals / Risk & Size / State & Alerts blocks.
- Blocks compile to a safe **JSON intermediate representation (IR)** — **no `eval`, ever**.
- **One-click backtest** with configurable quote market, timeframe, bar count, starting capital, fee % and shorting.
- Metrics + trade markers on the chart; share a strategy as a single **URL** (import as a remixable copy).

### 🤖 Paper & live trading
- Run any saved strategy as a bot in **paper** (default), **Binance**, or **Bybit** mode.
- Strategy signals are translated into an **Antares-style command language**: `param=value;` params, `::` command chaining, `pause` / `randpause`, `!`/`^` flags and **14 order actions** (market/limit/stop/take-profit, partial closes, reverses, and more).
- Built-in **paper order engine** with pending limit/stop/TP orders and tick-based fills at real market prices.
- **Telegram & VK** notifications on start/stop/open/close/error/signal.

### 🔀 Multi-exchange market data
- **Binance** and **Bybit** public providers (REST klines + live WebSocket), plus a deterministic **synthetic** feed for FX/stocks/indices and offline demos.
- Pick the crypto **data source** (Binance ⇄ Bybit) right in the Markets panel — the whole chart, sparklines and stream re-point instantly.
- Automatic **fallback** to synthetic data if an exchange is unreachable, with a small in-memory **candle cache**.

### 🔒 Local-first & secure
- Exchange API keys are **encrypted at rest** with AES-256-GCM (`node:crypto`) — they are **never** sent back to the browser and never leave your machine.
- Persistence uses Node's **built-in** `node:sqlite` — no native builds, no external database, no occupied ports.

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
| **Backend** | Node 24 · Express 5 · `ws` (WebSocket) · `zod` · built-in `node:sqlite` & `node:crypto` |
| **Market data** | Binance & Bybit public REST + WebSocket · synthetic generator |
| **Tooling** | npm workspaces monorepo · TypeScript ESM (NodeNext) · Playwright |

---

## Quick start

**Prerequisites:** [Node.js **24+**](https://nodejs.org) and npm.

```bash
# 1. Clone
git clone https://github.com/AubakirovArman/SaltanatbotV2.git
cd SaltanatbotV2

# 2. Install (npm workspaces installs backend + frontend together)
npm install

# 3a. Develop — backend (tsx watch) + frontend (Vite) with hot reload
npm run dev
#    frontend → http://localhost:5173   backend/API → http://localhost:4180

# 3b. …or build & run production (backend serves the built frontend on one port)
npm run build
npm start
#    open → http://localhost:4180
```

Configure the host/port with environment variables:

```bash
PORT=4180 HOST=0.0.0.0 npm start
```

> **First run creates `backend/data/`** — an AES key file (`.secret`) and a SQLite database (`trading.db`).
> Both are **git-ignored** and must never be committed. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Documentation

| Guide | What's inside |
| --- | --- |
| [**Architecture**](docs/ARCHITECTURE.md) | Monorepo layout, backend/frontend tiers, the provider router, the shared strategy IR, end-to-end data flow |
| [**API reference**](docs/API.md) | Every REST endpoint and WebSocket message — params, types, and `curl` examples |
| [**Strategies & backtesting**](docs/STRATEGIES.md) | Building from blocks, the IR, `runBacktest` / `previewStrategy`, sharing, and live parity |
| [**Trading & command language**](docs/TRADING.md) | The Trade tab, all 14 Antares-style actions, paper/Binance/Bybit modes, notifications |
| [**Configuration & deployment**](docs/CONFIGURATION.md) | Env vars, runtime data, exchange keys, encryption, production & hardening checklist |
| [**Contributing**](CONTRIBUTING.md) | Dev setup, repo conventions, and how to add instruments / blocks / commands |

---

## Project structure

```text
SaltanatbotV2/
├── backend/                 # @saltanatbotv2/backend — Express + ws + node:sqlite
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
├── docs/                    # architecture, API, trading, strategies, configuration
└── assets/                  # logo
```

---

## Security & responsible use

- **Paper mode is the default.** Live trading only happens with API keys **you** add; those keys are AES-256-GCM encrypted on disk and never returned to the browser.
- **Never commit `backend/data/`** (enforced by `.gitignore`). It holds your encryption key and database.
- When exposing the server beyond `localhost`, put it behind a **reverse proxy with TLS** and a firewall. See the hardening checklist in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

> ⚠️ **Disclaimer.** SaltanatbotV2 is provided as-is for research and educational purposes. Trading cryptocurrencies carries substantial risk. Nothing here is financial advice — you are solely responsible for any orders placed with your keys. Test on paper first.

---

## Acknowledgements

- The block builder is powered by [**Blockly**](https://developers.google.com/blockly).
- The trading command syntax is inspired by the [**Antares**](https://antares-ts.gitbook.io/doc) command language.
- Market data comes from the public [Binance](https://binance-docs.github.io/apidocs/) and [Bybit](https://bybit-exchange.github.io/docs/) APIs.

## License

Released under the [MIT License](LICENSE).
