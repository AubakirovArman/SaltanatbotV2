# R5.2.1 technical screener — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831`
(`test: cover schema 14 in migration chain assertions`, on top of the feature
commit `d42210022dd38e17aa002d140e489acd0fbc30a5`
`feat: add technical screener MVP`); exact-SHA GitHub Actions run
`29584556266` completed with 6/6 successful jobs. Production runs PostgreSQL
schema 14 and unchanged trading SQLite schema 9 from the protected slot
`r5b-schema14-20be5b1`. The runtime remains `public-http-paper`: the screener
is research-only over public Binance spot data, `researchOnly:true` /
`executionPermission:false` on every payload, and this pre-HTTPS build
provides no TLS.

Migration 14 (`owner_screener_presets`) checksum:
`0d7f90cadfa230c7b20fcbe03d7432d71add45760c1a3379ee2362e206c102f3`.

## Gate history

The first candidate revision `d422100` failed exact-SHA Actions run
`29583889332` in the PostgreSQL security integration job: three accepted
integration suites pinned the migration chain at `toVersion: 13`. Per the
fix-forward rule the assertions were corrected — the v12→v13 alert
control-plane upgrade now pins its target with an explicit migration slice,
and the legacy onboarding/workspace upgrade tests assert the chain through
version 14 — and the exact fixed SHA `20be5b1` went green on 6/6 jobs before
any production change. No cutover was attempted from the failed revision.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck across all workspaces; Biome lint (1 727 files); production build
  with verified exit status; `docs:check` (163 HTTP / 6 WS endpoints),
  `architecture:check` (1 111 files within budgets), `perf:check` with the
  mandatory 10% bundle reserve (the technical screener ships as its own lazy
  chunk), `pwa:check`.
- Vitest: 2 999 passed, 105 skipped, including the golden chart-parity
  fixture proving `@saltanatbotv2/strategy-core` sma/ema/rsi/atr/macd values
  are point-for-point identical to the chart's `indicatorMath` on a fixed
  300-candle series.
- All twelve unprivileged real-PostgreSQL suites were re-run locally against
  isolated project-owned databases inside the project container
  `11-postgres-1` (unprivileged role, dropped afterwards): 103 tests green,
  including the new `screenerRepositoryPostgres` suite (two-owner isolation,
  quota 40, client-id idempotency, revision conflicts, archive fencing).
- Container browser gates: Chromium e2e 89/89 (including the two new
  R5.2.1 journeys — desktop run + click-to-chart with symbol/timeframe/
  indicator context, and 390×844 mobile containment), Firefox critical
  journeys 19/19 (the desktop screener journey is tagged `@smoke`), visual
  regression 6/6. One accepted spec (`arbitrage-workspace`) was updated for
  the new persisted-sub-mode behavior: returning to the Screener now restores
  the last active scanner sub-mode, and the spec explicitly switches back to
  the basis workbench before asserting its persisted state.

## Recovery and cutover chronology

Only project resources were used: user units `saltanatbotv2.service` and
`saltanatbotv2-research-worker.service`, Compose container `11-postgres-1`
(`127.0.0.1:55434`, database `saltanatbotv2`), runtime data directory
`/home/arman/11/backend/data`, project recovery roots and listener port 4180.
The listener port did not change and no foreign resource was touched.

| Step | Generation / resource | Result |
| --- | --- | --- |
| Online pre-upgrade generation `pre-r521-rehearsal-schema13-v9-20260717T133000Z` | `281b88c8-e7c6-4947-82e6-d325140c4d48` | Backup + verify passed at schema 13; isolated drill passed and self-cleaned |
| Isolated 13→14 rehearsal | replacement DB `saltanatbotv2_restore_r521rehearsal20260717` + candidate build data dir | Candidate API on `127.0.0.1:4190` migrated to schema 14 with the exact checksum; restart produced a byte-identical migration ledger (no-op); worker heartbeat made all six `/api/ready` components `ready` |
| Rehearsal end-to-end screener smoke | same replacement pair | Owner-scoped preset created (`201`, revision 1) and listed; run enqueued through `POST /api/jobs` kind `screener` (`202`) and completed in the worker against live Binance public closed candles: 30/30 universe symbols evaluated, 30 matched, 0 unavailable, RSI metrics and 24h quote-volume/change populated, rows sorted by quote volume; admin access used the guarded `admin:recover` CLI against the replacement database only |
| Rehearsal cleanup | exact replacement DB and data dir | Dropped/removed |
| Stopped pre-cutover rollback source `pre-r521-cutover-stopped-schema13-v9-20260717T140000Z` | `bee7eced-4e0b-4e25-8722-b50b1693e826` | Captured with both services stopped; verify passed at schema 13 |
| Production cutover | slot `r5b-schema14-20be5b1` | Drop-ins installed for both units; API started first through the slot launcher and migrated production to schema 14 with the exact checksum; API restart confirmed a migration no-op; worker started second; `/api/ready` reported all six components `ready`; `NRestarts=0` for both units |
| Post-upgrade generation `post-r521-schema14-v9-20260717T141000Z` | `b18d3380-07b6-42ea-bb24-86bdfb30349c` | Backup + verify passed at schema 14; isolated drill passed and self-cleaned |
| Replacement-only rollback evidence | `saltanatbotv2_restore_r521rollback20260717` + `replacements/r521-r5a-rollback-20260717T141500Z` | Stopped schema-13 generation restored into new isolated resources, verified and retained unopened; no service, `PGDATABASE`, Compose or runtime path changed |

Rollback remains replacement-only: schema-14 data was never deleted, the
migration ledger was never downgraded, and the R5.1 slot was never run
against schema 14.

## Production runtime acceptance

After final cutover:

- `/api/health` returned `ok` and `/api/ready` returned `ready` for
  migrations, PostgreSQL, executor, research worker, filesystem and admission;
- `/api/screener/presets` is mounted behind the full session/CSRF/owner stack
  (unauthenticated requests receive `401`);
- the served `index.html` asset is byte-identical (SHA-256) to the slot
  frontend dist and the price-alert lane continues to run in the worker
  journal with zero scheduler failures;
- both units are active with `NRestarts=0` through the slot launchers;
- the end-to-end screener proof (preset → job → evaluated rows) was produced
  in the isolated rehearsal pair, since release rule 14 forbids test accounts
  in the production database.
