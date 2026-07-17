# R5.3a screener alert promotion — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`86712bac3293ac8d746b638218eb66995d8e5edb`
(`feat: promote saved screens to server alerts`); exact-SHA GitHub Actions
run `29590401183` completed with 6/6 successful jobs. Production runs the
protected slot `r5c-schema14-86712ba` on unchanged PostgreSQL schema 14 and
trading SQLite schema 9 — this release adds NO migration. The runtime remains
`public-http-paper`; screener alerts are research-only and in-app-only until
the R5.3b notification worker.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 737 files), `architecture:check` (1 114 files),
  `docs:check`, production build, `perf:check` (total-JS cap moved
  960→984 KiB following the repo's reviewed-cap pattern, with the mandatory
  10% reserve intact), `pwa:check`.
- Vitest: 3 032 passed / 110 skipped, including the new
  `screenerAlertEvaluator` (transition semantics: init-without-trigger,
  entered/left, unavailable-as-unknown carry-over, 30% availability floor,
  cooldown fencing, fingerprint/transition-key determinism),
  `screenerAlertRoutes`, `screenerAlertRunner` (≤1 claim per sweep, 300 s
  lease, abortable 90 s budget) suites.
- Real-PostgreSQL: the new env-gated `screenerAlertPostgres` integration
  suite ran twice against an isolated unprivileged role/database in the
  project container (create→claim→complete round trip, receipts replay
  idempotency and forged-replay rejection, owner isolation, 5-per-owner and
  40-global caps, cooldown fence, rule-stays-active), alongside the six
  sibling alert/screener suites — all green; the suite is wired into the CI
  postgres-security job.
- Container browser gates: Chromium e2e 90/90 (new
  `r53a-screener-alert.spec.ts` asserts the exact promotion rule envelope),
  Firefox critical journeys 19/19, visual regression 6/6.

## Release chronology (no-migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r53a-schema14-v9-20260717T151000Z` | `dd5c0827-dd49-425c-b106-51bcd90403e0` | Backup + verify passed at schema 14 |
| Production cutover | slot `r5c-schema14-86712ba` | Drop-ins installed; API restarted through the slot launcher with a byte-identical migration ledger (schema unchanged); worker restarted second; `/api/ready` reported all six components `ready`; `NRestarts=0`; served asset SHA-256 identical to the slot frontend dist |
| Production lane proof | worker journal | `screenerAlertLane` metrics live (`evaluationsPerSweep:1`, `failuresSinceStart:0`, claim attempts observed) alongside the healthy price-alert lane |
| Post-cutover generation `post-r53a-schema14-v9-20260717T152500Z` | `3632bd9f-16c0-408d-9fdf-cfbc5fc69826` | Backup + verify passed at schema 14; isolated drill passed and self-cleaned |

Rollback remains replacement-only: the previous accepted slot
`r5b-schema14-20be5b1` and the verified pre-cutover generation are retained;
no schema or data transformation occurred.

## Accepted behavior

- Alert rule kind `screener` embeds the full `screener-definition-v1` by
  value (immutable per rule revision); cadence is timeframe-derived
  (300–86 400 s), lease 300 s, at most one evaluation per worker sweep with
  the 90 s bounded market-data budget.
- Match-set-changed semantics: first evaluation initializes without
  triggering; unavailable symbols are carried as unknown (never counted as
  departed); >30% unavailable universe defers the evaluation; cooldown
  (definition `cooldownSeconds`, browser default 3 600 s) defers without
  advancing state; the rule stays active after a trigger (`repeat:
  "on-change"`, rearm intentionally answers `409 alert_rearm_unsupported`).
- Completion writes the `triggered` event, the outbox row and the
  pre-delivered in-app delivery in one transaction keyed by the sha256
  transition key, under receipts producer `screener-alert-worker`.
- Quotas: 5 enabled screener rules per owner, 40 active globally, inside the
  shared alert caps; `telegram` delivery on screener rules is rejected with
  `400 unsupported_alert_delivery_channel` until R5.3b.
- The Screener workspace promotes the current screen via "Create alert from
  this screen"; screener rules are listed in the alerts panel without ever
  opening price-quote subscriptions.
