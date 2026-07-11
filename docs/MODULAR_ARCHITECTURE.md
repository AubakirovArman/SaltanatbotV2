# Modular architecture

This document defines the target module boundaries and the safe decomposition sequence for the current large files.

## Dependency direction

```text
apps (React / Express)
  -> application use cases
    -> domain packages
      -> pure contracts and primitives

infrastructure adapters (SQLite / Binance / Bybit / WebSocket)
  -> application ports
  -> domain packages
```

Domain packages must never import React, Express, `window`, filesystem or network code. Infrastructure is replaceable through explicit ports.

## Target repository layout

```text
apps/
  web/                         React terminal
  server/                      Express and WebSocket composition root
packages/
  contracts/                   API, WS, Candle, Instrument, MarketKey
  strategy-core/               IR, schema, evaluator, TA, traces
  pine-compiler/               lexer, parser, analysis, lowering
  backtest-core/               fills, portfolio, accounting, metrics
  execution-core/              order state machine and risk primitives
  chart-core/                  viewport, scales, drawings, render model
  test-fixtures/               candles, strategies, fake exchanges
docs/
  en/                          canonical user and engineering docs
  ru/                          Russian translations
```

The move to `apps/` is optional and should happen after shared packages exist. Renaming directories early creates noise without improving boundaries.

## File and module budgets

Budgets are review signals, not automatic design laws:

- pure domain module: target <= 300 lines;
- React component: target <= 250 lines;
- hook/controller: target <= 200 lines;
- adapter: target <= 400 lines;
- no file should exceed 600 lines without a documented reason;
- public barrel files contain exports only;
- each module exposes a deliberate public API through `index.ts`;
- tests live beside a module or in a mirrored test directory, but use one convention per package.

## Pine compiler decomposition

Current facade: `frontend/src/strategy/pine/index.ts`.

Target:

```text
pine/
  README.md
  index.ts                     stable public facade
  language/
    versions.ts
    builtins.ts
    compatibility.ts
  lexer/
    token.ts
    scanner.ts
    literals.ts
  parser/
    ast.ts
    expressions.ts
    statements.ts
    declarations.ts
    parser.ts
  analysis/
    scope.ts
    symbols.ts
    types.ts
    functions.ts
    diagnostics.ts
    resourceBudget.ts
  normalize/
    controlFlow.ts
    state.ts
    series.ts
  lowering/
    context.ts
    expressions.ts
    statements.ts
    indicators.ts
    drawings.ts
    strategies.ts
  blockly/
    serialize.ts
    xml.ts
  tests/
    fixtures/
    golden/
```

Safe extraction order:

1. introduce shared types and diagnostics without changing behavior;
2. extract XML escaping/building helpers;
3. extract builtin/function registries;
4. extract expression conversion;
5. extract statements and strategy calls;
6. extract drawing conversion;
7. introduce semantic-analysis and normalization passes;
8. move the resulting pure compiler into `packages/pine-compiler`.

`convertPine()` remains the facade throughout. Golden tests must prove identical output after every extraction.

## Backtest decomposition

```text
backtest/
  index.ts
  config.ts
  runtime.ts
  evaluator.ts                 consumes strategy-core
  intents.ts
  execution/
    fillTiming.ts
    slippage.ts
    stops.ts
    targets.ts
    liquidation.ts
  portfolio/
    position.ts
    sizing.ts
    accounting.ts
    funding.ts
  analytics/
    metrics.ts
    excursions.ts
    equity.ts
    testedRange.ts
  preview/
    plots.ts
    shapes.ts
    signals.ts
  trace/
    events.ts
    explanations.ts
```

The orchestrator should describe the bar loop; pricing and accounting rules should be independently testable pure functions.

## Strategy Lab decomposition

```text
features/strategy-lab/
  StrategyLab.tsx              composition only
  model/
    useArtifactSession.ts
    useCompilation.ts
    useBacktest.ts
    useOptimizer.ts
  build/
    BlocklyWorkspace.tsx
    Toolbox.tsx
    BlockInspector.tsx
  validate/
    DiagnosticsPanel.tsx
  preview/
    PreviewPanel.tsx
  backtest/
    BacktestPanel.tsx
  optimize/
    OptimizerPanel.tsx
  library/
    ArtifactLibrary.tsx
    ImportExportActions.tsx
  pine/
    PineImportDialog.tsx
    ConversionReport.tsx
```

Components receive data and callbacks; artifact persistence, network requests and compiler calls live in model/use-case layers.

## Blockly decomposition

- one block-definition module per toolbox category;
- one compiler module per IR node family;
- metadata registry is canonical for title, help, inputs, output and examples;
- registration is idempotent to prevent duplicate global Blockly definitions;
- toolbox generation consumes metadata rather than duplicating labels;
- each block has compile and XML round-trip tests.

## Trading frontend decomposition

```text
features/trading/
  TradingView.tsx
  auth/
  bots/
  portfolio/
  orders/
  journal/
  settings/
  notifications/
  model/
  api/
```

Authentication/session code must remain separate from bot presentation. Server response types come from `packages/contracts`.

## Trading engine decomposition

```text
trading/
  engine/
    TradingEngine.ts           public facade
    BotActor.ts                serial event queue
    lifecycle.ts
    marketEvents.ts
    strategyRunner.ts
    riskGuard.ts
    reconciliation.ts
  orders/
    stateMachine.ts
    journal.ts
    idempotency.ts
    protection.ts
  ports/
    ExchangePort.ts
    MarketDataPort.ts
    TradingStore.ts
    NotificationPort.ts
  adapters/
    paper/
    binance/
    bybit/
    sqlite/
```

The engine coordinates ports. Exchange-specific signing, payloads and error mapping stay in adapters.

## Chart decomposition

Use a retained render model with explicit dirty layers:

- data/transform layer;
- viewport and scales;
- grid/time/price axes;
- primary series;
- indicators and comparison series;
- drawings and strategy overlays;
- interaction/hit testing;
- crosshair/tooltip accessibility model.

Crosshair movement must not recompute indicators or rebuild unaffected layers. Heavy calculations should expose a worker-compatible pure API.

## Folder documentation convention

Every maintained source directory receives a `README.md`. It must answer:

1. What responsibility does this directory own?
2. What is its public entry point?
3. Which dependencies are allowed and forbidden?
4. What invariants must remain true?
5. How is it tested?
6. How should a contributor add a new capability?
7. Which files are transitional or scheduled for extraction?

Do not create empty README boilerplate in asset/generated directories. Required scope is source, packages, test suites and user-facing documentation trees.

## Architectural enforcement

Add automated checks gradually:

- dependency-cycle detection;
- forbidden import rules between UI/domain/infrastructure;
- duplicate contract detection;
- file-size report in CI, initially informational;
- API Extractor or TypeScript declaration checks for shared package surfaces;
- architecture decision records under `docs/adr/`;
- CODEOWNERS after maintainers emerge.

## Refactoring pull-request template

Every decomposition PR states:

- behavior being preserved;
- characterization tests protecting it;
- old and new module boundaries;
- dependency changes;
- migration/facade strategy;
- measured bundle/runtime effect;
- follow-up extraction left intentionally out of scope.
