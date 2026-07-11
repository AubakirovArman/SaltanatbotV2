# Improvement implementation status

Updated: 2026-07-11

Active branch: `codex/improvement-roadmap`

Source plan: [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md)

This is the execution ledger. It records what is proven complete, what is active, and what remains. A checked item requires code plus the listed verification evidence.

## Completed

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

### Trading activity decomposition — commit `4335465`

- [x] Split command composition/saved commands into `BotCommandConsole.tsx`.
- [x] Split orders, order journal, fills and logs into `BotActivity.tsx`.
- [x] Replace journal layout divs with semantic HTML tables and labeled sections.
- [x] Isolate below-the-fold journal rendering with `content-visibility` plus intrinsic-size and containment fallback.
- [x] Reduce `BotDetail.tsx` from 349 to 97 lines.

## Completed browser baseline

### Critical browser E2E expansion

Current: 17 scenarios implemented; the original critical-flow checklist is complete.

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
- [x] WebSocket disconnect/reconnect without duplicated candles.
- [x] Visible unavailable/fallback market-data state.
- [x] Keyboard/focus behavior for modal dialogs and menus.
- [x] Responsive monitoring smoke test.

## Remaining architecture work

### Pine compiler

- [ ] Extract AST and public diagnostic types with source spans.
- [ ] Extract semantic scope/symbol/function analysis.
- [ ] Extract expression lowering.
- [ ] Extract statement and strategy-call lowering.
- [ ] Extract drawing lowering.
- [ ] Extract Blockly serialization.
- [ ] Add compatibility registry generated from corpus metadata.
- [ ] Add parser fuzz/property tests.
- [ ] Move the pure compiler into `packages/pine-compiler`.

### Strategy and backtest core

- [ ] Move shared TA implementations into `strategy-core`.
- [ ] Move the canonical evaluator and intent types into `strategy-core`.
- [ ] Split backtest into execution, portfolio/accounting, analytics, preview and trace modules.
- [ ] Add versioned golden event traces across preview/backtest/paper/live.
- [ ] Add missing/fallback-data provenance to every report.

### Frontend decomposition

- [ ] Split `StrategyLab` into build/validate/preview/backtest/optimize/library controllers and panels.
- [x] Split `TradingView` into auth/bots/orders/portfolio/settings feature modules.
- [ ] Reduce `App.tsx` to composition and routing state.
- [ ] Split chart orchestration into dirty render layers.
- [ ] Add an accessible DOM/table alternative for focused OHLC, signals and trades.

### Trading engine hardening

- [ ] Complete durable exchange order state machine.
  - [x] Persist intent before exchange I/O in a dedicated lifecycle module.
  - [x] Persist accepted, rejected and fill outcomes in deterministic order.
  - [x] Classify thrown/ambiguous adapter outcomes as `unknown` and rethrow them.
  - [x] Prevent exchange submission when durable intent persistence fails.
  - [x] Reconcile `intent` and `unknown` records against visible exchange orders after restart.
  - [x] Pause resumed trading when an unresolved result cannot be proven from exchange state.
  - [ ] Model partial fill, cancel, expire and replace transitions explicitly.
- [ ] Add private fill/order stream with polling fallback.
- [ ] Confirm exchange-side protection before protected state.
- [ ] Complete startup reconciliation for every in-flight state.
- [ ] Complete spot inventory accounting or keep live spot disabled.
- [ ] Add fake-exchange conformance and failure-injection suites.
- [ ] Add opt-in Binance/Bybit testnet release checks.

### Documentation, localization and open source

- [ ] Move remaining UI strings into typed messages.
- [ ] Complete Russian user-guide parity.
- [ ] Generate API/block/Pine compatibility reference from source contracts.
- [x] Add `SECURITY.md`, `CODE_OF_CONDUCT.md`, changelog and support policy.
- [x] Add documentation link/example checks to CI.
- [ ] Add release channels, SBOM, checksums and signed artifacts.

## Quality gates for every following commit

Required unless the commit only changes prose:

```bash
npm run lint
npm run check
npm test
npm run build
```

Run `npm run test:e2e` for any user-visible frontend, API or persistence change. Run `npm audit` after dependency changes.
