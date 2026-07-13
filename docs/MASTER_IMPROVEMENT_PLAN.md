# SaltanatbotV2 master improvement plan

Status: P0/P1/P2 delivered; funded exchange soak explicitly deferred
Created: 2026-07-11  
Product stage: early alpha

This document is the single entry point for improving SaltanatbotV2. Detailed safety evidence is in [CODE_IMPROVEMENT_PLAN.md](./CODE_IMPROVEMENT_PLAN.md); Pine language coverage remains in [PINE_COVERAGE.md](./PINE_COVERAGE.md).

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
| Chart | Custom Canvas chart, twelve chart types including configurable confirmed Renko, Line Break, Kagi and Point & Figure; indicators, drawings, compare, alerts | Alpha, broad functionality |
| Market data | Binance, Bybit, explicit fallback/unavailable states, REST/WebSocket history and SQLite cache | Alpha, guarded fallback behavior |
| Strategy authoring | Blockly editor, templates, indicator artifacts, safe JSON IR | Alpha |
| Pine import | Modular v4/v5/v6 compiler, semantic analysis, typed diagnostics, compatibility registry and fuzz tests | Experimental, explicit fidelity |
| Research | Shared evaluator/backtest cores, provenance, traces, optimizer, walk-forward and Monte Carlo | Alpha, reproducible contracts |
| Execution | Durable lifecycle, polling/private streams, reconciliation and fail-closed protection | Experimental; live is not production-ready |
| Security | Scoped sessions, CSRF/WS tickets, encrypted keys, audit log and verified backup/restore | Strong alpha baseline |
| Distribution | Installable production PWA with a static offline shell and network-only runtime/trading boundary | Alpha, verified offline boundary |
| Tests | 700+ unit/integration/parity tests plus a 46-scenario Playwright production suite | Strong baseline, enforced in CI |
| Documentation | Source-checked English docs and current RU/KK user guides with public Pages | Current alpha baseline |
| Localization | Complete typed English/Russian/Kazakh UI catalogs and user documentation | Three-locale product baseline complete |

## Guiding engineering rules

- Preserve behavior before refactoring it. Add characterization tests around a large module before splitting it.
- One domain concept has one canonical type and implementation. Shared IR and evaluator code must not be copied between frontend and backend.
- Trading correctness wins over UI convenience. Live paths fail closed; synthetic fallback is never used for execution.
- Pine import is a compiler pipeline, not a text converter. Unsupported semantics are explicit errors or visible fidelity warnings.
- Every public module has a narrow API. UI components do not import storage, network and compiler internals directly.
- Documentation changes in the same pull request as behavior.
- Accessibility, keyboard operation and reduced motion are release criteria, not optional polish.
- Performance work is measured with budgets and traces rather than inferred from file size alone.

## Completed P0/P1/P2 scope decision

All Priority 0, 1 and 2 repository work is delivered except **Mainnet readiness and the continuous
7–14-day Binance/Bybit testnet soak**. The owner has explicitly deferred that epic because funded
testnet/mainnet validation is not currently available. No release note or UI may imply that this
external soak was completed. Deterministic fake-exchange, failure-injection and offline recovery
tests remained in scope and are part of the enforced release gate. The external soak is not silently
reclassified as complete and live trading remains Experimental.

## Priority 0: establish a trustworthy baseline

These items precede broad feature work.

### P0.1 Correct dynamic-market fallback

Status: delivered and covered by provider/router regression tests.

Before P0, dynamic crypto instruments could use `basePrice: 0`, allowing a failed public provider to produce zero-valued fallback OHLC candles.

Required outcome:

- capture a usable reference price during discovery, retrieve a ticker lazily, or disable synthetic fallback for an unseeded instrument;
- return an explicit unavailable state instead of a valid-looking zero chart;
- add router, REST and WebSocket regression tests for an unseeded dynamic pair.

### P0.2 Make documentation match runtime behavior

Status: delivered with source/generated documentation checks in CI.

- document `next_open` as the default fill timing;
- document leverage caps, quantity steps, funding, liquidation, warm-up and MAE/MFE;
- correct the default host and shutdown behavior;
- add an automated documentation link check and examples compiled in CI where practical.

### P0.3 Freeze behavioral contracts before decomposition

Status: delivered for Pine round-trip, evaluator parity, viewport/hit testing, trading lifecycle and
public market REST/WebSocket runtime schemas.

Add characterization tests for:

- Pine input -> AST -> conversion result -> Blockly XML -> IR round trip;
- strategy IR -> preview/backtest/backend intent parity;
- chart viewport, coordinate conversion and hit testing;
- TradingEngine state transitions and idempotency;
- REST and WebSocket message schemas.

### P0.4 Create canonical shared packages

Status: delivered. Contracts, strategy, execution, backtest and deterministic fixture workspaces are
independently checked; further fixture migration is maintenance rather than a P0 blocker.

Introduce npm workspaces incrementally:

- `packages/contracts`: Candle, Instrument, MarketKey, API and WebSocket contracts;
- `packages/strategy-core`: IR, schema, evaluator and TA primitives;
- `packages/execution-core`: fill assumptions, sizing and order lifecycle primitives (delivered and
  consumed by backtest plus backend trading facades);
- `packages/test-fixtures`: candle series, strategy fixtures and fake exchanges (canonical
  candle/Fetch builders and a transport-neutral scripted exchange are delivered and checked).

No package may depend on React, Express, browser globals or exchange SDK details unless its name explicitly describes that adapter.

## Priority 1: modular architecture

Follow [MODULAR_ARCHITECTURE.md](./MODULAR_ARCHITECTURE.md).

Status: delivered for the P1 boundary. All selected facades were decomposed and CI now rejects any
undocumented source file above 600 lines. Four cohesive pure-domain algorithm modules retain narrow,
reasoned ceilings in `config/source-file-budgets.json`; increasing or adding an exception requires an
explicit architecture change.

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

- [x] version-aware language profiles for Pine v4/v5/v6;
- [x] source spans on tokens, AST nodes, diagnostics and generated artifacts;
- [x] typed diagnostics with code, severity, source range and remediation;
- [x] resource budgets for file size, lines, tokens, AST size/nesting, loops and generated IR;
- [x] explicit unsupported-feature registry instead of scattered function conditions;
- [x] conversion report showing exact, approximated, display-only and rejected constructs;
- [x] side-by-side source, generated blocks and preview comparison;
- [x] deterministic output snapshots;
- [x] a public compatibility matrix generated from tests;
- [x] fuzzing and property tests for lexer/parser safety;
- [x] a corpus of real permissively licensed scripts, stored with provenance.

Conversion confidence must never be a vague percentage. It should be derived from explicit diagnostics and semantic categories.

## Priority 1: research and backtest credibility

- [x] unify the evaluator and indicator math with live execution;
- [x] publish all fill assumptions in every report;
- [x] make timeframe, exchange, market type, price type and data range immutable report metadata;
- [x] identify missing bars, fallback data and partially loaded history;
- [x] add benchmark/reference strategies with expected trades;
- [x] model market/limit/stop gaps, volume-participation partial fills, fees/assets, funding/borrow and liquidation consistently;
- [x] separate strategy performance from execution assumptions through immutable config/assumption metadata;
- [x] add bar replay with deterministic stepping and an explanation trace;
- [x] add out-of-sample, anchored/rolling walk-forward and parameter stability views;
- [x] add exportable, versioned research reports;
- [x] prevent accidental comparison of runs using different data or settings.

## Priority 1: paper and live execution safety

The detailed blockers are maintained in `CODE_IMPROVEMENT_PLAN.md`. Release gates additionally require:

- [x] explicit `experimental` labels in the UI and docs;
- [x] testnet support and an operator checklist before mainnet (continuous funded soak remains explicitly excluded);
- [x] exchange capability matrices for spot/linear/inverse, order types and protection behavior;
- [x] private order/fill streams with polling fallback;
- [x] a durable order state machine and idempotent client order IDs;
- [x] reconciliation before a bot can enter `running`;
- [x] clock-skew detection for Binance/Bybit signed APIs;
- [x] proactive request-weight budgets and reactive exchange-wide rate-limit circuits;
- [x] real fee asset, partial-fill and realized-PnL accounting;
- [x] verified SQLite backup/atomic restore and transactional forward-migration tests;
- [x] disaster scenarios: process death, network partition, duplicate event, stale candle, exchange timeout and rejected protection.

## Priority 2: chart and terminal experience

- [x] layout presets and resizable/dockable panels;
- [x] multi-chart layouts with linked symbol, interval, crosshair and drift-free UTC viewport;
- [x] bounded automatic last-session recovery for multi-chart layout, independent pane markets and link preferences;
- [x] independent pointer/trackpad/keyboard price-axis scaling with automatic reset;
- [x] indicator pane management and per-series scale placement;
- [x] drawing object tree, visibility lock, templates and undo/redo;
- [x] replay controls and jump-to-trade/signal;
- [x] data-status panel exposing provider, market type, latency, gaps and fallback state;
- [x] watchlist virtualization and quote-stream aggregation;
- [x] keyboard command discoverability and user-customizable shortcuts;
- [x] autosaved workspace versions and export/import;
- [x] accessible tabular alternatives for chart OHLC, indicators, signals and trades;
- [x] responsive monitoring experience; full Blockly editing remains desktop/tablet focused.

Canvas content needs a maintained DOM alternative today. Experimental HTML-in-Canvas APIs may only be used behind feature detection and cannot replace the fallback until browser support is broad.

## Priority 2: Strategy and Indicator Studio

- [x] separate Build, Validate, Preview, Backtest, Optimize, Run and Learn concerns;
- [x] block inspector with description, inputs, outputs, examples and pitfalls;
- [x] guided strategy wizard producing ordinary editable Blockly XML;
- [x] inline compile diagnostics linked to blocks and Pine source spans;
- [x] parameter schema with min/max/step/default and optimization eligibility;
- [x] reusable user-defined functions and indicator subgraphs;
- [x] artifact history, semantic version, IR hash and migration metadata;
- [x] dependency graph for indicators used by strategies;
- [x] diff and rollback between versions;
- [x] safe share files with schema version, checksums and provenance;
- [x] marketplace is explicitly deferred until signing, moderation, permissions and supply-chain policy exist.

## Priority 2: accessibility and internationalization

Follow [I18N_AND_DOCUMENTATION.md](./I18N_AND_DOCUMENTATION.md) and [TESTING_STRATEGY.md](./TESTING_STRATEGY.md).

Minimum product languages:

- English as the canonical engineering language;
- Russian as the first complete translation;
- architecture ready for additional locales and RTL.

Accessibility release criteria include keyboard-only operation, visible focus, semantic modal behavior, screen-reader announcements, non-color status indicators, 200% zoom, reduced motion and accessible alternatives to chart-only information.

Status: delivered for the alpha release baseline and enforced by the production browser suite. See
[ACCESSIBILITY.md](./ACCESSIBILITY.md). A current multi-screen-reader manual matrix remains a stable
release gate rather than an alpha P2 blocker.

## Priority 2: open-source readiness

- [x] add `SECURITY.md`, vulnerability disclosure and supported-version policy;
- [x] add `CODE_OF_CONDUCT.md`, issue forms and PR templates;
- [x] document release channels: nightly, alpha, beta, stable;
- [x] add signed release artifacts, checksums and SBOM;
- [x] add per-file distribution manifests and an attested controlled-corruption/atomic-rollback drill;
- [x] add categorized GitHub release-note automation and migration notes;
- [x] publish threat model and explicit non-goals;
- [x] add contributor maps for chart, Pine, strategy core, providers and execution;
- [x] define screenshot, asset and sample licensing/provenance rules;
- [x] add a public demo mode that cannot mutate live trade or exchange-key state.

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
| Performance | Enforced HTML/CSS/JS bundle budgets | Runtime/interaction benchmarks plus tightened budgets |
| Security | Dependency audit + auth tests | Threat model + release review |
| Data migration | Forward migration | Backup/restore/rollback rehearsal |

## Delivered sequence

### Milestone A: trustworthy alpha foundation

- [x] fix zero-price fallback;
- [x] correct documentation drift;
- [x] install the browser E2E harness and critical journeys;
- [x] extract shared contracts and strategy core;
- [x] publish explicit experimental/live-trading warnings.

### Milestone B: compiler and studio modularization

- [x] split Pine converter into pipeline modules;
- [x] split block definitions/compiler by category;
- [x] decompose Strategy Lab into feature panels and hooks;
- [x] add conversion diagnostics UI and golden corpus reports.

### Milestone C: research confidence

- [x] split backtest engine into evaluation, execution, accounting and metrics;
- [x] add replay/explanation traces;
- [x] enforce data provenance and report versioning;
- [x] add cross-runtime golden parity tests.

### Milestone D: execution hardening

- [x] complete order lifecycle, private fill ingestion and reconciliation;
- [x] finish fail-closed spot inventory;
- [x] add offline exchange conformance, opt-in testnet smoke and failure-injection suites;
- [x] rehearse backup and crash recovery deterministically.

### Milestone E: open-source beta

- [x] complete English/Russian product and EN/RU/KK user-documentation coverage;
- [x] meet accessibility and performance budgets;
- [x] publish contributor/security/release policies;
- [x] implement reproducible signed release packaging for configured channels.

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
