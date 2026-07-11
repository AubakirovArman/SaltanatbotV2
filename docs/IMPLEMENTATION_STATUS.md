# Improvement implementation status

Updated: 2026-07-11

Active branch: `main`

Source plan: [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md)

This is the execution ledger. It records what is proven complete, what is active, and what remains. A checked item requires code plus the listed verification evidence.

## Completed

### Runtime backup and recovery — 2026-07-11

- [x] Create consistent online SQLite snapshots instead of copying active database files directly.
- [x] Preserve `trading.db`, optional `candles.db`, `.secret` and `.authtoken` with owner-only modes.
- [x] Generate a versioned SHA-256 manifest and reject missing, extra, symlinked or modified files.
- [x] Run SQLite `PRAGMA quick_check` before backup, after backup and before restore.
- [x] Refuse accidental overwrite and use a verified staging directory plus rollback-safe atomic swap.
- [x] Add isolated tests for backup, verification, tamper detection, overwrite refusal and restore.
- [x] Document backup/recovery in English, Russian and Kazakh.
- [x] Replace implicit table creation with ordered transactional schema migrations.
- [x] Preserve legacy rows, record applied migration metadata and reject newer unsupported schemas.

Verification:

- Dedicated runtime backup/restore and schema-migration tests pass without reading or modifying real `backend/data`.
- Biome and documentation link/command checks pass.

### Exchange request safety — 2026-07-11

- [x] Share a signed-request rate-limit circuit across bots targeting the same exchange.
- [x] Honour bounded `Retry-After` periods for HTTP 429 and Binance 418 responses.
- [x] Detect Binance `-1021` and Bybit `10002` clock-skew failures with operator remediation.
- [x] Keep mutating calls non-retrying and preserve existing ambiguous transport classification.
- [x] Add deterministic guard, throttle, cap, expiry and clock-offset tests.

### Open-source security intake — 2026-07-11

- [x] Add structured secret-safe bug and outcome-focused feature request forms.
- [x] Route vulnerabilities to private GitHub security advisories and disable unsafe blank issues.
- [x] Add a PR verification/safety/compatibility checklist.
- [x] Publish assets, trust boundaries, mitigations, residual risks and explicit non-goals.
- [x] State that funded soak/mainnet readiness has not been proven.

### Frontend performance budgets — 2026-07-11

- [x] Record reviewed HTML, CSS, single-JS and total-JS gzip ceilings in version control.
- [x] Measure production output deterministically after build.
- [x] Fail pull-request, push and release CI when a budget regresses.
- [x] Keep the large Blockly chunk visible as an explicit optimization target.

### Shared deterministic test fixtures — 2026-07-11

- [x] Add a transport-neutral `@saltanatbotv2/test-fixtures` workspace.
- [x] Provide validated candle-series builders with timing, spread, volume and provenance controls.
- [x] Provide real Fetch API JSON/text responses and fail-closed scripted routing.
- [x] Migrate cross-runtime parity and exchange failure-injection tests to the shared fixtures.
- [x] Type-check the package independently and cover validation/unexpected-network behavior.

### Canonical execution core — 2026-07-11

- [x] Add a UI/transport/storage-free `@saltanatbotv2/execution-core` workspace.
- [x] Centralize adverse slippage and stop/target price resolution.
- [x] Centralize units, equity-percent and fail-closed risk-percent sizing with leverage/step caps.
- [x] Centralize monotonic durable order transitions and result-status derivation.
- [x] Connect both backtest-core and backend trading through compatibility facades.
- [x] Change live/paper risk-percent sizing without a stop from max-exposure fallback to skipped entry.
- [x] Check generated runtime/declarations and enforce the dependency boundary with parity tests.

### Runtime contracts and final P0 characterization — 2026-07-11

- [x] Upgrade `@saltanatbotv2/contracts` from declarations-only to generated runtime/declarations.
- [x] Validate catalog, candle-history and sparkline REST responses at the frontend transport edge.
- [x] Validate all snapshot/candle/status/error WebSocket variants and reject unknown messages.
- [x] Add OHLC consistency, enum, finite-number and unexpected-message failure coverage.
- [x] Move malformed WebSocket payloads into an explicit frontend error state.
- [x] Add direct chart drawing hit-test coverage for handles, bodies, z-order, locks and position areas.
- [x] Complete the P0 package/contract baseline; remaining work starts at P1.

### Foundation — commit `3a98684`

- [x] Fix zero-price synthetic fallback for dynamically discovered crypto pairs.
- [x] Seed dynamic instruments from positive Binance ticker prices.
- [x] Return explicit REST `503` / WebSocket error when neither real nor synthetic data is valid.
- [x] Add provider/discovery/fallback regression tests.
- [x] Add stateful frontend-preview/backend-evaluator parity coverage.
- [x] Fix `setvarb` preview parity defect.
- [x] Introduce `@saltanatbotv2/contracts` and canonical market/stream types.
- [x] Introduce `@saltanatbotv2/strategy-core` and canonical IR types/version.
- [x] Begin Pine converter decomposition with arguments, errors, language, text and expression-history modules.
- [x] Remove Blockly duplicate-registration warnings without breaking saved XML.
- [x] Add initial typed EN/RU UI locale support.
- [x] Add Russian README and documentation index.
- [x] Add architecture/testing/i18n/master-plan documents and source-folder READMEs.
- [x] Upgrade Vitest to a non-vulnerable release; full dependency audit is clean.
- [x] Add Playwright production-build harness.

Verification at commit:

- Biome passed.
- TypeScript passed for backend and frontend.
- 26 Vitest files / 267 tests passed in the integrated tree.
- Production build passed.
- 6 Playwright scenarios passed.
- `npm audit` reported zero vulnerabilities.

### Browser research and access flows — commit `bbf1f79`

- [x] Persist named chart workspaces through reload.
- [x] Run a real browser backtest and verify assumptions/metrics.
- [x] Verify invalid and valid Trade access tokens.
- [x] Convert Trade token entry to a semantic accessible form.

Verification:

- 9 Playwright scenarios passed on the production build.
- Biome, TypeScript and Vitest passed.

### Cycles Analysis compatibility — commit `8bda112`

- [x] Render imported Cycles Analysis with phase shading, crest lines and neutral reversal markers.
- [x] Add marker colors and optional box opacity/borders to the generic chart overlay model.
- [x] Replace obsolete generic converter warnings with explicit compatibility notes.
- [x] Normalize previously saved Cycles Analysis artifacts.
- [x] Show a compact cycle summary in the active chart chip.

Verification:

- Dedicated preview, compatibility and chart-overlay tests pass.
- Full Vitest and Playwright suites pass.

### Indicator and paper-trading browser flows — commit `eac37ec`

- [x] Configure and persist a built-in chart indicator.
- [x] Import a custom Pine indicator and add it to the live chart.
- [x] Create, start, command, inspect and stop a paper bot.

Verification:

- 12 Playwright scenarios passed on the production build.
- Biome, TypeScript and all 267 Vitest tests passed.

### Keyboard and responsive browser flows — commit `cff3382`

- [x] Trap command-palette focus and restore it to the opener on Escape.
- [x] Verify the chart remains usable at a narrow mobile viewport.
- [x] Stabilize catalog-dependent browser scenarios under full parallel load.

Verification:

- 14 Playwright scenarios passed together on the production build.
- Biome, TypeScript and all 267 Vitest tests passed.

### Pine display primitives and richer Cycles Analysis — commit `4f4134f`

- [x] Upgrade the shared strategy IR to version 4 with projection-zone and table-metric statements.
- [x] Round-trip both display primitives through Blockly, schema validation and text preview.
- [x] Map time-based Pine `box.new` calls to future projection zones.
- [x] Map numeric Pine `table.cell` calls to accessible HTML metric tables.
- [x] Add chart-side editors with persisted overrides for numeric and boolean Pine inputs.
- [x] Expand Cycles Analysis with crest labels, aggregate/percentile statistics and prediction zones.
- [x] Keep display-only nodes inert in live execution while rendering them in chart preview.

Verification:

- 27 Vitest files / 271 tests pass, including IR round-trip, schema, preview and Pine-conversion coverage.
- Biome and backend/frontend TypeScript checks pass.

### Backtest decomposition — commits `0e024cb`, `a5dda9b`

- [x] Extract display-metric collection and table shaping into `previewTables.ts`.
- [x] Extract public backtest contracts into `backtestTypes.ts` without breaking facade imports.
- [x] Extract deterministic performance analytics into `backtestMetrics.ts`.
- [x] Preserve all existing broker, preview, optimizer and report behavior through regression tests.

### Cycles Analysis modes and future chart space — commit `a5dda9b`

- [x] Add Percentage, Duration and Both direction modes with day/candle units.
- [x] Add minimum-duration filters, first-direction selection, stagnation and high/low markers.
- [x] Reserve chart space for future prediction zones and keep time/pixel transforms invertible.
- [x] Add collapsible accessible statistics/prediction tables and typed chart controls.

Verification:

- 28 Vitest files / 275 tests pass, including duration-mode and projection-viewport coverage.
- Biome and backend/frontend TypeScript checks pass.

### Trading frontend decomposition — commits `94d68d1`, `f45ed09`, `3461c2a`

- [x] Move the authentication gate and empty trading state into feature-owned components.
- [x] Move bot creation and validation into a feature-owned semantic form.
- [x] Add stable names to bot controls and retain native validation/submission behavior.
- [x] Reduce `TradingView.tsx` from 982 to 741 lines while preserving its controller role.
- [x] Move live arming, kill switch, API-key and notification settings into `TradingSettings.tsx`.
- [x] Give secret/notification controls visible labels, stable names and semantic submit behavior.
- [x] Reduce `TradingView.tsx` further to 578 lines.
- [x] Move bot lifecycle actions, runtime cards, command console and journals into `BotDetail.tsx`.
- [x] Reduce `TradingView.tsx` to a 241-line socket/list/selection controller.

### Strategy Lab decomposition — commits `cbf6b4c`, `1effaae`

- [x] Move artifact browsing, import/export, Pine entry and template gallery into `strategy/components/StrategyLibrary.tsx`.
- [x] Add a feature-folder README documenting the new UI boundary.
- [x] Reduce `StrategyLab.tsx` from 1,138 to 931 lines without changing its public facade.
- [x] Move optimizer/walk-forward controls and results into `OptimizePanel.tsx`.
- [x] Move sweep-state creation and worker-spec shaping into `optimization/model.ts`.
- [x] Reduce `StrategyLab.tsx` further to 617 lines and add direct model tests.
- [x] Extract backtest configuration, execution toolbar, diagnostics and result/preview rendering into `StrategyExecutionPanel.tsx`.
- [x] Reduce `StrategyLab.tsx` to a Blockly lifecycle and execution controller.
- [x] Reduce `StrategyLab.tsx` further to 332 lines by extracting research orchestration.
- [x] Extract Blockly injection, theme, resize, preview debounce, artifact loading, autosave and teardown into `useStrategyWorkspace`.
- [x] Reduce `StrategyLab.tsx` to a 149-line feature composition facade.

### Trading engine decomposition — commit `9e048b6`

- [x] Extract pure position-sizing and stop/target calculations into `engineRisk.ts`.
- [x] Add focused quote/equity/risk sizing and long/short stop/target tests.
- [x] Keep exchange orchestration and order lifecycle unchanged behind the `TradingEngine` facade.

### Trading localization — commit `11783cd`

- [x] Add a typed EN/RU trading message catalog.
- [x] Localize trading access, empty state, bot creation labels and primary actions.
- [x] Pass locale explicitly through the trading feature boundary.
- [x] Extend browser locale coverage into the Russian Trade authentication flow.

### Pine compiler public contracts — commit `4e8ffea`

- [x] Add a public AST type facade independent of parser implementation imports.
- [x] Add typed warning/error diagnostics with stable codes and source-span contracts.
- [x] Preserve legacy warning strings while exposing structured diagnostics to future editors.
- [x] Attach typed diagnostics to public `PineConvertError` instances.

### Pine semantic and drawing decomposition — commit `fe41a7a`

- [x] Extract pure boolean folding/type detection from `convert.ts`.
- [x] Extract collection/object call classification and reassignment analysis.
- [x] Extract fill/shading/label/line/box/projection/table lowering behind an explicit drawing context.
- [x] Add direct semantic-helper tests in addition to the Pine corpus.
- [x] Add direct drawing-lowering tests in addition to display-primitive corpus coverage.
- [x] Reduce `convert.ts` from 2,233 to 1,916 lines without changing its public facade.

### Pine numeric call decomposition

- [x] Extract numeric built-in dispatch behind a typed lowering context.
- [x] Extract boolean built-in dispatch and rising/falling window semantics behind a typed lowering context.
- [x] Extract numeric operators, ternaries and bounded history access behind a typed lowering context.
- [x] Extract logical/comparison operators, `na` tests, string selectors, ternaries and boolean history.
- [x] Centralize typed numeric/boolean identifier resolution and opaque-state degradation.
- [x] Extract value and statement switch lowering with deterministic default behavior.
- [x] Extract call-by-value user-function inlining, lexical restoration, tuple returns and recursion guards.
- [x] Extract ordered typed value classification without fallback guessing.
- [x] Extract strategy entries, closes, protections, sizing and fail-closed risk semantics.
- [x] Extract bounded generic statement/control-flow dispatch and constant branch folding.
- [x] Extract direct, user-function and built-in tuple destructuring.
- [x] Extract immutable/mutable assignment state, one-time initialization and special handle bindings.
- [x] Extract declaration/default sizing, plot/marker and alert statement calls.
- [x] Extract drawing, mutation, collection and unsupported-call statement coordination.
- [x] Split Blockly XML serialization into XML primitives, statement, numeric and boolean modules.
- [x] Preserve `irToXml.ts` as a backward-compatible facade and add direct serializer round-trip tests.
- [x] Introduce exception-safe nested value/type scopes and a typed global function symbol table.
- [x] Apply lexical scopes to `if`/`for`/`while` bodies and user-function inlining.
- [x] Add direct tests for indicator, arithmetic, external boolean-series and fail-closed paths.
- [x] Add direct tests for cross, multi-bar trend, external boolean-series and conservative timeframe paths.
- [x] Reduce `convert.ts` from 1,916 to 977 lines after completing statement lowering decomposition.

### Trading activity decomposition — commit `4335465`

- [x] Split command composition/saved commands into `BotCommandConsole.tsx`.
- [x] Split orders, order journal, fills and logs into `BotActivity.tsx`.
- [x] Replace journal layout divs with semantic HTML tables and labeled sections.
- [x] Isolate below-the-fold journal rendering with `content-visibility` plus intrinsic-size and containment fallback.
- [x] Reduce `BotDetail.tsx` from 349 to 97 lines.

## Completed browser baseline

### Critical browser E2E expansion

Current: 18 scenarios implemented; the original critical-flow checklist is complete.

- [x] Terminal/chart smoke.
- [x] Keyboard command palette and symbol switch.
- [x] Lazy Strategy workspace.
- [x] Theme persistence.
- [x] Pine indicator import.
- [x] EN/RU locale persistence.
- [x] Named workspace persistence.
- [x] Backtest execution/report.
- [x] Trade authentication gate.
- [x] Add/configure/persist a built-in indicator.
- [x] Add a saved custom indicator to the chart.
- [x] Create/start/stop a paper bot and inspect its order journal.
- [x] Keep paper lifecycle E2E independent from public exchange latency via the deterministic local feed.
- [x] WebSocket disconnect/reconnect without duplicated candles.
- [x] Visible unavailable/fallback market-data state.
- [x] Keyboard/focus behavior for modal dialogs and menus.
- [x] Responsive monitoring smoke test.

## Remaining architecture work

### Pine compiler

- [x] Resolve explicit Pine v4/v5/v6 profiles before lexing removes pragmas.
- [x] Reject unsupported versions and surface missing/mixed-version APIs through typed diagnostics.
- [x] Attach remediation to all public compiler diagnostics.
- [x] Enforce canonical source, token, AST, nesting, loop and generated-IR resource budgets.
- [x] Test deterministic profile metadata, diagnostics and budget failures.
- [x] Add exact token ranges and propagated AST spans without changing executable semantics.
- [x] Link semantic diagnostics and generated body/init IR paths back to Pine statements.
- [x] Replace the scattered unsupported-function decision tree with a public ordered registry.
- [x] Emit a versioned exact/approximation/display-only/rejected evidence report without confidence percentages.
- [x] Preserve reports through import and render localized summary labels, source lines and remediation.
- [x] Check byte-stable v4/v6 conversion-result golden hashes.
- [x] Record source, author, SPDX decision, acquisition date and SHA-256 for every external Pine file.
- [x] Restrict real-world compiler corpus tests to hash-verified MPL-2.0 samples; keep unknown-license files audit-only.
- [x] Fail docs CI when Pine provenance, file coverage, license headers or hashes drift.
- [x] Persist immutable Pine source/profile/diagnostic/report evidence with imported artifacts.
- [x] Show original Pine, generated Blockly workspace and compiled preview side by side in Strategy Studio.
- [x] Focus the exact read-only source selection when a user activates a diagnostic.

- [x] Extract AST and public diagnostic types with source-span contracts.
- [x] Extract semantic scope/symbol/function analysis.
  - [x] Extract current pure semantic classification helpers from lowering.
  - [x] Introduce explicit nested scopes and typed symbol/function tables.
  - [x] Add a pure pre-lowering analysis pass for scope trees, symbols, references, shadowing, forward functions and reassignment classification.
- [x] Extract expression lowering.
  - [x] Extract numeric built-in function-call dispatch.
  - [x] Extract boolean built-in function-call dispatch.
  - [x] Extract numeric operators and history access.
  - [x] Extract remaining boolean expression lowering.
  - [x] Extract identifier resolution.
  - [x] Extract switch lowering.
  - [x] Extract user-function inlining.
  - [x] Extract general value coordination.
- [x] Extract statement and strategy-call lowering.
  - [x] Extract strategy-call lowering.
  - [x] Extract generic statement/control-flow lowering.
  - [x] Extract tuple statements.
  - [x] Extract assignment state.
  - [x] Extract declaration, plot/marker and alert statements.
  - [x] Extract final drawing/fallback call coordinator.
- [x] Extract drawing lowering.
- [x] Extract Blockly serialization.
- [x] Add a typed compatibility registry and Markdown matrix generated from both Pine corpora.
- [x] Fail documentation CI when generated compatibility artifacts are stale.
- [x] Add deterministic parser fuzz, valid-seed mutation and conversion-determinism property tests.
- [x] Move the pure compiler into `packages/pine-compiler`.
  - [x] Give the package one deliberate public entry point and an independent TypeScript check.
  - [x] Preserve old frontend implementation imports through one-line compatibility facades.
  - [x] Enforce the browser/UI-free dependency boundary with an architecture test.

### Strategy and backtest core

- [x] Make every backtest result a self-contained schema-v1 research report.
- [x] Freeze symbol, timeframe, exchange, market/price type, strategy hash, data range and normalized execution config.
- [x] Publish pessimistic intrabar, gap, stop/target, fee, funding, leverage, liquidation and final-close assumptions.
- [x] Detect partially loaded history and bounded missing-bar gap details.
- [x] Fingerprint settings, data range/quality and provenance; reject incompatible report comparisons with field reasons.
- [x] Export a versioned `.saltanat-report.json` envelope from the report UI.
- [x] Build a deterministic random-access replay timeline joining strategy explanations, variable changes, broker events, equity, signals and trades.
- [x] Add accessible previous/next/range replay controls to every non-empty backtest report.
- [x] Publish versioned deterministic execution benchmarks for next-open/final-close, gap stops, favourable gap targets and pessimistic stop priority.
- [x] Verify reviewed expected trades and byte-deterministic reports for every benchmark.

- [x] Move shared TA implementations into `strategy-core` and retain frontend/backend compatibility facades.
- [x] Move the canonical evaluator, reusable runtime, execution budgets, security-series alignment and intent types into `strategy-core`.
- [x] Create `backtest-core` with canonical contracts, broker, portfolio, warm-up, reporting and analytics modules.
  - [x] Keep frontend import compatibility through one-line facades.
  - [x] Independently compile runtime/declaration artifacts and fail checks when they are stale.
  - [x] Enforce the UI/browser-free package boundary with an architecture test.
- [x] Split backtest into execution, portfolio/accounting, analytics, preview and trace/report modules.
  - [x] Extract chart preview, display-statement execution and preview result types.
  - [x] Extract execution/fill simulation.
    - [x] Extract slippage, protective-price and stop/target hit primitives.
    - [x] Move historical execution orchestration behind a dedicated module and stable facade.
  - [x] Extract portfolio sizing and accounting.
    - [x] Extract sizing, leverage/quantity guardrails and unrealized-PnL primitives.
    - [x] Extract pure position open/close accounting, commissions, excursions and trade records.
  - [x] Move deterministic analytics into `backtest-core/metrics.ts`.
  - [x] Extract trace/report assembly.
    - [x] Extract exhaustive warm-up/lookback analysis, including nested control flow and dynamic floors.
    - [x] Extract position/daily-stat evaluator context and bounded variable-trace collection.
    - [x] Move measured-range, metrics, trace and provenance assembly into `backtest-core/report.ts`.
- [x] Add versioned golden event traces across preview/backtest/paper/live.
  - [x] Add JSON-safe StrategyBarTrace v1 intents with fixed semantic ordering.
  - [x] Check one golden fixture through preview, backtest and the evaluator used by paper/live.
  - [x] Extend traces with expression/variable explanations, fill decisions, position/equity transitions, warnings and provenance.
    - [x] Add BacktestExecutionTrace v1 for scheduled/dropped fills and rejected entries.
    - [x] Record position/equity transitions, funding, stable warning codes and final provenance.
    - [x] Prove JSON safety and byte determinism with direct execution-trace tests.
    - [x] Add bounded statement-path explanations and compact sorted variable-change events in StrategyBarTrace v2.
    - [x] Preserve the V1 semantic golden while comparing complete V2 traces across preview/backtest/paper/live.
- [x] Add missing/fallback-data provenance to every report.
  - [x] Aggregate source labels across chart and `request.security` candles in `backtest-core`.
  - [x] Treat synthetic, routed fallback, mixed and unlabelled inputs as invalid for performance claims.
  - [x] Surface status, bar counts, source details and an accessible warning in every backtest report.
  - [x] Cover real, fallback, mixed, external-series and browser-report paths.

### Frontend decomposition

- [x] Split `StrategyLab` into build/validate/preview/backtest/optimize/library controllers and panels.
  - [x] Extract library, optimizer and execution/result panels.
  - [x] Extract Blockly workspace lifecycle/autosave controller.
  - [x] Extract shared paginated history loading for backtest, optimizer and security-data windows.
  - [x] Extract cancellable backtest/optimizer orchestration into `useStrategyResearch`.
  - [x] Ignore stale progress/results and abort in-flight history/security requests on teardown.
- [x] Split `TradingView` into auth/bots/orders/portfolio/settings feature modules.
- [x] Reduce `App.tsx` to composition and routing state.
  - [x] Extract strategy artifact persistence, sharing, creation, import, version/hash and linked-indicator synchronization into `useArtifactLibrary` plus a pure model.
  - [x] Reduce `App.tsx` from 782 to under 600 lines without changing workspace flows.
  - [x] Extract artifact compilation, `request.security`, preview/backtest overlay, input overrides and chart focus into `useChartArtifactOverlay`.
  - [x] Reject stale async overlay results after market/timeframe/request changes and cover the race directly.
  - [x] Reduce `App.tsx` further to 529 lines.
  - [x] Extract shell/workspace persistence, compare migration and preferences into `useAppShell` plus `shellStorage`.
  - [x] Extract command construction, palette state and global shortcuts into `useAppCommands`.
  - [x] Apply persisted theme before React boot and synchronize native `color-scheme`/theme metadata.
  - [x] Reduce `App.tsx` to a 291-line workspace composition root.
- [x] Split chart orchestration into dirty render layers.
  - [x] Separate persistent base and transparent interaction canvases.
  - [x] Coalesce rapid invalidations in one RAF with base-before-interaction ordering.
  - [x] Prove crosshair-only invalidation never calls the base renderer.
  - [x] Split the base layer into axes/grid, primary series, indicators and drawing/strategy overlay canvases.
  - [x] Reuse one prepared viewport/indicator render plan across passes and rebind volatile overlay inputs without recomputation.
  - [x] Extract canvas ownership/ResizeObserver/invalidation into `useChartRenderer` and chart chrome into a focused renderer.
  - [x] Verify primary, indicator and overlay pass isolation with recording-context tests.
- [x] Add an accessible DOM/table alternative for focused OHLC, signals and trades.
  - [x] Link the Canvas accessible description to a synchronized focused/latest-candle summary without pointer-driven live-region noise.
  - [x] Add a keyboard-operable panel with native tables for focused and recent OHLC, signals and executed trades.
  - [x] Bound each history view to 20 newest rows and preserve total signal/trade counts.
  - [x] Cover table semantics, empty data and keyboard opening in component and browser tests.

### Trading engine hardening

- [x] Complete durable exchange order state machine.
  - [x] Persist intent before exchange I/O in a dedicated lifecycle module.
  - [x] Persist accepted, rejected and fill outcomes in deterministic order.
  - [x] Classify thrown/ambiguous adapter outcomes as `unknown` and rethrow them.
  - [x] Prevent exchange submission when durable intent persistence fails.
  - [x] Reconcile `intent` and `unknown` records against visible exchange orders after restart.
  - [x] Pause resumed trading when an unresolved result cannot be proven from exchange state.
  - [x] Model accepted, partial-fill, filled, cancel, expire and replace states explicitly.
  - [x] Correlate asynchronous paper fills to their original resting-order journal entries.
  - [x] Ingest asynchronous exchange events that advance accepted/partial states to terminal states.
    - [x] Resolve aggregate snapshots to one durable intent by venue or client identity.
    - [x] Share one ingest boundary between signed polling and future private streams.
    - [x] Ignore duplicate/replayed updates and reject identity conflicts or state/quantity regressions.
    - [x] Connect authenticated Binance/Bybit stream events to the ingest boundary.
- [x] Add private fill/order stream with polling fallback.
  - [x] Add bounded signed REST order-status polling for Binance and Bybit.
  - [x] Normalize partial, filled, cancelled, expired and rejected venue states.
  - [x] Persist idempotent aggregate execution snapshots and polling audit events.
  - [x] Add authenticated Binance USDⓈ-M and Bybit private order/execution streams with heartbeat, reconnect and REST gap reconciliation.
- [x] Require explicit Binance/Bybit SL/TP acknowledgement before protected runtime state.
- [x] Fail the entry result and issue a best-effort emergency close when requested SL or TP is rejected.
- [x] Complete startup reconciliation for every in-flight state.
  - [x] Query signed venue status sequentially for `intent`, `unknown`, `accepted` and `partially_filled` rows before resume.
  - [x] Fall back to matching open orders only when that evidence proves the original command outcome.
  - [x] Require terminal evidence for interrupted cancel commands and manual review for ambiguous replace commands.
  - [x] Mark crash-left intent `unknown` and pause the bot whenever an outcome remains unproven.
- [x] Keep live spot fail-closed by default behind an explicit experimental inventory override.
- [x] Add fake-exchange transport, protection, status-polling and failure-injection suites.
- [x] Add opt-in Binance/Bybit testnet release checks.
  - [x] Refuse network access without an explicit runtime arm flag and reject every production/non-HTTPS base URL.
  - [x] Verify Binance signed balance plus listenKey lifecycle and Bybit signed wallet/open-order reads without placing orders.
  - [x] Add signing, endpoint-guard and request-contract tests with fake transports.
  - [x] Add a manually dispatched workflow behind the protected `exchange-testnet` GitHub environment.

### Documentation, localization and open source

- [x] Move remaining UI strings into typed messages.
  - [x] Localize the accessible chart-data panel, captions, headers, empty states and signal/trade terminology through typed EN/RU messages.
  - [x] Localize the complete trading workspace: bot creation, settings/secrets, confirmations, runtime cards, command console/reference and order/fill journals.
  - [x] Localize Strategy Studio controls, template library, Pine import, backtest reports and optimizer/walk-forward research.
  - [x] Localize command search/actions, watchlist filters/favorites, bar/feed statistics and price-alert controls/toasts.
  - [x] Localize chart drawings, indicator/artifact inputs, compare controls, chart types and saved workspaces.
- [x] Complete Russian user-guide parity for the current chart, strategy research and trading product surfaces.
  - [x] Add the Russian chart navigation and accessible table-data guide.
  - [x] Add the Russian paper/live trading, key safety, recovery, command-console and journal guide.
  - [x] Add the Russian Strategy Studio, Pine import, backtest assumptions and optimization guide.
- [x] Generate API/block/Pine compatibility reference from source contracts.
  - [x] Generate Pine compatibility TypeScript and Markdown references from corpus metadata.
  - [x] Generate the Express HTTP/WS endpoint index and strategy block-catalog reference with deterministic check mode.
- [x] Add `SECURITY.md`, `CODE_OF_CONDUCT.md`, changelog and support policy.
- [x] Add documentation link/example checks to CI.
- [x] Add nightly/alpha/beta/stable release channels, SPDX SBOMs, SHA-256 checksums and GitHub/Sigstore-signed provenance/SBOM attestations.

## Quality gates for every following commit

Required unless the commit only changes prose:

```bash
npm run lint
npm run check
npm test
npm run build
```

Run `npm run test:e2e` for any user-visible frontend, API or persistence change. Run `npm audit` after dependency changes.
