# R8 owner-scoped multi-leg paper intents — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`69621f8107a713031f768320e9dc496010234100`
(`feat: add owner-scoped multi-leg paper intents on the common capital
plane`); exact-SHA GitHub Actions run `29639908389` completed with 6/6
successful jobs. Production runs the protected slot `r8a-schema16-69621f8`
on unchanged PostgreSQL schema 16 and the NEW trading SQLite schema 10 —
the first SQLite migration since R4. Migration
`owner_scoped_paper_multi_leg` (SQL SHA-256
`34584a750937468d065d90b0af09a074a541da29ba1e7a38f2c5278cc6e9890d`) is
additive only: two owner-scoped tables
(`paper_multi_leg_intents`, append-only `paper_multi_leg_intent_events`)
inside the versioned store; every v1..v9 object is untouched. The runtime
remains `public-http-paper` with the same three project-owned units.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 860 files), `architecture:check` (1 178 files,
  all within budget), `docs:check`, production build with verified exit
  status, `perf:check` (the reviewed total-JS budget moved 984 → 1 008 KiB
  following the documented R5.3a pattern), `pwa:check`.
- Vitest: 3 214 passed / 130 skipped, including the migration-chain and
  v9→v10 upgrade suites (existing paper data intact, new journal
  append-only), the intent-store suite (deterministic identities,
  contiguous sequences, unique idempotency keys, exactly-once reservation
  release — a second terminal flip throws), the intent-service suite with
  hand-computed goldens (route-family happy path net `949.770000` USDT /
  fees `0.23`; compensation unwind net `−50.030000` with an explicit
  residual-exposure line; 4-leg n-leg cycle net `207.796000`, reserve
  `1 020.408`), freshness/kill-switch/limit/insufficient-capital
  rejections at the exact boundary micro, the fenced runtime round trips
  (submit applied-once/replayed-exactly plus every rejection code) and
  the read-service suite (available capital subtracts running
  reservations and floors at zero).
- **Restart replay — the release criterion (roadmap §12/R8.2)**: a
  partially driven run (step budget 2) recovered on a fresh service
  instance reached a journal byte-equal to the uninterrupted pure-engine
  run — identical terminal state, sequences `1..6` with no duplicates,
  and the capital reservation released exactly once (re-recovery is a
  no-op); a redelivered submit command resumes its own crashed intent and
  replays the exact durable receipt. **Combined paper PnL includes both
  legs and every modeled fee**, and residual exposure is always listed
  explicitly instead of being silently priced.
- Container browser gates: Chromium e2e 95/95 (new journey: researched
  opportunity → run dialog with the worst-case preview → exact
  fail-closed POST body `paper-multi-leg.submit` with no credential
  fields → portfolio-center intent card with the combined PnL), Firefox
  smoke journeys 19/19, visual regression 6/6.
- The legacy isolated arbitrage paper multi-leg module is byte-identical;
  its journal, routes and admin panel are unchanged, and the pure
  engine/schema/builders are reused — not forked — by the new
  owner-scoped path.

## Accepted behavior

- **Durable owner-scoped intent groups**: the fenced executor gains
  additive command kinds `paper-multi-leg.submit` and
  `paper-multi-leg.kill-switch` (legacy request hashes byte-identical).
  Submit builds the plan through the existing fail-closed research
  builders (research-simulation only, `executable === false` enforced,
  per-leg evidence mandatory), enforces the shared freshness gate (≤60 s
  source age, ≤5 min plan lifetime), per-owner (3) and per-portfolio (2)
  active-intent limits, and reserves the deterministic worst case
  `Σ plannedQuantity·referencePrice·(1 + 2·feeBps/10000)` (ceil to six
  decimals) against the portfolio's available capital
  (`MULTI_LEG_INSUFFICIENT_CAPITAL` exactly one micro past the boundary).
- The pure deterministic engine then runs to terminal inside the fenced
  apply with every transition durably journaled under
  `mleg:<intentId>:<sequence>`; leg risk, partial fills and reverse-order
  compensation (unwind) follow the proven engine semantics; terminal
  outcomes are completed / compensated / aborted-no-exposure /
  manual-review-required. The reservation is released exactly once by the
  guarded running→terminal flip.
- The portfolio read model exposes a browser-shaped `multiLeg` section
  (intents, per-leg fills/fees/compensation, combined net PnL, residual
  exposure, kill-switch state) and subtracts running reservations from
  available capital; the Robots workspace portfolio center renders the
  intents section, and opportunity research gains the "Run paper
  multi-leg" flow with a live worst-case preview, in en/ru/kk. The
  owner-level paper kill switch fails closed on an unreadable value.

## Release chronology (trading SQLite v9 → v10 migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r8-schema16-v9-20260718T104500Z` | `ddf80eba-768a-45fb-81f0-111cf9a71a63` | Backup + verify passed at PG schema 16 / SQLite 9 |
| Paired migration rehearsal | copy of the generation's `trading.db` | `scripts/rehearse-trading-migration.mjs` migrated the production-data copy `fromVersion 9 → toVersion 10`, applying exactly `owner_scoped_paper_multi_leg`; rehearsal copies removed and the generation re-verified |
| Production cutover | slot `r8a-schema16-69621f8` | Drop-ins installed for all three units; restart through the slot launchers applied the v10 migration on startup (`PRAGMA user_version` = 10); all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r8-schema16-v10-20260718T100500Z` | `7ac9a851-36de-4c78-b8a6-8818e14fb5af` | Backup + verify passed at PG schema 16 / SQLite 10; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r7a-schema16-baf4217` and the verified pre-cutover generation (still at
SQLite 9) are retained.
