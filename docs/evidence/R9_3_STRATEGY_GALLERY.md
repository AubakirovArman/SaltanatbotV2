# R9.3 versioned strategy gallery — acceptance evidence (completes R9)

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`7afde0d12b350babb01e166a1888d54c225d41ec`
(`feat: add the versioned strategy gallery with provenance and safe
import`); exact-SHA GitHub Actions run `29652078335` completed with 6/6
successful jobs. Production runs the protected slot
`r9c-schema18-7afde0d` on PostgreSQL schema **18** (migration
`versioned_strategy_gallery`, SQL SHA-256
`421a9b93d41c7618c8f30736fae0a45cfe37a14a3e418afc6aa6492696322512`,
additive only: the content-frozen `gallery_artifacts` table whose
BEFORE UPDATE trigger rejects every content change — revocation and
visibility are the only mutations) and unchanged trading SQLite schema
10. The runtime remains `public-http-paper` with the same three
project-owned units. **This release completes R9**: R9.1 (server
evaluation + ADR 0003), R9.2 (GA evolution) and R9.3 are all accepted.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 925 files), `architecture:check` (1 206
  files), `docs:check` (176 HTTP endpoints incl. the six gallery
  routes), production build, `perf:check` (no budget change needed),
  `pwa:check`.
- Vitest: 3 354 passed / 142 skipped, including the sanitizer suite
  (whitelist goldens for both publication sources, canonical-JSON hash
  goldens, rating weights), the routes suite (18 tests: versioning with
  byte-intact prior versions, the visibility matrix, revoke semantics,
  server-side hash re-verification, exact response key sets, and every
  serialized response grepped for owner/run/job identifiers) and the
  gallery panel/import suites.
- **Privacy — release criterion (§13 R9.3)**: publication runs every
  bundle through a whitelisting sanitizer; adversarial fixtures with
  owner ids, run ids and workspace references embedded in nested metric
  keys, values and even the IR name never reach a stored artifact (a
  leak aborts publication); no API projection ever serializes the owner
  id.
- **Reproducible artifact — release criterion**: the canonical-JSON
  SHA-256 is computed identically on server and client (parity golden
  against `node:crypto`); the server re-verifies the stored hash before
  serving an import and the client re-verifies it again — a tampered
  bundle is refused with `gallery_hash_mismatch` and no copy is created
  (tamper simulation tested end-to-end incl. the browser journey); the
  SQL trigger makes post-publication content change impossible
  (nine immutable-column UPDATEs each rejected at the database level).
- The PG-gated integration suite (`galleryPostgres`, 6 tests) was
  **executed** against an isolated PostgreSQL 16 (unprivileged role,
  `--no-file-parallelism` together with the compute-jobs and GA suites:
  31/31) and wired into CI.
- Container browser gates: Chromium e2e 98/98 (new journey: publish a
  library artifact behind the sanitization preview and explicit consent
  with the exact POST body — no owner UUID in the payload — then import
  a feed card through the review dialog into a revalidation-gated
  library copy), Firefox smoke 19/19, visual regression 6/6 (the
  strategy-studio snapshot advanced for the new Community button).

## Accepted behavior

- **Publication is an explicit owner action** producing an immutable
  versioned artifact (`gallery-artifact-v1`): from a library artifact or
  a promoted GA candidate (which requires the R9.2 OOS-gated
  promotion); a new publication of the same artifact id appends the
  next version and never rewrites earlier ones. The publish dialog
  shows the exact sanitized canonical JSON that will be stored and
  hashes it only after an explicit consent checkbox.
- **Cards carry the full picture**: markets/timeframes, engine and
  dataset fingerprints, seed, in-sample vs out-of-sample metric
  summaries with gap and overfit/unstable flags, complexity,
  publication date and limitations; the rating is a documented
  composite (OOS stability 0.35, drawdown 0.25, reproducibility 0.20,
  complexity 0.10, evidence age 0.10) and is never net profit alone.
- **Import is safe by construction**: a pure read returning the bundle
  plus its hash; the client creates an independent library copy marked
  `gallery` provenance with a revalidation gate — paper start (robot
  creation and the experimental trading panel) stays locked until a
  local validation backtest completes; import of a revoked artifact is
  refused (410) and publication never starts a robot.
- **Moderation**: private/unlisted/public visibility, owner
  revoke-with-reason; a second revoke never rewrites the first record.

## Release chronology (PostgreSQL 17 → 18 migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r9c-schema17-v10-20260718T171500Z` | `38c116d0-2cbc-43f6-920c-3ad9842f0ad1` | Backup + verify passed at PG schema 17 |
| Paired migration rehearsal | restore `saltanatbotv2_restore_r9c_rehearsal` | The production-data copy migrated `fromVersion 17 → toVersion 18`, applying exactly `versioned_strategy_gallery`; `gallery_artifacts` present; rehearsal database dropped and replacement directory removed afterwards |
| Production cutover | slot `r9c-schema18-7afde0d` | Drop-ins installed for all three units; restart through the slot launchers applied migration 18 on startup (identity log: schema 18); all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r9c-schema18-v10-20260718T164500Z` | `63c4b01f-3018-42a2-b271-3bc2037433ed` | Backup + verify passed at PG schema 18; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r9b-schema17-3ed6af1` and the verified schema-17 pre-cutover generation
are retained.
