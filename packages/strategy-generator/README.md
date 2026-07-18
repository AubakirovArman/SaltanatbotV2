# Bounded strategy generator core

This package contains a deterministic **algorithmic** strategy generator. It is
a closed grammar and genetic search primitive; it is not AI or ML and must not
be described as either in product copy. It is pure TypeScript with zero I/O:
browser and Node hosts (frontend workbench, backend research workers) share the
exact same seeded search. The frontend re-exports it unchanged from
`frontend/src/strategy/generator/index.ts`.

## What the core owns

- Generates long and short `StrategyIR` candidates from bounded trend,
  mean-reversion, breakout and momentum primitives.
- Uses seeded structural crossover and mutation, canonical fingerprint
  deduplication, generation provenance, parent fingerprints and mutation logs.
- Validates every emitted candidate against a generator-specific whitelist and
  hard input/node budgets.
- Cooperatively observes `AbortSignal`, emits progress, and yields long browser
  work with `scheduler.yield()` when available plus a `setTimeout(0)` fallback.
- Ranks caller-supplied train/out-of-sample metrics across multiple markets with
  median/worst-market aggregation and explicit drawdown, trade-count,
  liquidation, overfit and cross-market dispersion penalties.

`generateStrategyCandidates()` is async only so it can yield to the host. Its
output remains reproducible for the same seed and specification.

## Production boundaries

- The module never fetches candles, opens sockets, calls an exchange, runs a
  backtest, places orders, or reads browser storage. Evaluation data is supplied
  by the caller.
- Ranking is comparative research, not a profitability claim. The caller must
  provide disjoint train/OOS windows and realistic fees, spread, slippage,
  funding, liquidity and latency assumptions. Walk-forward and paper validation
  remain required before any live review.
- Generated IR must still pass the canonical backend `StrategyIR` schema and all
  trading-engine risk/capability gates. Generator validation is intentionally
  narrower and does not authorize execution.
- Fingerprints are deterministic deduplication identifiers, not cryptographic
  signatures. Do not use them as an authenticity or trust boundary.
- The ranker fails validation on non-finite metrics, duplicate/insufficient
  markets, trade shortfalls or liquidations. Adapters should normalize their
  metric contracts before calling it; this core does not silently repair data.
- Structural evolution is diversity generation. Candidate scores must never be
  fed back as live orders without an explicit external evaluation and approval
  pipeline.

The public surface is exported from `index.ts`; UI, workers and persistence can
be added as adapters without introducing those concerns here.
