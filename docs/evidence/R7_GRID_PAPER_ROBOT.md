# R7 grid paper robot — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`baf42178d33043fde0965d008aee9f09462df699`
(`feat: add grid paper robot on the shared execution contract`); exact-SHA
GitHub Actions run `29636312303` completed with 6/6 successful jobs.
Production runs the protected slot `r7a-schema16-baf4217` on unchanged
PostgreSQL schema 16 and trading SQLite schema 9 — R7 adds NO schema
migration. The runtime remains `public-http-paper` with the same three
project-owned units.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 835 files), `architecture:check` (1 166 files, all
  within budget), `docs:check`, production build with verified exit status,
  `perf:check` (bundle budgets hold), `pwa:check`.
- Vitest: 3 146 passed / 130 skipped, including the new grid contract suite
  (`grid-params-v1` parser bounds per mode, arithmetic and geometric
  level-price goldens, worst-case goldens), the 17-test machine suite
  (anchor placement rule with exact-at-anchor never arming, paired
  take-profit accounting exactness net of both-leg fees, cooldown re-arm,
  gap batches settled in one consolidated placement round with zero
  duplicate keys, outside-range pause/resume and stop variants, stop-loss
  flatten, cycle cap, long/short mirroring, byte-identical snapshot round
  trip with fail-closed tamper cases, deterministic ordinals) and the
  fenced runtime round trip (grid create, worst-case rejection, action
  dispatch through the shared runtime).
- **Golden replay — the release criterion (roadmap §10)**: a 17-bar fixture
  (ranging market completing exactly three buy→sell pairs, one bar gapping
  across four grid levels, then a final escape below the range) driven
  twice through the REAL adapter/ledger path produced byte-identical event
  streams; the four-level gap settled in a single consolidated placement
  round with a contiguous, duplicate-free order clientId set — **a price
  gap never creates a cascade**; a mid-cycle restart (resume from ledger
  events + machine snapshot + order journal after bar 6) reached the
  identical terminal state, events and — decisively — the **identical
  order clientId set** as the uninterrupted run, so **restart never
  duplicates levels or reserves**; `replayPaperLedger(events)` equals the
  final adapter state and committed capital never exceeded the worst-case
  bound, which is enforced server-side and **previewed in the create form
  before confirmation** together with the level-price ladder.
- Container browser gates: Chromium e2e 94/94 (new grid creation journey
  with the level preview, the worst-case UI gate blocking submission with
  zero requests, and the exact fail-closed POST body incl. `kind`/`grid`),
  Firefox smoke journeys 19/19, visual regression 6/6.
- One integration bug was found by the test pass and fixed pre-acceptance:
  the browser read-model parser rejected negative inventory quantities, so
  a short grid's signed inventory would have rendered as "Unavailable".

## Accepted behavior

- **Grid robot** (`grid-params-v1`, versioned machine `grid-state-v1`):
  arithmetic or geometric level ladder inside strict bounds (2–50 levels),
  neutral/long/short modes, per-level quote size, cooldown between
  refills, optional stop-loss beyond the mode-appropriate bound
  (market-flatten + terminal stop), optional cycle cap, and an
  outside-range action — pause (orders kept, resumes on re-entry) or stop
  (cancel all, terminal, inventory kept). Level prices come from one
  shared deterministic helper used by the machine, the server and the UI
  preview alike.
- Every transition carries the idempotency key
  `grid:<botId>:<epochCycle>:<ordinal>` (also the order clientId) and
  persists a durable snapshot (`gridState:<botId>`), so restart recovery
  resumes mid-ladder exactly; journal-deduplicated recovery never
  re-places an existing clientId.
- **Worst-case capital** `gridLevels · orderQuote · (1 + feePct/100)` is
  enforced server-side at creation (`WORST_CASE_EXCEEDS_ALLOCATION`) and
  previewed live in the create form from the same shared contract math;
  the reservation remains the R4 allocation mechanism, unchanged.
- Realized grid PnL (closed pairs, net of the shared `paper-fill-model-v1`
  fees) and inventory PnL (evidence-aware unrealized marks) are surfaced
  separately in the detail drawer and never conflated. The grid fill
  behavior is the R6 `averaging-v1`; strategy and DCA robots are untouched
  and old create payloads hash identically. The Robots workspace gains the
  Grid panel, the pre-start level-price preview list, list/detail badges
  and the runtime section in en/ru/kk.

## Release chronology (no-migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r7-schema16-v9-20260718T080000Z` | `0ee96dbe-df9a-42e6-bf70-6bd393f8ff7f` | Backup + verify passed at schema 16 |
| Production cutover | slot `r7a-schema16-baf4217` | Drop-ins installed for all three units; restart through the slot launchers with a byte-identical migration ledger; all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r7-schema16-v9-20260718T080500Z` | `cb3702ac-59f4-471d-97d7-a3edbdabb043` | Backup + verify passed at schema 16; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r6a-schema16-e2411ab` and the verified pre-cutover generation are retained.
