# Backtest core

Runtime-neutral historical trading primitives shared independently of the React application.

## Owned contracts and behavior

- backtest configuration, trades, equity points, metrics and report contracts;
- slippage, stop/target resolution and hit detection;
- position sizing, leverage/quantity guardrails and open/close accounting;
- chronological multi-symbol candidate replay through one mark-to-market capital pool, with concurrent/gross/position allocation limits, per-market contribution and correlation analytics;
- exhaustive StrategyIR warm-up analysis;
- evaluator context and bounded variable traces;
- deterministic performance and risk metrics.
- versioned evaluator event traces attached to every backtest result.
- chart and `request.security` candle-source provenance, including explicit performance-claim validity.
- canonical final report assembly from execution outputs, including measured range, metrics, traces and provenance.
- versioned JSON-safe historical execution traces for fills, position/equity transitions, funding, warnings and provenance.
- schema-v1 immutable report metadata with normalized execution assumptions,
  strategy/data identity, gap/partial-history audit and a comparison key;
- deterministic compatibility checks plus exportable versioned research files.
- deterministic random-access bar replay joining evaluator explanations,
  variable changes, broker events, equity, signals and trade boundaries.
- public reviewed benchmark strategies/candles/expected trades for signal timing,
  gap-aware stop/target fills and ambiguous intrabar priority.
- canonical historical market/limit/stop stepping with gap-aware fills,
  volume-participation partials, maker/taker distinction and quote-fee records.

The package may depend on `@saltanatbotv2/contracts` and `@saltanatbotv2/strategy-core`. It must not import React, Blockly, browser globals, storage, network or exchange adapters.

Canonical TypeScript sources are compiled to checked-in JavaScript and declaration artifacts. `npm run check -w @saltanatbotv2/backtest-core` fails when generated files are stale.
