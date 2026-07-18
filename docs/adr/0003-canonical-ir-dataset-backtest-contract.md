# ADR 0003: canonical IR, dataset and backtest contract

Status: Accepted
Date: 2026-07-18
Decision owners: project owner and release maintainer

## Context

Server-side strategy evaluation (roadmap decision D2, releases R9.1+) moves generator and GA
candidates from the browser onto the research workers. Before any such job API ships, three
drift risks must be closed, because every server evaluation result becomes a durable,
comparable research artifact:

1. The Strategy IR is defined by a hand-maintained runtime/declaration pair in
   `packages/strategy-core` (`index.js` + `index.d.ts`, `IR_VERSION 4`). Unlike the generated
   package artifacts, no existing check would catch silent edits to that pair.
2. There is no versioned definition of "the data a backtest ran on". Server evaluations need a
   reproducible dataset identity and a leakage-safe train/test split before any out-of-sample
   claim is meaningful.
3. The backtest engine reports no engine identity, so two results cannot be proven to come
   from the same simulation semantics.

This ADR governs research evaluation contracts only. It does not authorize promotion or
gallery surfaces, schema changes, HTTPS activation, private exchange connectivity or live
trading; the runtime remains `RUNTIME_PROFILE=public-http-paper`.

## Decision

1. **Canonical Strategy IR.** The canonical Strategy IR definition is `IR_VERSION 4` in
   `packages/strategy-core`; the hand-maintained `index.js`/`index.d.ts` pair is that
   definition. A checksum guard (`scripts/check-strategy-core-ir.mjs`, wired into the
   strategy-core `check` chain next to the generated-artifact guards) pins the SHA-256 of both
   files so silent drift fails CI. Changing the IR requires a deliberate change that updates
   the pair, re-pins the digests in the same commit and records the schema evolution. The
   backend `parseStrategyIR` (`backend/src/trading/strategy/irSchema.ts`) stays the ONLY trust
   boundary for inbound IR; no server surface may execute IR that did not pass it.
2. **Versioned dataset contract `dataset-v1`.** `packages/backtest-core/dataset.ts` is
   runtime-neutral and pure. `DatasetDescriptorV1` records `schemaVersion: "dataset-v1"`,
   `source`, `timeframe`, sorted `symbols[]`, `fromMs`, `toMs`, per-symbol `barCounts`,
   `split { trainFraction (0.5..0.9), embargoBars (integer 0..500), testFraction = remainder }`
   and `fingerprint`. The fingerprint is SHA-256 over the canonical serialization
   `"dataset-v1\n<source>\n<timeframe>\n"` followed, per symbol in sorted order, by
   `"<symbol>\n"` and one `"t,o,h,l,c,v\n"` line per bar with canonical `String(Number(value))`
   formatting. `splitDatasetBars` produces time-ordered train/test windows with an embargo gap
   (bars dropped between train end and test start). Random splits are forbidden; the test
   window starts strictly after the train window, so lookahead is structurally impossible.
3. **Survivorship and delisting policy.** The server evaluation universe is the current public
   instrument catalog only. Delisted symbols are out of scope pre-HTTPS: results therefore
   carry survivorship bias and must not be presented as full-history performance claims. This
   limitation is recorded here and in the research documentation; datasets built under
   `dataset-v1` contain real provider bars only — synthetic fills are forbidden in server
   evaluation.
4. **Deterministic backtest engine.** `packages/backtest-core` exports
   `BACKTEST_ENGINE_VERSION = "backtest-core-v1"`, stamped into every server evaluation
   result. Engine paths use no wall clock and no unseeded randomness; identical
   (IR, dataset fingerprint, config, engine version) inputs must produce byte-identical
   metrics. The release gate for any server evaluation surface includes proving that the same
   seed and dataset give the same result.

## Consequences

- Server GA/generator evaluation surfaces may now ship (R9.1+) against these contracts;
  every stored evaluation result must carry the dataset fingerprint and engine version.
- Promotion and gallery surfaces remain forbidden until their own release gates (R9.2/R9.3)
  land; this ADR closes decision D2 only, and the roadmap decision table flips at acceptance
  time through the release workflow.
- Editing `packages/strategy-core/index.js` or `index.d.ts` without re-pinning the checksums
  fails `npm run check`; an intentional IR evolution is forced to be explicit and reviewed.
- A change to the canonical dataset serialization or engine semantics requires a new
  `schemaVersion`/`BACKTEST_ENGINE_VERSION` value, never a silent redefinition, so stored
  results stay comparable within a version and incomparable across versions by construction.
- Evaluation claims inherit the survivorship limitation until a delisting-aware catalog
  exists; documentation must continue to state it.
