# Backtest core

Runtime-neutral historical trading primitives shared independently of the React application.

## Owned contracts and behavior

- backtest configuration, trades, equity points, metrics and report contracts;
- slippage, stop/target resolution and hit detection;
- position sizing, leverage/quantity guardrails and open/close accounting;
- exhaustive StrategyIR warm-up analysis;
- evaluator context and bounded variable traces;
- deterministic performance and risk metrics.
- versioned evaluator event traces attached to every backtest result.
- chart and `request.security` candle-source provenance, including explicit performance-claim validity.

The package may depend on `@saltanatbotv2/contracts` and `@saltanatbotv2/strategy-core`. It must not import React, Blockly, browser globals, storage, network or exchange adapters.

Canonical TypeScript sources are compiled to checked-in JavaScript and declaration artifacts. `npm run check -w @saltanatbotv2/backtest-core` fails when generated files are stale.
