# R3.1 identity control-plane evidence

Accepted: 2026-07-16.

Scope: the public HTTP Research / Paper release only. This release does not add
TLS termination, secure-cookie activation, exchange credential entry, private
exchange streams or live order execution.

## Delivered behavior

- PostgreSQL migration v9 adds opaque public UUIDs for sessions and bounded
  indexes for user, session and audit administration.
- Every non-administrator `live-trade` role is migrated to `paper-trade`;
  affected sessions and WebSocket tickets are revoked, an audit record is
  written, and a database constraint prevents the role from being restored.
- Activate, reactivate, disable and permission changes are one PostgreSQL
  transaction with a mandatory reason, optimistic authorization revision,
  before/after audit state, session fencing and disable-time job cancellation.
- Self-disable, self-demotion, uppercase UUID variants and removal of the last
  active administrator fail closed.
- Users and administrators can list and revoke sessions through opaque public
  IDs. Revoking the current session clears cookies and reconciles the frontend.
- The administrator UI provides server-side filters and pagination, atomic
  review/confirmation, session administration and a paginated audit log in
  RU/EN/KK. A new live-trading role is not selectable.
- The guarded recovery CLI accepts an exact administrator login and reason,
  verifies the complete checked-in migration ledger, never runs migrations,
  generates the one-time password internally, revokes all sessions and requires
  a password change after login.
- Expired sessions and WebSocket tickets are cleaned in bounded, single-flight
  batches. Disabled owners cannot have queued compute work claimed.
- Legacy global research-alert and paper multi-leg surfaces fail closed for
  newly registered tenants until their durable owner-scoped migrations ship.

## Verification

- TypeScript, Biome, documentation semantic checks and source-file budgets:
  passed.
- Full unit/integration suite: 400 files passed, 4 skipped; 2,329 tests passed,
  43 skipped.
- Real PostgreSQL suites on isolated unprivileged databases:
  identity lifecycle 9/9, compute queue 19/19, execution ledger 10/10 and
  workspaces 5/5.
- Chromium R3.1 journeys: desktop, 390×844 and 320×700, 3/3 passed.
- Production build, PWA contract and bundle budgets passed with the required
  10% reserve.
- An independent security review found no blocker/high issue. Its two medium
  UUID/current-session findings were fixed and covered by regressions before
  deployment.

## Deployment and recovery evidence

- Before migration, an online runtime backup was created and verified: four
  manifest-controlled files with SQLite `quick_check` and encryption-key
  decryption proof.
- A PostgreSQL custom-format schema-8 dump was created, checksum-recorded and
  verified with `pg_restore --list` (100 entries).
- Only the project web service and bounded research worker were stopped. The
  project PostgreSQL container and port remained unchanged.
- Startup applied schema 8 → 9. `/api/health` and `/api/ready` returned `200`,
  PostgreSQL reported schema 9, no non-administrator live role remained, and
  the worker returned to an empty healthy queue.
- Rollback uses the verified dump restored into a new replacement database plus
  the matching runtime backup. There is no destructive down migration.

## Remaining R3 work

R3.2 still owns the complete workspace document, explicit save/conflict/error
workflow, quotas and import/export. R3.3 owns onboarding, empty states and the
HTTP-safe PWA boundary. HTTPS remains a separate future security release.
