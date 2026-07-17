# R4 canonical paper portfolios — accepted release evidence

Status: **accepted, pushed to `main`, deployed on port 4180**

Evidence date: 2026-07-17

R4 delivers owner-scoped canonical paper portfolios, the Running robots
workflow, durable accounting and journal evidence, and a fenced
PostgreSQL-to-SQLite executor boundary. It does not enable HTTPS, exchange
credentials, private streams, signed private requests, live orders, real
borrowing or collateral/margin mutations.

## Release identity

R4 was accepted as an auditable lineage rather than collapsing feature and
follow-up fixes into one ambiguous identifier.

| Release step | Commit | Exact GitHub Actions | Result |
| --- | --- | --- | --- |
| Canonical portfolios and fenced executor | `05a38bdce04e0c2bc85a7b85db24cb7f6b02bf5c` | `29554942717` | 6/6 successful; schema 12/9 cutover |
| Robot-workspace contrast and 44 px targets | `532e6272cef078ad17edbcc2baccee8731a8edce` | `29557483669` | 6/6 successful |
| First compact-timeframe containment revision | `ccea8fa5baa9792981ed311ff759d5097375beaa` | `29559000460` | Superseded before cutover; four jobs succeeded and two were cancelled by the replacement revision |
| Compact timeframe containment and WCAG 2.2 regression | `7900cf4042f5a40623e38031ce810f7bbd2588b8` | `29559153650` | 6/6 successful |
| Narrow robot-drawer grid containment | `bb455facdfe5a1b3cabe15490c86c299ea684ee7` | `29560112312` | 6/6 successful; final production identity |

The final protected slot is
`/home/arman/.local/share/saltanatbotv2/releases/r4c-schema12-bb455fa`.
Its directories and ordinary files are read-only to the service owner, its two
launchers are executable, and `publish.lock` remains writable only for the
launcher lock. Important checksums:

- `RELEASE-SHA256SUMS`:
  `d94474e7b08d319294d418a934527e9aded4ac6738bc6885d8ea1cad7472b4ca`;
- `STARTUP-SAFETY.sha256`:
  `18a71e7db49958f53c4d5cb134897603ff03eea05969969f0297a9bece7a7a4f`;
- `RELEASE-METADATA.txt`:
  `6fe1c48d4752c9c0affbb4ef70aa275b341c2e3f9d46f8f49c1f48ed918b4e7a`.

At final acceptance, local `HEAD`, remote `origin/main`, slot metadata,
systemd `ExecStart`, the worker heartbeat and the served `index.html` all
resolved to the final commit.

## Accepted schema and authority contract

- PostgreSQL schema 12 adds the bounded `executor_commands` queue. Migration
  `durable_executor_command_queue` has SHA-256
  `72beb8455a9e96de97d28129b34a1a6a2c8a103090e1aa5455a9c9a0aa56d8d6`.
- Trading SQLite schema 9 adds paper portfolios, epochs, allocations,
  valuation marks, mutation receipts, immutable robot-revision evidence,
  tombstones, events and rebuildable projections. Its migration SQL SHA-256 is
  `e894c233d6a0597c7ac849aa59a2ebe969b837d01c6cb17ca4a037a0af4fa50f`.
- PostgreSQL owns authorization and durable commands. Exactly one fenced
  executor owns `trading.db`.
- An exact SQLite mutation receipt makes a lost PostgreSQL acknowledgement
  replay-safe; reclaimed work cannot perform the mutation twice.
- Active-session, paper-role, authorization revision/epoch, owner,
  idempotency, portfolio revision, robot revision and ledger epoch are enforced
  as fences.
- Missing or stale equity, margin and borrowing evidence remains explicitly
  unavailable/stale; the UI never invents zero.

The public and operator contract is documented in
[Canonical paper portfolios](../PAPER_PORTFOLIOS.md).

## Verification ledger

The feature candidate passed the following gates before production migration:

| Gate | Accepted result |
| --- | --- |
| TypeScript and Vitest | 448 files passed, 7 skipped; 2,747 tests passed, 74 skipped |
| PostgreSQL security integration | 5 files / 66 tests passed |
| Architecture budgets | 1,065 source files passed |
| Biome | 1,639 files passed |
| Documentation generation and semantics | Passed |
| R4 Chromium journeys | 3/3 at 1440×900, 390×844 and 320×700 |
| Ordinary Chromium | 87/87, one worker, zero retries |
| Firefox critical journeys | 18/18 |
| Container visual regression | 6/6 |
| PWA | 27 same-origin files and all required install icons |
| Bundle budgets | Initial JS 59.4 KiB; distributable JS 831.0 KiB; distributable CSS 46.4 KiB; 10% reserve retained |
| Stream/render soak | Desktop and mobile 2/2, strict checks passed |
| Exact final GitHub Actions | Run `29560112312`, all 6 jobs successful |

Direct security/accounting tests cover fixed-micros capital conservation,
fees/funding, realized and unrealized evidence, bounded journal windows,
duplicate commands, lost acknowledgements, authorization revocation,
crash-left intents, terminal replay, no-market-price rejection, deletion
release, startup ordering, shutdown drain/abort, two-owner isolation,
administrator non-bypass, CSRF and optimistic revisions.

## Recovery and cutover chronology

Only project container `11-postgres-1`, project PostgreSQL
`127.0.0.1:55434/saltanatbotv2`, project recovery roots and the two project user
units were used.

| Stage | Generation / identity | Manifest SHA-256 | Result |
| --- | --- | --- | --- |
| Online schema-11/SQLite-8 rehearsal | `47b5a5c2-6d74-4f81-a105-b750b5cd86ce` | `04a78d7b148fbfb0e73e8ab7259bb1620fd67255542d7b59122f79bca102fba1` | Restore and isolated 11→12 / 8→9 migration passed; second migration was a no-op |
| Stopped pre-cutover rollback source | `4333134e-18f1-47e6-a9d5-8e83dd8332fc` | `69577622c3a3d5de3438d9c23debe36e5b6e36a75901fcfdc4a1d318655edf90` | Verify and drill passed |
| First post-R4 generation | `e31f79d2-75a9-400f-8302-2945ef497100` | `3a3137383fce76364d0a497ccbd8c6ba9460e1ffab1ed90dc11bfc68c721ea2e` | Schema 12 / SQLite 9 verify and drill passed |
| Pre-R4a generation | `2bdb4bff-7503-4299-bd70-d0ca80bcff2a` | `aa7828233204124f6a2ede2dfb4477759955ed8490c65c05cbe4f2d4f334e246` | Verified |
| Pre-R4b generation | `d86ea611-85a4-414d-8a6a-fa2693e55cc6` | `e1b5762dae8e2bf614e911a90d0437185d5843e0536959355dc95f1a0f7a78d7` | Verified |
| Final post-R4c generation | `8a36f72b-248f-4ccb-b7e7-11ab98c29ea0` | `b0798ab8ca77bd9c2b014dc2b01dfe3baab7d4d1e74a010bcd887ab00455d6b5` | Verified; isolated restore drill passed and self-cleaned |

The ready R33 full-pair rollback remains retained at
`/home/arman/saltanatbotv2-recovery/replacements/r4-r33-rollback-20260717T050122Z`
with replacement database OID `93153`; it was only preflight-verified and was
not opened after preparation. The isolated rehearsal pairs with OIDs `91733`
and `92473` are also retained for exact marker/OID-bound cleanup. The unrelated
database `saltanatbotv2_test_r33_20260716201247` remained untouched at OID
`44244` with no project recovery marker.

The final post-R4c drill created only
`saltanatbotv2_drill_20260717064125_07808c04`; the tool then dropped that exact
database and removed its exact temporary data directory.

## Production runtime acceptance

After final cutover:

- `/api/ready` returned `ready` for migrations, PostgreSQL, executor,
  research worker, filesystem and admission;
- API and worker were active with `NRestarts=0`;
- worker heartbeat was
  `ready|bb455facdfe5a1b3cabe15490c86c299ea684ee7|12`;
- PostgreSQL reported schema 12 with the expected checksum;
- SQLite reported `user_version=9`, `quick_check=ok` and zero foreign-key
  violations;
- listeners were limited to application `0.0.0.0:4180` and project PostgreSQL
  `127.0.0.1:55434`;
- runtime profile was `public-http-paper`, execution mode `paper-only`,
  private exchange requests and credential writes were false.

The machine-readable runtime receipt is retained with the accepted visual
evidence under
`/home/arman/.codex/visualizations/2026/07/15/019f633e-81e3-73e0-b149-d9979b82c157/r4-production-4180-runs/accepted-20260717063809714-bb455facdfe5`
as `runtime-receipt.json` (SHA-256
`b7fa612302f88ca9c622a6c603249f098a4ca30d545e489a40e253f967586ed8`).

## Production browser and visual acceptance

The final authenticated read-only Chromium 149 run used RU, dark theme, UTC,
reduced motion and blocked service workers. It captured desktop 1440×900,
mobile 390×844 and narrow 320×700 list/detail states.

Acceptance result:

- eight PNG artifacts;
- `failures: []`;
- full-document/dialog Axe WCAG 2.0, 2.1 and automated 2.2 AA rules: zero
  violations;
- zero undersized 44 px coarse controls;
- zero document, nested or drawer horizontal overflow;
- drawer remained vertically contained and both mobile sizes reached their
  exact scroll bottom;
- close-button and Escape both restored focus;
- the trading WebSocket health remained connected;
- no console/page errors, unexpected HTTP errors or domain-mutating requests.

All artifacts in the table below and `acceptance.json` are retained in the same
accepted evidence directory identified above. `acceptance.json` SHA-256:
`60ce89612cab61d07cc798d3706fd044c3b0c475fdd25344b515692cae43b79f`.

| Artifact | Viewport | SHA-256 |
| --- | --- | --- |
| `desktop-portfolio-list-1440x900.png` | 1440×900 | `f5c2e0240bfb5b895c383beb18af91ec7ea40df0b61b24114329912299f4082e` |
| `desktop-robot-detail-top-1440x900.png` | 1440×900 | `0e42ec31e1a449c317c6f20046ab4879ebcec0d057f01c9185b146cb625677d8` |
| `mobile-portfolio-list-390x844.png` | 390×844 | `30178bca72dff83fd497431fbf50b8027554916e814d2d033f4d1842ec4ea2ed` |
| `mobile-robot-detail-bottom-390x844.png` | 390×844 | `ca319682e72e867cf8acb1955cf0ad98297da9a71c81039aee6063f2ce389426` |
| `mobile-robot-detail-top-390x844.png` | 390×844 | `1ae8a9bb7839ddbc6ac956e02d4c2638611aaecedd64aaa139908d86dad83def` |
| `narrow-portfolio-list-320x700.png` | 320×700 | `27fa78e223fd912a5962ebc3f01ec2c66ca756b7bf384e7d1621fb7b2a8c5274` |
| `narrow-robot-detail-bottom-320x700.png` | 320×700 | `a7c80ab610ac2946021012657636c183250c05dabc318b38b2d0661734db6816` |
| `narrow-robot-detail-top-320x700.png` | 320×700 | `2b84b518811be89969ad67d83df372313c7e2034be940ac39ca2e2fcc79ebbdc` |

Side-by-side comparisons were reviewed for desktop, mobile and the narrow
drawer. No new clipping or layout regression was observed. This automated
evidence does not claim a manual Android Opera run or VoiceOver, NVDA,
TalkBack or other assistive-technology certification.

## Point-in-time resource boundary

This is a shared-host snapshot, not the R11 100-user load proof:

- 192 logical CPUs; load averages 21.88 / 22.36 / 23.60;
- about 2.16 TB RAM total and 1.43 TB free;
- about 8.50 TB filesystem capacity and 6.55 TB free;
- API about 341 MiB current memory, worker about 22 MiB;
- PostgreSQL about 110 MiB under its 2 GiB limit;
- project data about 62 MB; protected final release about 102 MB.

Swap was almost fully allocated (about 83 MiB free of 8 GiB) despite abundant
free RAM. That was not an immediate R4 readiness failure, but it remains a host
operations signal to monitor and is not evidence of 100-user capacity.

## Residual boundaries and next stage

- HTTPS remains explicitly deferred.
- No private exchange streams, signed private requests, live orders,
  credential writes, real borrowing or real margin/collateral mutation were
  enabled.
- One API process and one fenced SQLite executor remain the supported topology.
- R5 alerts/screener automation is the next pending increment; it is not part
  of this R4 acceptance receipt.
