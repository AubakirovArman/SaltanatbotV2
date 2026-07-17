# R5.1 owner-scoped price alerts — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`66394fd38765d8da36174411cecd95a33fda1ea0`
(`feat: add durable owner-scoped price alerts`); exact-SHA GitHub Actions run
`29574600648` completed with 6/6 successful jobs. Production runs PostgreSQL
schema 13 and unchanged trading SQLite schema 9 from the protected slot
`r5a-schema13-66394fd`. The runtime remains `public-http-paper`: R5.1 is
notification-only, uses fixed conservative beta limits, is not R11 capacity
evidence for 100 simultaneous users, and this pre-HTTPS build provides no TLS —
public-Internet passwords and session cookies remain unsafe until a separate
HTTPS roadmap.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck across all workspaces; Biome lint (1 692 files); production build;
  `docs:check`, `architecture:check` (1 089 files within budgets), `perf:check`
  with the mandatory 10% bundle reserve, `pwa:check`.
- Vitest: 2 938 passed, 98 skipped. Five `runtimeDataBackup` cases fail only
  under a group-writable `umask 0002` operator shell because the suite then
  creates group-writable restore targets that the tool correctly rejects; under
  the standard `umask 022` the same file passes 31/31. CI runs with `umask 022`.
- Unprivileged real-PostgreSQL suites were re-run locally against isolated
  project-owned databases inside the project container `11-postgres-1`
  (`127.0.0.1:55434`): role `saltanatbotv2_test_local`
  (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`), databases
  `saltanatbotv2_local_alerts_test` and `saltanatbotv2_local_identity_test`.
  Eleven suites, 96 tests, all green: computeJobs 19, identityLifecycle 9,
  executionStepLedger 10, executorCommands 10, alertControlPlane 5,
  alertRepository 10, alertEventPages 3, alertRetention 3,
  alertManagementCapacity 3, workspaces 18, onboarding 6. The isolated
  migration recorded schema 13 checksum
  `1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`, exactly
  matching the candidate checksum pinned in [RELEASING.md](../RELEASING.md).
  The test role and both databases were dropped afterwards.

## Recovery and cutover chronology

Only project resources were used: user units `saltanatbotv2.service` and
`saltanatbotv2-research-worker.service`, Compose container `11-postgres-1`
(`127.0.0.1:55434`, database `saltanatbotv2`), runtime data directory
`/home/arman/11/backend/data`, project recovery roots and listener port 4180.
No foreign database, container, unit or port was touched; the listener port
did not change.

| Step | Generation / resource | Result |
| --- | --- | --- |
| Online pre-upgrade generation `pre-r51-rehearsal-schema12-v9-20260717T110500Z` | `bea13090-72b6-4e62-807c-cdf611bdbef9` | Backup + verify passed at schema 12 |
| Isolated drill from that generation | `saltanatbotv2_drill_20260717110447_6cfe11ca` | Passed; temporary database dropped and data directory removed by the tool |
| Isolated 12→13 rehearsal | replacement DB `saltanatbotv2_restore_r51rehearsal20260717` + candidate build data dir | Candidate API on `127.0.0.1:4190` migrated to schema 13 with the exact checksum; restart produced a byte-identical migration ledger (no-op); worker heartbeat made all six `/api/ready` components `ready` |
| Rehearsal owner-scoped delivery smoke | same replacement pair | Two `armed → triggered` transitions (`ineligible → eligible`, owner sequences 1 and 2), two `notification_outbox` rows with distinct SHA-256 deduplication keys, two `notification_deliveries` rows `channel=in-app`, `status=delivered`, all owner-scoped; lane metrics `evaluator=public-rest-price-threshold`, `delivery=in-app-only`, `schedulerFailuresSinceStart=0` |
| Rehearsal cleanup | exact replacement DB and data dir | Dropped/removed; admin access used the guarded `admin:recover` CLI (`--confirm-login`, audited reason) against the replacement database only — no production account was used or modified |
| Stopped pre-cutover rollback source `pre-r51-cutover-stopped-schema12-v9-20260717T113500Z` | `4d9d7753-580a-4d37-be73-9be1c943f598` | Captured with both services stopped; verify passed at schema 12 |
| Production cutover | slot `r5a-schema13-66394fd` | Drop-ins installed for both units; API started first through the slot launcher and migrated production to schema 13 with the exact checksum; API restart confirmed a migration no-op; worker started second; `/api/ready` reported all six components `ready`; `NRestarts=0` for both units |
| Post-upgrade generation `post-r51-schema13-v9-20260717T114500Z` | `b58d601d-8649-459c-a957-d50672328f1c` | Backup + verify passed at schema 13; isolated drill `saltanatbotv2_drill_20260717113537_f86597d5` passed and self-cleaned |
| Replacement-only rollback evidence | `saltanatbotv2_restore_r51rollback20260717` + `replacements/r51-r4c-rollback-20260717T114700Z` | Stopped schema-12 generation restored into new isolated resources, verified and retained unopened; no service, `PGDATABASE`, Compose or runtime path changed |

Rollback is proven replacement-only: schema-13 data was never deleted, the
migration ledger was never downgraded, and R4 was never run against schema 13.

## Protected slot

`/home/arman/.local/share/saltanatbotv2/releases/r5a-schema13-66394fd` was
built as `git archive` of the exact SHA → `npm ci --ignore-scripts` →
`npm run build` → `pwa:check`/`perf:check` → `npm prune --omit=dev
--ignore-scripts`. Manifests cover 10 157 release files, 501 backend dist
files and 12 internal symlinks; `STARTUP-SAFETY.sha256`,
`RELEASE-SHA256SUMS`, `RELEASE-SYMLINKS.sha256` and the symlink inventory all
verify, and the two launchers refuse to start on any mismatch. The served
`index.html` asset is byte-identical (SHA-256) to the slot frontend dist.

## Production runtime acceptance

After final cutover:

- `/api/health` returned `ok` and `/api/ready` returned `ready` for
  migrations, PostgreSQL, executor, research worker, filesystem and admission;
- both units are active with `NRestarts=0` through the slot launchers;
- the production research worker journal shows the price-alert lane with
  `evaluator=public-rest-price-threshold`, `delivery=in-app-only` and zero
  scheduler failures;
- the owner-scoped in-app delivery proof was produced in the isolated
  rehearsal pair (release rule 14 forbids test accounts in the production
  database); production evidence is the healthy lane, heartbeat and readiness.
