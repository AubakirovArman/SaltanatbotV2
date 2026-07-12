# Changelog

All notable user-visible and engineering changes are recorded here. The project follows a
Keep a Changelog–style structure and uses semantic versioning for tagged releases.

## Unreleased

### Precision chart experience

- Made every Canvas layer Retina/HiDPI-correct: backing stores now follow CSS size × device-pixel ratio while renderers, pointers, wheel gestures, overlays and the price HUD share one CSS-pixel coordinate space.
- Made 2×2 chart layouts independently usable by default: panes 2–4 expose numbered symbol/timeframe/type selectors, choosing a symbol or interval automatically unlinks that field, and the chain controls can explicitly restore primary-chart synchronization.
- Added adaptive multi-chart chrome: the primary pane keeps the single global indicator/compare editor in non-wrapping rows, secondary panes omit those duplicate controls, and UTC session/structure analysis is now a compact keyboard-expandable disclosure instead of a permanently open card over price.
- Added active-pane focus and reversible in-terminal maximize for every 2/4-chart pane. Native toggle buttons, `Escape` restore and a customizable `Alt+Enter` shortcut preserve each mounted chart's symbol, zoom, offset and stream; a maximized secondary pane restores the full drawing rail and indicator editor.
- Made the active pane the real command target: the top-bar symbol, timeframe and chart-type controls, command palette and timeframe shortcuts now update the focused chart; editing a secondary pane automatically unlinks only the changed symbol/timeframe while leaving the primary chart untouched.
- Made the market watchlist, top-bar feed state, live quote/statistics, data-quality diagnostics and price-alert form follow the active pane. Secondary panes publish their existing typed stream snapshot only while active, avoiding duplicate WebSocket subscriptions and background whole-shell rerenders.
- Added a ref-counted browser market-stream pool: chart consumers with the same exchange, symbol and timeframe now share one physical WebSocket while retaining isolated handlers, reconnect state, history and teardown; different market keys remain independent.
- Raised only the aggregate JavaScript gzip allowance from 454 KiB to 455 KiB for the measured shared-socket lifecycle boundary; per-chunk, CSS and HTML limits remain unchanged.
- Added independent per-pane indicator sets with an accessible link toggle. Editing a maximized secondary pane snapshots bounded parameters/visibility locally, leaves the primary untouched, survives reload and workspace revisions, and can relink to the canonical primary set without duplicating Pine/Blockly logic.
- Migrated named workspaces to schema v4 and automatic last-chart sessions to v2 while accepting legacy v1 sessions as linked-indicator layouts.
- Raised only the aggregate JavaScript gzip allowance from 455 KiB to 456 KiB for the measured bounded indicator-override normalizer, migration and controls; per-chunk, CSS and HTML limits remain unchanged.
- Added a bounded versioned last-chart-session snapshot that automatically restores layout, independent pane symbols/timeframes/types and link preferences after reload, while keeping transient maximize state and named workspace revision history separate.
- Raised only the aggregate JavaScript gzip allowance from 453 KiB to 454 KiB for the measured strict session normalizer/migration boundary; per-chunk, CSS and HTML limits remain unchanged.
- Added DPR 1/2 unit and browser coverage for physical backing resolution, pointer-HUD alignment, the fixed CSS-width price-axis target and independent four-symbol selection.
- Added independent manual price-axis scaling from 25% to 400%: wheel/trackpad and vertical drag on the right axis no longer alter candle zoom, while Arrow/Page keys, `Home` and double-click provide keyboard/reset parity.
- Applied manual bounds consistently in linear, logarithmic and percentage modes, invalidated depth/footprint geometry with the price scale, exposed `AUTO/NN%` beside the mode and added a focus-visible semantic slider over the axis.
- Raised the aggregate JavaScript gzip allowance from 452 KiB to 453 KiB and CSS from 16 KiB to 17 KiB for the measured price-axis model/control; per-chunk and HTML limits remain unchanged.
- Added opt-in visible-time-range linking across 2/4-chart layouts: zoom and pan publish absolute UTC boundaries, and every linked pane maps them to its own symbol/timeframe without index drift or feedback loops.
- Persisted the new range-link preference in workspace schema v3, default-migrated older workspaces, added a keyboard-addressable per-pane toggle and compact container-responsive controls.
- Raised only the aggregate JavaScript gzip allowance from 451 KiB to 452 KiB for the measured linked-viewport protocol/UI; per-chunk, CSS and HTML limits remain unchanged.
- Added a zero-persistence `Shift`-drag quick ruler with live signed price/percentage change, exact bar distance and elapsed time; `Escape` or the next normal chart drag dismisses the result.
- Reworked persistent measurement drawings with directional range shading, a two-line badge that stays inside the plot and a synchronized localized DOM result; extracted chart legend and measurement rendering from the near-budget Canvas coordinator.
- Raised only the aggregate JavaScript gzip allowance from 450 KiB to 451 KiB for the measured ruler/semantic-output addition; per-chunk, CSS and HTML limits remain unchanged.
- Added confirmed close-only Point & Figure with alternating X/O columns, fixed seeded percentage boxes, configurable multi-box reversals, source-volume aggregation and no provisional live column.
- Integrated Point & Figure into the shared viewport/settings/catalog/semantic pipeline, including synchronized box/reversal controls, dynamic accessible descriptions and dedicated Canvas glyph rendering.
- Added persistent, fail-closed construction controls for confirmed price-based charts: Renko brick percentage, Kagi reversal percentage and Line Break reversal depth now rebuild the entire shared display series immediately.
- Added dynamic chart legends and accessible Canvas descriptions, explicit labels/help text, per-parameter reset, Escape dismissal and coarse-pointer targets for the compact settings disclosure.
- Raised the aggregate JavaScript gzip allowance from 448 KiB to 450 KiB and CSS from 15 KiB to 16 KiB for the typed settings/persistence/control layer; all per-chunk and HTML limits remain unchanged.
- Reworked chart navigation for mouse wheels and Mac trackpads: non-passive containment prevents page zoom leakage, frame-coalesced proportional zoom filters inertial tails, horizontal gestures pan, pinch is normalized and zoom stays anchored under the pointer.
- Added primary-button-only drag panning, safe pointer-cancel cleanup, grab/grabbing feedback and an always-visible localized zoom percentage/reset control.
- Prevented sparse price-based time labels from overlapping and switched axis labels to exact transformed-series timestamps instead of median-interval extrapolation.
- Made sparse transformed-price series use the available X-axis width, with zoom-aware visible-leg counts and bounded pan instead of clustering a few Kagi reversals in the top-left corner.
- Added confirmed close-only Kagi with a fixed 0.10%-seeded reversal, continuous price-extreme legs, shoulder/waist turns, aggregated source volume and no provisional live projection.
- Integrated Kagi into the shared transformed-price pipeline, chart catalog, workspaces, semantic OHLC table, localized accessible picker and full Canvas/indicator/market-structure interaction model.
- Raised only the aggregate JavaScript gzip budget from 446 KiB to 448 KiB for the added chart type; per-chunk, CSS and HTML limits remain unchanged.
- Replaced the viewport-dependent Renko approximation with a full-history confirmed close-only model: fixed 0.05%-seeded boxes, true two-box reversals, multi-brick source bars, aggregated volume and actual discarded-close wicks.
- Unified Heikin Ashi, Renko and Three Line Break behind one prepared display-candle pipeline so zoom/pan no longer reseeds Heikin Ashi and Canvas, crosshair, drawings, native indicators, market structure and semantic tables consume the same representation.
- Made the open chart-data region keyboard-focusable and uniquely keyed same-time synthetic rows, closing a Safari scroll-region WCAG 2.1.1 regression found by the expanded Renko axe journey.
- Added a close-only, non-repainting Three Line Break price representation with strict three-line reversal confirmation, compressed time columns and aggregated source volume.
- Reworked viewport timestamp interpolation so drawings, crosshairs, strategy markers and semantic OHLC data remain aligned across market gaps and price-compressed charts; extracted chart-type icons/labels from the top-bar coordinator.
- Added non-repainting confirmed market structure on every timeframe: delayed fractal swing labels (HH/LH/HL/LL) and close-confirmed BOS/CHOCH overlays, with adjustable strength.
- Added optional three-closed-candle fair value gap zones that remain open until full later wick mitigation, plus localized keyboard controls and a synchronized semantic summary.
- Added independently toggleable Asia, London and New York high/low session boxes on 1m–1h charts, using IANA time zones for daylight-saving-aware boundaries and a cached timestamp conversion path for live updates.
- Kept regional-session shading behind candles, exposed the latest ranges as semantic DOM text and documented that these are time windows rather than exchange-holiday calendars or trading signals.
- Added a one-click Anchored VWAP drawing with cumulative bar-based typical-price weighting, a translucent ±1σ value area, ±1σ/±2σ lines, editable anchors and symbol-scoped persistence through the existing drawing system.
- Added a synchronized semantic AVWAP legend and fail-closed history handling: a saved anchor never silently restarts from incomplete loaded candles.
- Added an opt-out UTC session-liquidity map with bar-based session VWAP and volume-weighted ±1σ bands, session open/high/low, authoritative previous-day high/low from daily exchange candles and confirmed wick-and-reclaim sweep markers.
- Integrated the analysis into the existing dirty overlay pass and paired it with a keyboard-operable toggle plus a synchronized semantic DOM summary; live-tail candles cannot emit confirmed sweeps.
- Added a persisted in-chart microstructure alert center for stacked imbalance, provisional absorption, CVD spikes and configurable large prints, with bounded deduplication, dismiss/clear controls, optional sound and opt-in desktop notifications.
- Added keyboard-operable native disclosure settings, an `aria-live` event feed and field-by-field validation/clamping for locally stored thresholds; heuristic alerts remain separate from durable price alerts and Telegram delivery.
- Added transparent live footprint analytics: 3:1 diagonal imbalance outlines, three-row stacked-imbalance brackets and explicitly provisional absorption markers when strong observed delta fails to close in the aggressor's half of the candle.
- Added a synchronized accessible cluster summary and documented volume, visibility, zoom and live-observation thresholds so these heuristics are never presented as historical exchange signals.
- Added a real Binance/Bybit public-trade footprint that groups exchange-reported aggressor prints by candle and visible price row, plus quote-notional delta bars and a cumulative-delta line.
- Added a shared bounded `/trade-flow` backend stream, strict runtime contracts, explicit lifecycle states and off-screen/background suspension without fabricated historical prints.
- Added a real public Binance/Bybit top-20 order-book heatmap with one shared upstream per market, bounded four-Hz browser snapshots and a 60-second liquidity trail aligned to the chart price scale.
- Added explicit connecting/reconnecting/stale/error states, background-tab stream pausing, sequence-aware Bybit snapshot/delta handling and no synthetic depth fallback.
- Added an explicitly labelled OHLCV-estimated visible-range Volume Profile with range-weighted volume distribution, up/down composition, Point of Control and a contiguous 70% value area.
- Added an accessible localized toolbar toggle and synchronized DOM summary while keeping profile calculations out of crosshair-only render passes.
- Added hollow-candle and step-line price renderers to the shared market contract, catalog, chart picker, compare overlays and saved-workspace migration.
- Added a DPR-aware current-price pill with candle-close countdown and a crosshair OHLC/change/volume HUD without invalidating Canvas render layers every second.
- Added a trailing 24-hour price-range visualization to the instrument panel and tightened the dark terminal palette, tool rail, candle geometry and data hierarchy.
- Moved pre-paint theme initialization to a same-origin asset so the production Content Security Policy no longer blocks it.
- Updated English, Russian and Kazakh chart documentation and added focused contract, renderer, countdown and session-range tests.

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
- Added an enforced 600-line TypeScript architecture budget with narrow reviewed ceilings for four
  cohesive pure-domain algorithm modules.
- Completed the shared fixture baseline with a transport-neutral scripted fake exchange for
  deterministic outcomes, account reads and private-stream disconnect/reconnect tests.
- Added durable bot-attributed live-spot inventory with weighted average, per-asset fees,
  deduplication and inventory-constrained close/restart behavior.
- Added complete `MarketKey` envelopes for execution candles and protected-entry lifecycle evidence,
  including Binance entry/SL/TP identities and typed Bybit position-level acknowledgement.
- Upgraded trading persistence to schema v2 with durable position snapshots and logical strategy-run
  records alongside orders, events and confirmed fills.

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
- Upgraded official checkout/setup actions to their Node 24-compatible majors, removing GitHub's
  Node 20 deprecation annotations from CI, Pages, release and opt-in testnet workflows.

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
