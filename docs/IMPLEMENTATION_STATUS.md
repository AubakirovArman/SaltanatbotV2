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

## In progress

### Critical browser E2E expansion

Current: 14 scenarios implemented.

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
- [ ] WebSocket disconnect/reconnect without duplicated candles.
- [ ] Visible unavailable/fallback market-data state.
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
- [ ] Split `TradingView` into auth/bots/orders/portfolio/settings feature modules.
- [ ] Reduce `App.tsx` to composition and routing state.
- [ ] Split chart orchestration into dirty render layers.
- [ ] Add an accessible DOM/table alternative for focused OHLC, signals and trades.

### Trading engine hardening

- [ ] Complete durable exchange order state machine.
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
- [ ] Add `SECURITY.md`, `CODE_OF_CONDUCT.md`, changelog and support policy.
- [ ] Add documentation link/example checks to CI.
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
