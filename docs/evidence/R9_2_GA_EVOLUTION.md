# R9.2 server GA evolution with lineage, Pareto and OOS promotion — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`3ed6af138f197ee985bd8ac998ab58cc8769b83c` (the feature landed in
`2b45f9ff57b7f4b31952193a2f216ac47a512390` `feat: add server GA evolution
with lineage, Pareto ranking and OOS promotion`, followed by two
test-only forward fixes for the shared CI database's new foreign keys);
exact-SHA GitHub Actions run `29647276230` completed with 6/6 successful
jobs. Production runs the protected slot `r9b-schema17-3ed6af1` on
PostgreSQL schema **17** (migration `ga_evolution_lineage`, SQL SHA-256
`4169ec0148c63415abe913195d34b03fa603039d0fe7defabfe76a89f7a61a73`,
additive only: owner-scoped `ga_runs` and `ga_candidates` with a
single-active-run partial unique index, bounded checkpoint storage and a
promotion-requires-OOS CHECK) and unchanged trading SQLite schema 10.
The runtime remains `public-http-paper` with the same three
project-owned units.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 906 files), `architecture:check` (1 195
  files), `docs:check` (now 170 HTTP endpoints incl. the four new
  `/api/ga` routes), production build, `perf:check` (the reviewed
  total-JS budget moved 1 008 → 1 032 KiB per the documented pattern),
  `pwa:check`.
- Vitest: 3 307 passed / 136 skipped, including the GA primitives suite
  (counting-PRNG fast-forward equivalence, seeded generation
  determinism, checkpoint codec tamper refusal, Pareto goldens on
  hand-built vectors, OOS-report goldens), the evolution task suite with
  real worker-thread backtests, the routes suite, the client/panel
  suites and the memory lineage-store double.
- **Seeded reproducibility — the release criterion (roadmap §13 /
  §18.1 R9.2)**: two identical runs (same seed, same dataset) produced a
  **byte-identical result and row-identical lineage**; a run cancelled
  after generation 1 resumed on a fresh instance to a **byte-identical
  final state** with equal candidate row sets and **zero re-evaluation
  across the checkpoint boundary**; a resume whose refetched market data
  no longer reproduces the pinned dataset fingerprint fails explicitly
  with `ga_dataset_drift`; fingerprint dedup guarantees a genome is
  never evaluated twice (evaluation-count accounting asserted).
- Promotion gates verified at both layers: the repository and the SQL
  CHECK refuse promotion without an out-of-sample report, and flagged
  overfit candidates are refused with `ga_promotion_overfit`; a clean
  candidate promotes into the owner's own strategy library carrying full
  provenance (seed, dataset fingerprint, engine and generator versions,
  lineage chain, OOS report). The public gallery remains forbidden until
  R9.3.
- The new PG-gated integration suite (`gaEvolutionPostgres`) runs in CI
  against the isolated database (25/25 together with the compute-jobs
  suite after the two forward fixes: the queue truncation now cascades
  through the schema-17 foreign keys, and the orphaned-run scenario
  stamps `completed_at` on the forced-terminal driving job).
- Container browser gates: Chromium e2e 97/97 (new journey: start a
  server evolution run → Pareto frontier with a blocked overfit
  candidate → promote the clean candidate into the library; one R9.1
  spec selector was disambiguated after the new section landed), Firefox
  smoke 19/19, visual regression 6/6.

## Accepted behavior

- The pure structural generator lives in the
  `@saltanatbotv2/strategy-generator` workspace package (zero IO,
  guarded generated artifacts; the frontend keeps a re-export shim) so
  the server can breed candidates.
- **Job kind `ga-evolution`** (in-process, riding the R9.1 registry and
  the durable owner-fair queue): bounded config (1–4 markets on one
  timeframe, 500–20 000 lookback bars, population 8–64, generations
  1–16, seed 0..2³²−1); the dataset is fetched once per run under the
  real-bars discipline and pinned by its dataset-v1 fingerprint; every
  generation persists lineage rows (parents, mutation log, IR, metrics,
  objectives), non-dominated Pareto ranks over out-of-sample objectives
  and an atomic checkpoint (population + RNG state); cancellation yields
  a durable resumable `checkpointed` run.
- Owner-scoped `/api/ga` routes expose runs, the frontier, candidate
  lineage chains and promotion; the strategy studio's server evolution
  section (start/cancel/resume, frontier with explicit overfit and
  unstable flags, lineage drawer, promote-to-library) ships in en/ru/kk.

## Release chronology (PostgreSQL 16 → 17 migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-migration generation `pre-r9b-schema16-v10-20260718T140000Z` | `c9fbff05-c37b-43ae-8150-64b78d2ab6cb` | Backup + verify passed at PG schema 16 |
| Paired migration rehearsal | restore `saltanatbotv2_restore_r9b_rehearsal` | The production-data copy migrated `fromVersion 16 → toVersion 17`, applying exactly `ga_evolution_lineage`; `ga_runs`/`ga_candidates` present; rehearsal database dropped and replacement directory removed afterwards |
| Pre-cutover generation `pre-r9b-cutover-schema16-v10-20260718T142500Z` | `35d3b199-ab7a-491a-bfb8-28aea0bc63da` | Fresh backup + verify at the green SHA, still schema 16 |
| Production cutover | slot `r9b-schema17-3ed6af1` | Drop-ins installed for all three units; restart through the slot launchers applied migration 17 on startup (identity log: schema 17); all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r9b-schema17-v10-20260718T143000Z` | `fb95a706-4069-4d3f-a913-3bbe93ba4c0d` | Backup + verify passed at PG schema 17; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r9a-schema16-4f5bc64` and the verified schema-16 pre-cutover
generations are retained.
