# R9.1 server multi-market evaluation and ADR 0003 (D2) — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`4f5bc64e9dfb35d379a55690755a76f7594b226d`
(`feat: close D2 and add server multi-market strategy evaluation`);
exact-SHA GitHub Actions run `29643197555` completed with 6/6 successful
jobs. Production runs the protected slot `r9a-schema16-4f5bc64` on
unchanged PostgreSQL schema 16 and trading SQLite schema 10 — R9.1 adds
NO schema migration (the durable `compute_jobs` queue already accepts
kind-discriminated jobs). The runtime remains `public-http-paper` with
the same three project-owned units.

## Decision D2 closed by ADR 0003

`docs/adr/0003-canonical-ir-dataset-backtest-contract.md` (Accepted
2026-07-18) fixes, before the R9.1 job API as the roadmap required:

- the **canonical Strategy IR** — `IR_VERSION 4` in
  `packages/strategy-core`, whose hand-maintained runtime/declaration
  pair is now guarded by a pinned SHA-256 check
  (`scripts/check-strategy-core-ir.mjs`, wired into `npm run check`) so
  silent drift fails CI; `parseStrategyIR` remains the only trust
  boundary for inbound IR;
- the **versioned dataset contract** `dataset-v1`
  (`packages/backtest-core/dataset.ts`) — a canonical serialization with
  a SHA-256 fingerprint and a time-ordered train/test split with an
  embargo gap; splits are never random and the test window always starts
  strictly after the train window plus the embargo (no lookahead); the
  survivorship/delisting limitation (current public catalog only) is
  recorded;
- the **deterministic backtest engine version**
  (`BACKTEST_ENGINE_VERSION = "backtest-core-v1"`) stamped into every
  server evaluation result, with the determinism requirement that
  identical (IR, dataset fingerprint, config, engine version) produce
  identical output.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck (now including the IR checksum guard), Biome lint (1 876
  files), `architecture:check` (1 184 files), `docs:check`, production
  build, `perf:check`, `pwa:check`.
- Vitest: 3 263 passed / 130 skipped, including the registry suite (the
  two pre-existing job kinds re-registered with byte-identical request,
  response, dedupe-key and error behavior — proven against fixtures of
  today's exact request bodies — and unknown kinds still hard-fail), the
  dataset contract suite (pinned fingerprint goldens, one-tick
  divergence, embargo/no-lookahead split laws, a pure-JS SHA-256
  cross-checked against `node:crypto`), the multi-market evaluation
  suite (a fake candle source driven through the real registry and real
  worker-thread backtests) and the routes/client/panel suites.
- **Determinism — the release criterion (roadmap §13)**: the same
  candle set driven twice through the full evaluation path produced
  **byte-identical result JSON** (golden dataset fingerprint
  `d076618630cf5842…`, golden train/OOS metrics); real-closed-bars-only
  policy fails closed with explicit reasons
  (`multi_market_eval_market_bars_insufficient`, `_bars_not_real`,
  `_bars_invalid`, `_budget_exhausted`); cancellation between markets
  honored; results bounded to 256 KiB with an explicit oversize failure.
- One integration bug was found by the test pass and fixed
  pre-acceptance: a window with zero losing trades yields an infinite
  profit factor which JSONB stores as null; the client parser now maps
  it to NaN so the pure ranker's finite-metrics gate fails that window
  closed instead of rejecting the whole completed job.
- Container browser gates: Chromium e2e 96/96 (new journey: generator →
  server evaluation → ranking flips from unavailable to ranked with the
  dataset-fingerprint provenance line and the exact fail-closed POST
  body), Firefox smoke 19/19, visual regression 6/6.

## Accepted behavior

- **Generic research job registry** (`backend/src/jobs/registry.ts`):
  kind-discriminated definitions with in-process and worker-thread
  execution lanes; enqueue routes and the research worker dispatch
  through it; the durable queue's owner fairness, per-owner quota,
  lease/heartbeat/cancellation and retention are inherited unchanged.
- **Server-owned candle evaluation** (job kind `multi-market-eval`):
  strict bounded payload (1–6 catalog-validated markets sharing one
  timeframe, 500–20 000 lookback bars, train fraction 0.5–0.9 with an
  embargo, seed recorded for provenance); the server fetches real closed
  bars from the public provider under the screener budget discipline (90
  s, bounded concurrency, backwards paging) — synthetic bars are never
  accepted; per-market train and out-of-sample backtests run through the
  existing worker-thread protocol; an out-of-sample shared capital-pool
  portfolio section (drawdown, Sharpe, correlation matrix, per-symbol
  contributions, rejection counts) comes from the R4 portfolio backtest
  allocator; the `multi-market-eval-v1` result carries the engine
  version, the full dataset descriptor with its fingerprint and the
  seed.
- **Browser ranking**: the strategy generator panel gains an
  "Evaluate on server" flow (market multi-select, lookback and split
  controls, per-owner quota surfaced, explicit job states with
  cancellation); completed results feed the pure
  `rankMultiMarketEvaluations` ranker, whose section flips from
  "unavailable" to a ranked list with score-penalty breakdowns and a
  provenance line (engine version, seed, dataset fingerprint), in
  en/ru/kk. The generator package's purity is preserved; promotion and
  gallery surfaces remain forbidden until R9.2/R9.3.

## Release chronology (no-migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r9a-schema16-v10-20260718T121500Z` | `92026f70-a498-4e3a-822e-81ea615812d8` | Backup + verify passed at PG schema 16 / SQLite 10 |
| Production cutover | slot `r9a-schema16-4f5bc64` | Drop-ins installed for all three units; restart through the slot launchers with a byte-identical migration ledger; all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r9a-schema16-v10-20260718T122000Z` | `e894eede-21fb-48e5-8fe5-0f643808f73f` | Backup + verify passed; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r8a-schema16-69621f8` and the verified pre-cutover generation are
retained.
