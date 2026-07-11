# SaltanatbotV2 master improvement plan

Status: active  
Created: 2026-07-11  
Product stage: early alpha

This document is the single entry point for improving SaltanatbotV2. Detailed safety work remains in [CODE_IMPROVEMENT_PLAN.md](./CODE_IMPROVEMENT_PLAN.md); Pine language coverage remains in [PINE_COVERAGE.md](./PINE_COVERAGE.md).

## Product promise

SaltanatbotV2 should become a free, self-hosted and inspectable trading workstation where a user can:

1. explore live Binance and Bybit markets on a professional chart;
2. create indicators and strategies visually;
3. import supported Pine Script into an editable local representation;
4. understand conversion limitations before trusting the result;
5. replay and backtest with reproducible assumptions;
6. move through preview, paper and live execution without changing strategy semantics;
7. keep keys, strategies and trading data under their own control.

It is not enough to resemble TradingView visually. The differentiator must be traceability: every signal and order should be explainable from source script to IR, chart, backtest, paper fill and live fill.

## Current capabilities

| Area | Current state | Maturity |
| --- | --- | --- |
| Chart | Custom Canvas chart, seven chart types, indicators, drawings, compare, alerts | Alpha, broad functionality |
| Market data | Binance, Bybit, synthetic data, REST history, WebSocket updates, SQLite candle cache | Alpha, correctness work required |
| Strategy authoring | Blockly editor, templates, indicator artifacts, safe JSON IR | Alpha |
| Pine import | Pine v5/v6 lexer, parser and conversion with warnings and corpus tests | Experimental |
| Research | Backtest, optimizer, walk-forward and Monte Carlo | Alpha |
| Execution | Paper, Binance and Bybit adapters, order journal, reconciliation and safeguards | Experimental; live is not production-ready |
| Security | Local binding, roles, HttpOnly session, CSRF, one-use WS tickets, encrypted keys, audit log | Strong alpha baseline |
| Tests | 282 unit/integration/parity tests plus a 17-scenario Playwright production suite | Strong baseline, expanding |
| Documentation | Substantial English docs plus several internal plans | Useful but drifting |
| Localization | UI strings are embedded in components | Not started |

## Guiding engineering rules

- Preserve behavior before refactoring it. Add characterization tests around a large module before splitting it.
- One domain concept has one canonical type and implementation. Shared IR and evaluator code must not be copied between frontend and backend.
- Trading correctness wins over UI convenience. Live paths fail closed; synthetic fallback is never used for execution.
- Pine import is a compiler pipeline, not a text converter. Unsupported semantics are explicit errors or visible fidelity warnings.
- Every public module has a narrow API. UI components do not import storage, network and compiler internals directly.
- Documentation changes in the same pull request as behavior.
- Accessibility, keyboard operation and reduced motion are release criteria, not optional polish.
- Performance work is measured with budgets and traces rather than inferred from file size alone.

## Priority 0: establish a trustworthy baseline

These items precede broad feature work.

### P0.1 Correct dynamic-market fallback

Dynamic crypto instruments currently use `basePrice: 0`. If a public provider fails, the synthetic fallback produces zero OHLC candles.

Required outcome:

- capture a usable reference price during discovery, retrieve a ticker lazily, or disable synthetic fallback for an unseeded instrument;
- return an explicit unavailable state instead of a valid-looking zero chart;
- add router, REST and WebSocket regression tests for an unseeded dynamic pair.

### P0.2 Make documentation match runtime behavior

- document `next_open` as the default fill timing;
- document leverage caps, quantity steps, funding, liquidation, warm-up and MAE/MFE;
- correct the default host and shutdown behavior;
- add an automated documentation link check and examples compiled in CI where practical.

### P0.3 Freeze behavioral contracts before decomposition

Add characterization tests for:

- Pine input -> AST -> conversion result -> Blockly XML -> IR round trip;
- strategy IR -> preview/backtest/backend intent parity;
- chart viewport, coordinate conversion and hit testing;
- TradingEngine state transitions and idempotency;
- REST and WebSocket message schemas.

### P0.4 Create canonical shared packages

Introduce npm workspaces incrementally:

- `packages/contracts`: Candle, Instrument, MarketKey, API and WebSocket contracts;
- `packages/strategy-core`: IR, schema, evaluator and TA primitives;
- `packages/execution-core`: fill assumptions, sizing and order lifecycle primitives;
- `packages/test-fixtures`: candle series, strategy fixtures and fake exchanges.

No package may depend on React, Express, browser globals or exchange SDK details unless its name explicitly describes that adapter.

## Priority 1: modular architecture

Follow [MODULAR_ARCHITECTURE.md](./MODULAR_ARCHITECTURE.md).

The first decomposition targets are selected by size, churn and risk:

1. Pine converter;
2. backtest runtime;
3. Strategy Lab;
4. Blockly block definitions and compiler;
5. TradingView;
6. TradingEngine;
7. App shell;
8. chart orchestration.

Each extraction must:

- keep the old public entry point temporarily as a facade;
- move one responsibility at a time;
- add or retain tests before deleting old code;
- avoid mixed refactoring and behavior changes;
- stay reviewable, preferably below 500 changed lines per PR unless mechanical.

## Priority 1: Pine import as a first-class compiler

### Pipeline

```text
source -> lexer -> parser -> normalized AST -> semantic analysis
       -> compatibility diagnostics -> IR lowering -> Blockly serialization
```

Required improvements:

- version-aware language profiles for Pine v4/v5/v6;
- source spans on tokens, AST nodes, diagnostics and generated artifacts;
- typed diagnostics with code, severity, source range and remediation;
- resource budgets for file size, tokens, nesting, loops and generated IR;
- explicit unsupported-feature registry instead of scattered conditions;
- conversion report showing exact, approximated, display-only and rejected constructs;
- side-by-side source, generated blocks and preview comparison;
- deterministic output snapshots;
- a public compatibility matrix generated from tests;
- fuzzing and property tests for lexer/parser safety;
- a corpus of real permissively licensed scripts, stored with provenance.

Conversion confidence must never be a vague percentage. It should be derived from explicit diagnostics and semantic categories.

## Priority 1: research and backtest credibility

- unify the evaluator and indicator math with live execution;
- publish all fill assumptions in every report;
- make timeframe, exchange, market type, price type and data range immutable report metadata;
- identify missing bars, fallback data and partially loaded history;
- add benchmark/reference strategies with expected trades;
- model limit orders, gaps, partial fills, fees, funding, borrow costs and liquidation consistently;
- separate strategy performance from execution assumptions;
- add bar replay with deterministic stepping and an explanation trace;
- add out-of-sample, anchored/rolling walk-forward and parameter stability views;
- add exportable, versioned research reports;
- prevent accidental comparison of runs using different data or settings.

## Priority 1: paper and live execution safety

The detailed blockers are maintained in `CODE_IMPROVEMENT_PLAN.md`. Release gates additionally require:

- explicit `experimental` labels in the UI and docs;
- testnet support and an operator checklist before mainnet;
- exchange capability matrices for spot/linear/inverse, order types and protection behavior;
- private order/fill streams with polling fallback;
- a durable order state machine and idempotent client order IDs;
- reconciliation before a bot can enter `running`;
- clock-skew detection;
- rate-limit budgets and circuit breakers;
- real fee asset, partial-fill and realized-PnL accounting;
- backup/restore and migration tests for SQLite;
- disaster scenarios: process death, network partition, duplicate event, stale candle, exchange timeout and rejected protection.

## Priority 2: chart and terminal experience

- layout presets and resizable/dockable panels;
- multi-chart layouts with linked symbol, interval and crosshair;
- indicator pane management and per-series scale placement;
- drawing object tree, visibility lock, templates and undo/redo;
- replay controls and jump-to-trade/signal;
- data-status panel exposing provider, market type, latency, gaps and fallback state;
- watchlist virtualization and quote-stream aggregation;
- keyboard command discoverability and user-customizable shortcuts;
- autosaved workspace versions and export/import;
- accessible tabular alternatives for chart OHLC, indicators, signals and trades;
- responsive monitoring experience; full Blockly editing remains desktop/tablet focused.

Canvas content needs a maintained DOM alternative today. Experimental HTML-in-Canvas APIs may only be used behind feature detection and cannot replace the fallback until browser support is broad.

## Priority 2: Strategy and Indicator Studio

- separate Build, Validate, Preview, Backtest, Optimize, Run and Learn concerns;
- block inspector with description, inputs, outputs, examples and pitfalls;
- guided strategy wizard producing ordinary editable Blockly XML;
- inline compile diagnostics linked to blocks and Pine source spans;
- parameter schema with min/max/step/default and optimization eligibility;
- reusable user-defined functions and indicator subgraphs;
- artifact history, semantic version, IR hash and migration metadata;
- dependency graph for indicators used by strategies;
- diff and rollback between versions;
- safe share files with schema version, checksums and provenance;
- marketplace is deferred until signing, moderation, permissions and supply-chain policy exist.

## Priority 2: accessibility and internationalization

Follow [I18N_AND_DOCUMENTATION.md](./I18N_AND_DOCUMENTATION.md) and [TESTING_STRATEGY.md](./TESTING_STRATEGY.md).

Minimum product languages:

- English as the canonical engineering language;
- Russian as the first complete translation;
- architecture ready for additional locales and RTL.

Accessibility release criteria include keyboard-only operation, visible focus, semantic modal behavior, screen-reader announcements, non-color status indicators, 200% zoom, reduced motion and accessible alternatives to chart-only information.

## Priority 2: open-source readiness

- add `SECURITY.md`, vulnerability disclosure and supported-version policy;
- add `CODE_OF_CONDUCT.md`, issue forms and PR templates;
- document release channels: nightly, alpha, beta, stable;
- add signed release artifacts, checksums and SBOM;
- add changelog automation and migration notes;
- publish threat model and explicit non-goals;
- add contributor maps for chart, Pine, strategy core, providers and execution;
- define licensing/provenance rules for Pine corpus and screenshots;
- add a public demo mode that cannot mutate trade state.

## Priority 3: later product opportunities

- plugin API based on declarative, versioned schemas rather than arbitrary JavaScript;
- additional exchanges through a conformance-tested adapter interface;
- server-side strategy library and optional encrypted synchronization;
- collaborative sharing only as an opt-in service separate from local-first core;
- broker/exchange sandbox integrations;
- order book, footprint and advanced market data where licensing permits;
- reproducible strategy packages and community review signatures.

## Test and quality gates

No milestone is complete merely because it builds.

| Gate | Alpha requirement | Stable requirement |
| --- | --- | --- |
| Type/lint/unit | Required | Required |
| Contract tests | Required for changed API | All public contracts |
| Browser E2E | Critical journeys | Critical + secondary journeys |
| Accessibility | Automated + keyboard smoke | WCAG-oriented manual matrix |
| Visual regression | Core desktop views | Desktop/mobile/themes/locales |
| Backtest/live parity | Fixture coverage | Versioned golden traces |
| Exchange adapter | Fake server | Testnet conformance |
| Performance | Bundle warning tracked | Enforced budgets |
| Security | Dependency audit + auth tests | Threat model + release review |
| Data migration | Forward migration | Backup/restore/rollback rehearsal |

## Proposed delivery sequence

### Milestone A: trustworthy alpha foundation

- fix zero-price fallback;
- correct documentation drift;
- install browser E2E harness and first five critical journeys;
- extract shared contracts and strategy core;
- publish explicit experimental/live-trading warnings.

### Milestone B: compiler and studio modularization

- split Pine converter into pipeline modules;
- split block definitions/compiler by category;
- decompose Strategy Lab into feature panels and hooks;
- add conversion diagnostics UI and golden corpus reports.

### Milestone C: research confidence

- split backtest engine into evaluation, execution, accounting and metrics;
- add replay/explanation traces;
- enforce data provenance and report versioning;
- add cross-runtime golden parity tests.

### Milestone D: execution hardening

- complete order lifecycle, private fill ingestion and reconciliation;
- finish spot inventory or keep it disabled;
- add exchange testnet conformance and failure-injection suites;
- rehearse backup and crash recovery.

### Milestone E: open-source beta

- complete English/Russian product and documentation coverage;
- meet accessibility and performance budgets;
- publish contributor/security/release policies;
- tag reproducible signed beta releases.

## Definition of done for any feature

- behavior and failure modes are specified;
- domain logic is separated from UI/transport/storage;
- unit and integration tests cover success, boundary and failure cases;
- a browser E2E covers user-visible critical behavior;
- accessibility and keyboard behavior are verified;
- documentation and translations are updated;
- telemetry-free local diagnostics are available;
- migration/backward compatibility is addressed;
- performance and security impact are reviewed;
- no new unexplained warning is introduced.

## Explicit non-goals for the alpha phase

- claiming full Pine compatibility;
- claiming live trading is production-safe;
- arbitrary third-party JavaScript plugins;
- custody of user funds or hosted key storage;
- social/copy trading before execution correctness;
- mobile-first Blockly authoring;
- hiding provider fallback or conversion approximations from users.
