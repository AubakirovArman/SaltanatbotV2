# R4 canonical paper portfolios — release evidence

Status: **candidate; not accepted, not pushed, not deployed**

Evidence date: 2026-07-17

This record covers R4 only: canonical owner-scoped paper portfolios, the
“Running” robot workflow, durable accounting/journal evidence and the fenced
PostgreSQL-to-SQLite executor boundary. It does not enable HTTPS, exchange
credentials, private streams, signed requests, live orders, borrowing or
collateral mutations.

## Release identity and acceptance state

| Gate | Current state |
| --- | --- |
| Candidate source | Dirty exact worktree based on `e31a7324221567accabb6eb66a01bd8f62a874d1`; final commit is not created yet |
| Protected production | Still `r33-schema11-377c42b` / `377c42bd8e54a1de2f635a9f6aa3bd1a92ce29c0` |
| Exact-SHA GitHub Actions | Pending until the candidate is committed and pushed |
| Isolated paired restore/migration/rollback drill | Pending until exact SHA and Actions are green |
| Production cutover and 4180 smoke | Pending; forbidden before the previous gates pass |
| Runtime profile | Must remain `public-http-paper` before, during and after R4 |

This file must be updated with the exact commit, Actions run IDs, backup
generation hashes, migration receipts, release-slot identity and production
smoke before R4 changes from candidate to accepted.

## Fixed authority and schema contract

- PostgreSQL schema 12 adds the bounded `executor_commands` queue. Migration
  name: `durable_executor_command_queue`; SHA-256:
  `72beb8455a9e96de97d28129b34a1a6a2c8a103090e1aa5455a9c9a0aa56d8d6`.
- Trading SQLite schema 9 adds canonical paper portfolios, epochs,
  allocations, marks, mutation receipts, immutable robot-revision evidence,
  tombstones, events and rebuildable projections. The checked candidate
  `PAPER_PORTFOLIO_SCHEMA_V9_SQL` SHA-256 is
  `e894c233d6a0597c7ac849aa59a2ebe969b837d01c6cb17ca4a037a0af4fa50f`.
- PostgreSQL owns authorization and durable commands. One fenced executor owns
  `trading.db`. A SQLite receipt committed with a mutation makes a lost
  PostgreSQL acknowledgement replay-safe.
- Fresh or unapplied commands require current active-session, paper-role,
  authorization-revision and authorization-epoch evidence. A reclaimed command
  may acknowledge only an exact already-applied receipt bound to owner, command
  ID, idempotency key and request hash; that path performs no second mutation.
- Portfolio and robot revisions, ledger epoch and exact fixed-micros capital
  are optimistic fences. Reset starts a new epoch and preserves prior evidence.
- Missing/stale equity, margin and borrowing evidence is shown as unavailable
  or stale, never synthesized as zero.

The public contract and operator boundary are documented in
[Canonical paper portfolios](../PAPER_PORTFOLIOS.md).

## Local verification ledger

The following checks ran against isolated copies or isolated test databases.
They did not change production schema 11, production SQLite, port 4180 or
project systemd units.

| Check | Result |
| --- | --- |
| Full TypeScript/Vitest worktree gate | 448 files passed, 7 skipped; 2,747 tests passed, 74 skipped |
| Focused R4 backend security/shutdown/replay suites | Green, including authorization recovery, terminal replay, abort-aware and ignored-abort shutdown |
| Isolated PostgreSQL security suites | 5 files / 66 tests passed: jobs 19, identity 9, execution ledger 10, executor commands 10, workspaces 18 |
| PostgreSQL cleanup/boundary | Temporary R4 roles/databases removed (`0:0`); production stayed schema 11 |
| Architecture budgets | 1,065 source files passed; `server.ts` 599/600, `store.ts` 600/600 |
| Biome | 1,639 files passed |
| Documentation/semantic generation | 220 Markdown files; 150 HTTP and 6 WebSocket endpoints; references current |
| R4 focused frontend component tests | Green |
| R4 targeted Chromium desktop/mobile | 3/3 journeys passed before the final accessibility addition; exact desktop lifecycle with Axe passed again |
| Axe scope | `.paper-portfolio-center`, initial desktop and opened named robot dialog; WCAG 2.0/2.1 A/AA tags, no exclusions, zero violations |
| Firefox critical journeys | 18/18 passed in an isolated production build |
| Container visual regression | 6/6 reviewed baselines passed in pinned Playwright container |
| R3.3 paper-onboarding regression | Focused 1/1 passed after adding parser-valid canonical portfolio list/detail and strict owner/CSRF/idempotency/revision/epoch checks |
| Full ordinary Chromium | 87/87 passed with one worker, zero retries; formerly failing onboarding was 83/87 and all three R4 journeys were 85–87 |
| PWA | 27 same-origin files and required install icons verified |
| Bundle | Initial JS 59.4 KiB; distributable JS 831.0 KiB; distributable CSS 46.3 KiB; reviewed caps retain 10% reserve |
| Stream/render soak | Desktop + mobile 2/2 passed in 11.8 minutes with strict thresholds and required instrumentation |
| Changed-file secret heuristic | Passed; runtime `backend/data` remains ignored and untracked |

The exact staged tree still receives the final static/documentation/secret
recheck before commit.

## Accounting, restart and tenant evidence

Direct tests cover:

- exact six-decimal capital conservation, fees, funding, realized/unrealized
  evidence, exposure, statistics and maximum drawdown;
- bounded journal windows (curve 256 points, fills 50, events 100);
- durable valuation marks, stale/unavailable states and snapshot-only legacy
  migration evidence;
- duplicate closed-bar and duplicate command/idempotency fences;
- lost PostgreSQL acknowledgement, exact SQLite receipt recovery and
  authorization revocation;
- crash-left intent recovery, terminal order non-resubmission and changed
  intent rejection;
- no-market-price rejection remaining terminal after restart;
- legacy flat paper-bot deletion releasing only its exact allocation;
- startup ordering: engine resume, executor start, then listener;
- shutdown quiesce/drain/abort and refusal to close the engine/store while an
  apply callback remains active;
- two-owner read/mutation isolation, administrator non-bypass, CSRF,
  expected-owner and idempotency headers.

## Browser and visual evidence

The R4 browser contract covers desktop 1440×900, mobile 390×844 and narrow
mobile 320×700:

- loading, error, empty, populated and stale-snapshot states;
- create, rename, default, archive and ledger-reset workflows;
- filters, desktop table, mobile cards and collapsible sticky summary;
- bottom-sheet/detail drawer, realized-cash curve, metrics, fills and events;
- pause/stop confirmations with revision and epoch evidence;
- focus containment, Escape/opener restoration, 44 px coarse-pointer targets,
  full scroll range and no horizontal document overflow.

Reviewed artifact SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| `01-desktop-portfolio-list.png` | `de76525f26334ea5508646c847d650b930a529aa39a3c76a7da6c737e436dda6` |
| `02-desktop-robot-detail-journal.png` | `213365863290500aa91784c3fbe188b1277953f814724b00c6aec82ab2b7748a` |
| `02a-desktop-equity-curve.png` | `dd5b41d6e3d65243002066b3abaae57d584563674fd87232037cc3323880e012` |
| `03-desktop-robot-action-confirmation.png` | `b5b2a0fac833c54d6579f2b35f69c708a25a8ea1021d5dab13187a12e0966cb0` |
| `04-desktop-create-portfolio.png` | `772a23736b12254cf9fbc13d9dba320bb69a04b2df9208de1128ead428251a80` |
| `05-desktop-stale-fallback.png` | `93b760d8935f1dbfe2fa15299201befbb71ba2bb91cb8d99ac83a387dc6eebd4` |
| `06-mobile-390-bottom-sheet-journal.png` | `8b9dd99dd59cf3aa1a9d60ebfd266ba52ad725350620c09730c0a04cc87b6c43` |
| `06a-mobile-equity-curve.png` | `a39f3a7162c39d6577e697d97dbe8f303400c8b7459f6d1b81c4b947fc72dc54` |
| `07-narrow-320-portfolio-menu.png` | `99bbdd0862704efc96c1369ad21acd7f95eaf560ad13338d7366da819103b098` |
| `08-narrow-320-drawer-actions.png` | `bbf61ee7bd56dcf3498c2af7971d336403922a9a89e9bf4b03d6a8d4c91e85b7` |
| `09-desktop-exact-trace.zip` | `3428a21ead2d41c780237a32e9cae2a0c5c5b6b50e769e90b8fe0b4079761d41` |

Automated reflow, keyboard, touch geometry and Axe evidence does not replace
the still-open manual Android Opera and VoiceOver/NVDA/TalkBack matrix.

## Stream/render soak

The pinned Chromium 149 container ran 12,000 retained candles, a 100 ms
synthetic tick, 30-second warm-up and two five-minute desktop/mobile profiles.
Every strict check passed: subscription ownership/release/recovery, no page or
console errors, no external requests, retained-heap checkpoints, long tasks,
event-loop delay, task duty, DOM/listener bounds, render instrumentation, copy
pressure/reasons and root-render isolation.

| Metric | Desktop | Mobile |
| --- | ---: | ---: |
| Emitted candles / required minimum | 2,402 / 1,800 | 2,403 / 1,800 |
| Retained heap net growth | -1,393,080 B | -3,737,572 B |
| Task duty / limit | 0.170 / 0.35 | 0.209 / 0.45 |
| Max event-loop delay / limit | 43.6 / 250 ms | 45.1 / 250 ms |
| Max long task / limit | 50 / 150 ms | 79 / 150 ms |
| Total blocking time / limit | 0 / 250 ms | 214 / 250 ms |
| DOM node/listener delta | -1 / 0 | -1 / 0 |
| Application-root renders during measured stream | 0 | 0 |

Artifacts:

- `desktop-latest.json` SHA-256
  `325f7b465a4ccf6e356939d9a01acf1e0105b7b0f41e5615a8ea0e3566f72160`;
- `mobile-latest.json` SHA-256
  `f97e087d90135096a7aab27424352b627e3b01fced3744e41a030e53c79383bb`.

## Recovery and cutover gate

The exact-SHA drill must use only:

- Compose container `11-postgres-1`;
- project PostgreSQL `127.0.0.1:55434/saltanatbotv2`;
- a new marker/OID-protected replacement database named
  `saltanatbotv2_restore_r4_recovery_test_<stamp>`;
- a new recovery-owned SQLite directory outside the active data directory;
- bundled `scripts/recovery-pg-dump.mjs` and
  `scripts/recovery-pg-restore.mjs`;
- the two project user units `saltanatbotv2.service` and
  `saltanatbotv2-research-worker.service`.

The rehearsal restores schema 11 / SQLite 8, migrates only the replacement to
schema 12 / SQLite 9, repeats migration as a no-op, validates checksums,
inventories `executor_commands` plus all canonical paper tables, runs the
marker/OID-bound rollback drill and removes only the exact replacement. The
canonical production database and active SQLite must remain version 11/8 until
cutover.

After exact-SHA Actions are green, a stopped pre-cutover paired generation is
the rollback source. Only then may the protected release migrate production and
restart the two project units. A post-cutover schema-12/SQLite-9 generation and
drill are mandatory. Any identity, hash, migration, readiness or smoke mismatch
restores the prior protected release; broad database/service/container cleanup
is forbidden.

## Resource boundary observed during local gates

- CPU: 192 logical processors.
- Memory: about 2.0 TiB total and 1.3 TiB available at observation time.
- Disk: about 7.8 TiB total and 6.0 TiB available.
- Project PostgreSQL: about 89 MiB RSS under its 2 GiB container limit at the
  observation snapshot.
- Declared listeners stayed `4180` for the protected application and loopback
  `55434` for project PostgreSQL.

These are point-in-time observations, not the R11 100-user capacity proof.
