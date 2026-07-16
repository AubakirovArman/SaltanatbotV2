# R3.2 workspace workflow evidence

Status: release candidate accepted locally; commit, push, GitHub Actions and production
schema-v10 cutover remain pending.
Verified: 2026-07-16.

## Implemented backend contract

- additive checksummed PostgreSQL migration v10 with archive metadata and
  trigger-maintained payload-byte accounting;
- a transactional v9→v10 preflight rejects pre-existing payloads that cannot satisfy the new
  PostgreSQL `jsonb` representation ceiling;
- strict current workspace schema v8 plus checksum-protected legacy schema-v7 import
  compatibility;
- owner-scoped list, quota, create, update, rename, duplicate, archive, restore, archived-only
  permanent purge, import/export, revisions and rollback;
- independent optimistic wrapper revision and workflow content revision;
- monotonic schema-v8 content lineage for server rename and rollback, while archive/restore remain
  wrapper-only and legacy schema v1–v7 content remains unchanged;
- configurable defaults: 25 active workspaces, 75 total workspaces, 20 snapshots, a 1 MiB compact
  persisted payload and 64 MiB retained current-plus-revision payload per owner;
- the compact request/import envelope is bounded independently at the persisted-payload limit plus
  a fixed 64 KiB wrapper reserve;
- UUID/descending-revision keyset pages fetch payload metadata first, cap the complete serialized
  response at 4 MiB and expose explicit cursor, item and byte metadata;
- workspace rows and quota share one read-only repeatable-read PostgreSQL snapshot;
- compact JSON size, depth, node count, PostgreSQL separator spacing, finite exponent-number
  expansion, NUL and unpaired-surrogate validity are bounded before persistence;
- schema v10 constrains the actual PostgreSQL payload representation below `4 MiB - 64 KiB`;
- quota rejection responses reread committed usage after rollback and expose the rejected
  projection separately as `attempted`;
- owner-row serialization and transaction rollback protect conflicts, quota rejection and storage
  rejection, including a durable authorization-revision fence after concurrent user lifecycle
  changes;
- stable no-store JSON errors cover malformed JSON, body-size failures and database-representation
  overflow;
- `FRONTEND_DIST_DIR` is immutable typed configuration validated before identity database access
  or listener startup; the validator rejects symlinked or incomplete distributions and verifies
  every local resource referenced by `index.html`.

## Backend and database gates

Verified commands:

- `npm test`: 406 files passed, 2,405 tests passed, 56 tests skipped;
- `npm run check`;
- `npm run lint`: 1,510 files clean;
- `npm run docs:check`: 216 Markdown documents, 136 HTTP and 6 WebSocket endpoints, 39 blocks;
- `npm run architecture:check`: 998 source files within their budgets;
- `git diff --check`;
- targeted backend workspace/identity suites after the final response-bound changes:
  6 files and 80 tests passed.

The destructive PostgreSQL suite ran only against the dedicated unprivileged temporary role and
database `codex_r32_workspace_test`. It covers:

- a fresh migration and v9→v10 backfill;
- oversized-v9 preflight failure without partial migration;
- two-owner IDOR resistance and authorization-revision fencing;
- stale-tab conflicts and strict content/wrapper revision separation;
- bounded list/revision pages and one-snapshot quota reads;
- archive immutability, restore and archived duplication;
- checksum import/export and rollback;
- active, total, storage and revision quotas;
- concurrent creates, lowered-limit recovery and purge cascade.

The final isolated PostgreSQL run passed 18/18 tests. The exact temporary database and role were
removed afterward. Production PostgreSQL remained on schema 9 with zero workspace and revision
rows during local acceptance.

The non-default configuration probe also passed with:

- 17 active workspaces;
- 41 total workspaces;
- 9 revisions;
- 765,432 compact payload bytes;
- 98,765,432 retained payload bytes.

## Frontend contract

- schema-v8 portable workspaces retain layout, per-pane markets, timezone, indicators and
  per-pane overrides, comparisons, drawings, panels, mode and an exact strategy
  ID/revision/hash/parameter binding;
- strict v8 and checksum-protected v7 import, a bounded file envelope and deterministic browser
  SHA-256 fallback keep import/export usable on the current public-HTTP origin;
- authenticated synchronization exposes `idle`, `loading`, `saving`, `saved`, `offline`,
  `conflict`, `quota` and `failed` without automatic last-write-wins retry;
- synchronization exhausts and de-duplicates bounded list pages for pulls and purge absence
  checks, while rollback walks revision pages only until a useful target is found;
- stale responses are fenced by owner and auth revision, and every client serializes mutations;
- a multi-conflict queue preserves the latest local workflow, including the dirty-UI → pull
  conflict → immediate keep-copy path;
- local migration uses owner-scoped storage, an ACK-before-delete rule and an IndexedDB
  add-if-absent fallback when Web Locks are unavailable;
- exact local snapshots are written on explicit actions, page hide, visibility loss, unmount and
  owner switch; high-frequency drawing/resize/slider/context changes are coalesced for 120 ms;
- the menu supports create, templates, rename, duplicate, archive, restore, permanent purge,
  import/export and server rollback in RU/EN/KK;
- keyboard focus, Escape handling, 200% text and mobile controls at least 44 px are covered.

## Isolated build and browser gates

The authoritative build and Chromium/visual run used the isolated source copy:

`tmp/r32-final-gate-20260716T1856Z`

The copy excluded `.git`, dependencies, backend runtime data, compiled backend files, the live
frontend distribution and all prior temporary gates.

Verified results:

- `npm ci --ignore-scripts`: 243 packages, zero vulnerabilities;
- production build passed;
- PWA check passed;
- performance check passed with 58.3 KiB initial JavaScript, 804.3 KiB total distributable size
  and 170.1 KiB for the largest lazy application chunk, preserving the required 10% headroom;
- Chromium end-to-end: 79/79;
- container visual regression: 6/6.

Candidate frontend identity:

- entry: `assets/index-DWXUWEnD.js`;
- `index.html` SHA-256:
  `0242ef7ffc6697f44cbb5ed99ece625c717559f76995863ed5654a6c4ab96caf`;
- `service-worker.js` SHA-256:
  `abb8cbd54a6d8f97dcc530b2a92a37c8e391abbfbf7a4d3b8f20b4e130a35340`;
- the static distribution validator accepted 10 referenced resources.

Firefox ran from a second clean copy so container-owned runtime files from the Chromium gate could
not affect it:

`tmp/r32-firefox-gate-20260716T190723Z`

Firefox critical journeys passed 18/18 on temporary `127.0.0.1:4192`. The test server exited with
the suite; production port 4180 was not touched.

## Pre-cutover safety evidence

- verified online SQLite runtime backup:
  `tmp/pre-r32-safety-20260716T1712Z/runtime`;
- verified PostgreSQL custom-format schema-9 dump:
  `tmp/pre-r32-safety-20260716T1712Z/saltanatbotv2-schema9.dump`;
- dump SHA-256:
  `c12a55da845b33f1232e81d34929abbafff300de65bb992c83cad7977df27b2b`;
- backup manifest SHA-256:
  `26df8086151faf8657a9805f0c34967cc54d974016267243219aa6f6abfe26a9`;
- protected read-only schema-9 rollback release:
  `/home/arman/.local/share/saltanatbotv2/releases/pre-r32-v9-2b0d86a`;
- its API and worker launchers verify release checksums and the symlink manifest before restoring
  the exact v9 compiled backend/frontend into the project runtime boundary.

The effective user-unit commands still point to the protected v9 launchers:

- `saltanatbotv2.service` →
  `/home/arman/.local/share/saltanatbotv2/releases/pre-r32-v9-2b0d86a/start-api-v9-safe.sh`;
- `saltanatbotv2-research-worker.service` →
  `/home/arman/.local/share/saltanatbotv2/releases/pre-r32-v9-2b0d86a/start-worker-v9-safe.sh`.

During local acceptance both units remained active with zero restarts:

- API PID 2,416,297;
- worker PID 2,416,410.

The live frontend was explicitly restored to the exact v9 protected shell after isolated candidate
verification:

- live entry: `assets/index-D2XOAsge.js`;
- live `index.html` SHA-256:
  `929fbab427f42e9ed2b7e1e2c9c39f34c4f1228ab81bd9161dc15ac8a16ab060`.

This static release boundary is intentional. The future schema-v10 launcher must serve the
candidate release slot directly through `FRONTEND_DIST_DIR`, so a later local build cannot replace
the production UI.

## Remaining release evidence

1. Commit and push the reviewed candidate to `main`.
2. Obtain green GitHub Actions for the exact pushed commit.
3. Build a protected candidate release from that exact committed SHA rather than from the mutable
   worktree.
4. Stop only the two SaltanatbotV2 user units: research worker first, API second.
5. Create the final coordinated project-only SQLite backup and PostgreSQL schema-9 dump, then
   verify restore and v9→v10 migration in a new temporary project-owned database.
6. Point both unit drop-ins at checksum-verifying candidate launchers while the units remain
   stopped.
7. Start and verify the API first: schema 10, migration checksum, health, readiness,
   `public-http-paper`, disabled live trading, authentication, workspace list and quota smoke.
8. Start the research worker only after API acceptance, because the worker can also run database
   migrations.
9. Record the post-cutover PIDs, restart counts, schema, frontend hash and rollback verification in
   this evidence document.
