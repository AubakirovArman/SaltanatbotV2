# R6 shared paper execution contract and DCA robot — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`e2411ab2f0b4540200089af8128304f71d3f73e0`
(`feat: add DCA paper robot on a shared execution contract`); exact-SHA
GitHub Actions run `29633743310` completed with 6/6 successful jobs.
Production runs the protected slot `r6a-schema16-e2411ab` on unchanged
PostgreSQL schema 16 and trading SQLite schema 9 — R6 adds NO schema
migration. The runtime remains `public-http-paper` with the same three
project-owned units.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 813 files), `architecture:check` (1 154 files, all
  ≤600 lines), `docs:check`, production build with verified exit status,
  `perf:check` (bundle budgets hold), `pwa:check`.
- Vitest: 3 237 passed / 130 skipped, including the new DCA contract
  (`dca-params-v1` parser + worst-case golden values), the 14-test machine
  suite (long/short cycles, exact volume-weighted entry math, take-profit
  re-placement after each safety order, stop/trailing/duration exits,
  cooldown gating, deterministic transition keys, snapshot round trip), the
  averaging-fill suite (merge math, event consistency, historical
  single-position ledgers byte-unchanged, explicit cancellation instead of
  the previous silent same-side drop) and the fenced runtime round trip
  (worst-case rejection, IR-less create, action dispatch).
- **Golden replay — the release criterion (roadmap §10)**: a 120-bar fixture
  (dip triggering exactly two safety orders, then a rally through the merged
  average-entry take-profit) driven twice through the REAL adapter/ledger
  path produced byte-identical event streams; `replayPaperLedger(events)`
  equals the final adapter state; a mid-cycle restart (resume from ledger
  events + machine snapshot + order journal at bar 25) reached the identical
  terminal state and events as the uninterrupted run; the balance never went
  negative and committed capital never exceeded the worst-case bound, which
  itself never exceeded the allocation.
- Container browser gates: Chromium e2e 93/93 (new DCA creation journey with
  the exact fail-closed POST body incl. `kind`/`dca` and the worst-case UI
  gate that blocks submission with zero requests when the allocation is
  insufficient), Firefox critical journeys 19/19, visual regression 6/6.
- One integration bug was found by the test pass and fixed pre-acceptance:
  the read-model DCA metadata used different field names than the browser
  contract, which would have rendered the detail drawer as "Unavailable".

## Accepted behavior

- **Shared contract pieces**: `paper-fill-model-v1` (fee 0.05% / slippage
  0.02%) is the single parity source consumed by the live paper adapter and
  the backtest defaults; the paper fill behavior is versioned —
  `single-position-v1` (default, byte-compatible with every historical
  ledger; conflicting triggered orders now cancel explicitly with reason
  `position-conflict:single-position-v1`) and `averaging-v1` (same-side adds
  merge with volume-weighted entry) used by DCA robots; the deterministic
  golden-replay harness (`goldenReplay.drive`) exercises the real
  adapter/order-lifecycle/ledger path and is reusable for R7 Grid.
- **DCA robot** (`dca-params-v1`, versioned machine `dca-state-v1`): base
  order, up to 25 safety orders with price-deviation/step-scale/volume-scale
  ladder, take-profit re-placed from the volume-weighted average entry after
  every fill, optional stop-loss, optional trailing take-profit, cooldown
  between cycles, optional maximum cycle duration with terminal stop; long
  and short; every transition carries the idempotency key
  `dca:<botId>:<cycle>:<ordinal>` (also the order clientId) and persists a
  durable state snapshot, so restart recovery resumes mid-cycle exactly.
- **Worst-case capital** `(base + Σ safety·volumeScale^(i-1)) · (1 +
  feePct/100)` is enforced server-side at creation
  (`WORST_CASE_EXCEEDS_ALLOCATION`) and previewed live in the create form
  from the same shared contract math; the reservation itself remains the R4
  allocation mechanism, unchanged.
- Robot kind is an additive config discriminator: strategy robots are
  untouched and old create payloads hash identically. The Robots workspace
  gains the DCA panel, list/detail badges and an evidence-aware cycle-state
  section in en/ru/kk.

## Release chronology (no-migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r6-schema16-v9-20260718T060000Z` | `440523a6-324b-41d9-bbf6-2692d6f9ceb1` | Backup + verify passed at schema 16 |
| Production cutover | slot `r6a-schema16-e2411ab` | Drop-ins installed for all three units; restart through the slot launchers with a byte-identical migration ledger; all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r6-schema16-v9-20260718T062000Z` | `65bb4359-709a-42e5-9e75-3346d0b02e5b` | Backup + verify passed at schema 16; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r5f-schema16-2ff6101` and the verified pre-cutover generation are retained.
