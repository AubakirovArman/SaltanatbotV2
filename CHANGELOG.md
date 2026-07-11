# Changelog

All notable user-visible and engineering changes are recorded here. The project follows a
Keep a Changelog–style structure and uses semantic versioning for tagged releases.

## Unreleased

### Strategy Studio and accessibility

- Added explicit Build/Validate/Preview/Backtest/Optimize/Run/Learn stages, a guided editable-strategy
  wizard, block contracts, linked diagnostics and validated parameter schemas.
- Added immutable artifact history, semantic versions, content/IR fingerprints, dependency-cycle
  checks, diff/rollback and checksum-verified schema-v2 `.strategy` files.
- Added automated axe WCAG A/AA audits across Chart, Strategy and Trading, shared modal focus behavior,
  global reduced-motion handling, 200% text verification and corrected secondary-text contrast.
- Added contributor, asset-provenance, accessibility and migration policies plus categorized automatic
  GitHub release notes.
- Split Blockly definitions into domain-owned category modules with invariant tests while retaining the
  existing registration/toolbox facade and saved XML compatibility.
- Split Blockly compilation into focused statement, numeric, boolean and context modules while
  preserving the public compiler contract and complete regression suite.
- Decomposed the chart Canvas facade into drawing controls, localized menus, accessible overlays,
  interaction helpers and a stable prop contract, reducing the coordinator below the module budget.
- Reduced the trading engine facade below the module budget by extracting runtime state, adapter
  routing, portfolio aggregation and the private-stream/poll/reconciliation coordinator.

### Operations and recovery

- Added checksum-manifested online SQLite backups for trading state, candle cache and encryption
  material, with integrity verification and owner-only file permissions.
- Added fail-safe atomic restore that refuses to replace non-empty runtime state without an explicit
  flag and rolls the previous directory back if the swap fails.
- Added automated backup, tamper-detection and restore recovery tests plus EN/RU/KK operator guides.
- Added transactional forward-only SQLite schema migrations with explicit version tracking,
  idempotent legacy upgrades and refusal to open databases from newer application versions.
- Added exchange-wide signed-request circuit breakers for Binance/Bybit throttling and explicit
  host clock-skew detection; mutating requests are never automatically replayed.
- Added a canonical test-fixtures workspace for deterministic candle series and fail-closed scripted
  exchange HTTP responses shared across frontend and backend tests.
- Added a canonical execution-core workspace shared by backtest and trading for slippage,
  protection prices, sizing and durable order transitions. Risk-percent entries without a stop now
  fail closed instead of falling back to maximum leveraged exposure.
- Added generated runtime market contracts for catalog, candles, sparklines and WebSocket messages;
  malformed REST/stream payloads are rejected before entering frontend state.

### Documentation and distribution

- Added a multilingual project site for GitHub Pages in English, Russian and Kazakh.
- Added a documentation currency register with ownership, language coverage and verification dates.
- Added complete Russian and Kazakh entry points for the current user workflows.
- Added secret-safe issue forms, a PR safety checklist and a public threat model with explicit
  trust boundaries, residual risks and deferred funded-soak status.
- Added enforced production frontend raw/gzip budgets to push, pull-request and release CI.

## 2026-07-11 — 90-commit development snapshot

This snapshot covers commits `d5c45c6` through `b6ca124` from 10–11 July 2026: 90 commits,
363 changed files, 27,757 insertions and 12,039 deletions.

### Added

- Pine Script v4–v6 import now has a standalone compiler workspace, scoped symbols, semantic
  analysis, typed AST/diagnostics and deterministic compatibility reporting.
- Pine lowering gained multiline object state, `fill()` between plots, drawing/display primitives,
  chart inputs, tuple assignments, switches, user functions, alerts and broader numeric/boolean
  expression coverage. Unsupported behavior continues to fail closed or report an approximation.
- Strategy Studio loads `request.security` data from the selected exchange and aligns external
  series consistently across preview, backtest and runtime evaluation.
- A reusable `strategy-core` and `backtest-core` now provide canonical TA, evaluation, broker,
  portfolio, warm-up, reporting, provenance and trace contracts.
- Backtest reports include data provenance, versioned strategy-event traces, deterministic
  execution traces and human-readable explanations of conditions, fills and state transitions.
- The chart exposes an accessible HTML alternative for focused/recent OHLC candles, strategy
  signals and executed trades.
- Trading gained durable order lifecycle states, signed status polling, private Binance/Bybit order
  streams, idempotent event ingestion and startup reconciliation for every in-flight order.
- Protected live entries require confirmed exchange-side stop-loss/take-profit acknowledgement;
  ambiguous outcomes pause automation and require operator review.
- English/Russian localization now covers chart controls, market shell, Strategy Studio, backtest,
  optimizer, trading access, bot creation, settings, commands and activity journals.
- Generated Pine compatibility, API endpoint and Blockly block-catalog references were added.
- Open-source governance documents, documentation checks, protected exchange-testnet smoke tests,
  reproducible release archives, SPDX SBOMs, SHA-256 checksums and Sigstore attestations were added.

### Changed

- The former monolithic Pine converter was decomposed into parser, semantic, expression,
  statement, drawing, strategy-call and serialization modules; its main coordinator fell from
  roughly 2,300 lines to under 1,000.
- `StrategyLab`, `TradingView`, `App` and bot activity views were split into feature controllers,
  panels, hooks and pure models with documented folder boundaries.
- Backtest execution, accounting, analytics and reporting were removed from the UI layer and placed
  behind reusable package APIs shared by frontend and backend runtimes.
- Chart rendering was divided into dirty base/interaction layers and isolated render passes so
  crosshair movement does not redraw the complete chart.
- Market disconnect, fallback and unavailable states are explicit; no zero-price synthetic value is
  accepted as trustworthy live-market data.

### Fixed

- Selected-exchange handling in Strategy Studio and external-series alignment were corrected.
- Ambiguous exchange failures are classified without blind resubmission.
- Indicator add-label behavior and the CI secret-scan ignore probe were corrected.

### Tests

- Added deterministic browser coverage for chart, indicators, Pine import, strategy research,
  backtests, authentication, paper-bot lifecycle, reconnect/unavailable states, keyboard focus and
  responsive layouts.
- Added Pine parser mutation/fuzz and conversion-determinism tests.
- Added parity/golden tests across preview, backtest, paper and live strategy evaluation.
- Added exchange failure-injection, lifecycle, polling, private-stream and startup-reconciliation
  suites. Authenticated testnet checks remain manually armed and never place production orders.

### Safety notes

- Pine compatibility is intentionally partial: every imported script must be reviewed for warnings
  and compared against TradingView on identical candles.
- Live trading remains experimental, opt-in and fail-closed. Start with paper/testnet, use keys
  without withdrawal rights, configure risk caps and verify exchange state independently.

## Earlier work

Work before this snapshot established the custom chart, visual strategy builder, initial Pine
importer, backtester, paper/live bot shell and Binance/Bybit market-data providers. See the Git
history and [implementation ledger](docs/IMPLEMENTATION_STATUS.md) for commit-level evidence.
