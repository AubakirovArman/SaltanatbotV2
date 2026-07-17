# R3.3 onboarding and operations evidence

Status: released to production on PostgreSQL schema 11 from commit
`377c42bd8e54a1de2f635a9f6aa3bd1a92ce29c0`.
Verified: 2026-07-17.

This record closes R3.3 and the O1 slice required by it. It does not close R4
and is not an HTTPS or live-trading readiness claim.

## Delivered contract

- PostgreSQL migration v11 adds revisioned, owner-scoped onboarding and a
  bounded `research-worker` heartbeat without changing another project's
  database or service;
- onboarding offers one finite first-use goal: Monitoring, Price alert,
  Backtest or Paper robot, and stores only that owner's progress;
- optimistic writes return a stable conflict instead of silently overwriting a
  newer tab, and onboarding responses are `no-store` and body-bounded;
- established users are backfilled as dismissed so that an upgrade does not
  present a false first-run journey; newly registered users receive the normal
  first-use flow;
- RU, EN and KK UI supports keyboard use, 200% text and the contained mobile
  journey, with one next action and documentation access;
- the manifest has distinct 192, 512, maskable 512 and Apple 180 icons;
- Service Worker registration, installation/update controls and the offline
  bundle are disabled on an ordinary non-localhost public HTTP origin. Normal
  authenticated use and verified workspace export remain available;
- global API admission, bounded readiness probes, a dedicated readiness rate
  limiter, short single-flight result caching and administrator-only detailed
  diagnostics protect the interactive process;
- paired PostgreSQL/SQLite recovery generations, replacement-only drills and a
  locked append-only verification receipt provide the R3.3 operational
  recovery boundary.

## Local and database gates

The accepted exact worktree passed:

- `npm test`: 425 files and 2,587 tests passed; 6 files and 64 tests were
  skipped because their destructive PostgreSQL environment was not enabled in
  the ordinary unit-test command;
- `npm run check`;
- `npm run lint`: 1,564 files clean;
- `npm run architecture:check`: 1,020 source files within their budgets;
- `npm run docs:check` and `git diff --check`;
- targeted readiness/admission tests: 91/91;
- targeted recovery/status tests: 117/117;
- the complete isolated PostgreSQL matrix: 6 files and 64/64 tests across
  compute jobs, identity lifecycle, execution ledger, workspaces, onboarding
  and component heartbeats.

The PostgreSQL matrix used only dedicated, unprivileged temporary roles and
databases. Its exact temporary resources were removed after the run. The green
CI PostgreSQL job independently passed the four security suites enabled there:
56/56 tests across compute jobs, identity lifecycle, execution ledger and
workspaces.

## Build and browser gates

The frontend was built outside the production checkout. The isolated candidate
passed production build, PWA validation and bundle validation:

- 28 static shell/icon files passed the PWA contract;
- initial JavaScript: 59.3 KiB;
- total distributable size: 810 KiB;
- largest lazy application route: 174.7 KiB;
- the required 10% bundle headroom remained intact.

Browser evidence:

- the five R3.3 journeys passed 5/5 under the main Playwright configuration;
- GitHub Actions Chromium passed 84/84, including those five onboarding and
  insecure-origin PWA journeys as tests 80–84;
- Firefox critical journeys passed 18/18;
- Chromium visual regression passed 6/6 without replacing a baseline to hide
  a difference.

## Publication and CI fix-forward

The first direct-main publication was commit
`2903b833b77df339fef1cd7d64c1f98ddb503dbf`
(`feat: add onboarding and operational safety`).
[GitHub Actions run 29544212786](https://github.com/AubakirovArman/SaltanatbotV2/actions/runs/29544212786)
failed the secret-pattern scan, PostgreSQL integration and Chromium jobs, while
typecheck/lint/test/build, Firefox and visual regression were green.

The failure was handled as an additive fix-forward, not by force-pushing or
rewriting the failed publication. Commit
`377c42bd8e54a1de2f635a9f6aa3bd1a92ce29c0`
(`fix: stabilize release CI gates`) removed the secret-scanner fixture-name
collision, fixed the deterministic identity-test clock and made the insecure
origin derive its port from the active Playwright base URL while retaining the
non-localhost hostname.

[GitHub Actions run 29544792258](https://github.com/AubakirovArman/SaltanatbotV2/actions/runs/29544792258)
then passed all six jobs for the exact final SHA: secret scan, PostgreSQL
security integration, typecheck/lint/test/build, Firefox critical journeys,
Chromium end-to-end and Chromium visual regression. `origin/main` and the local
`main` head were verified at that SHA before packaging.

## Protected release identity

Production uses the protected read-only exact-commit release:

`/home/arman/.local/share/saltanatbotv2/releases/r33-schema11-377c42b`

It was created from `git archive` of the exact commit, installed with the
lockfile, built and checked, then pruned to production dependencies. Its
identity is:

- migration v11 SHA-256:
  `8e9906f5aa4e98cbf15cf31dd68c5fb5f8462889d7ba995ca4edbc5e456681f3`;
- 9,973 regular-file checksum entries and 12 exact symlink entries;
- `RELEASE-SHA256SUMS` SHA-256:
  `3c26b2e306101af5bfc7906d970168a4aa14054ee0d291d08c3d9441a508e5a3`;
- `RELEASE-SYMLINKS.txt` SHA-256:
  `633b62d75d11327efb800c3e48966cd45da3f61e8a30f73f61ee17d6d7fc3803`;
- `STARTUP-SAFETY.sha256` SHA-256:
  `d6695fef65fb663ac470aabd9c17b6e7aa441371ee8f514cc2c85d473ac2dc15`;
- backend `server.js` SHA-256:
  `1e51daa3ec1bf387afa296d80c074c7a4fef5ab865c6323b7b403c58d900ee67`;
- backend `workers/researchWorker.js` SHA-256:
  `93fd71750a382873d0dd99a55ef25a97211ccb49cd2046cacfbdaa408eb21724`;
- frontend `index.html` SHA-256:
  `feea2bd224e06908f65cb225412dcd490aa9fdfbdda85703cab33f11aaddcedd`;
- frontend `service-worker.js` SHA-256:
  `fc53339b0f62fa79a10eecd3803a820a40107d15b68aba315f8b5129a3058c67`;
- protected frontend tree: 75 files, tree SHA-256
  `e236ed4630611caa8c79c4e1eb719d8510a363ee917539366fe4dc115e03ce0d`.

The release entry is `assets/index-BeKNetRc.js`. The repository checkout's
`frontend/dist` was deliberately not rebuilt or used for cutover: its 95-file
tree remained `c778450bae453dfa9e5e0bea3584cc00924a207ef33c593b138861c4aa4cb993`
when hashed from `frontend/dist` with dot-prefixed paths, and
`8fbe41e2188def393af05995fcb773f262206de65fc53ed650dc55ef71e5923c`
when hashed from the repository root.

## Recovery and migration evidence

Three verified paired generations were retained under the project recovery
root:

| Generation | Schema / provenance | PostgreSQL dump SHA-256 | SQLite manifest SHA-256 |
| --- | --- | --- | --- |
| `pre-r33-schema10-online-20260717T003651Z` / `f7bf3469-bb15-43b6-8229-2f307fe38cd0` | schema 10, active release `e3f8cc6e464faf5c8c9d3a4f624d79cbc3c77852` | `a136dccbbeec99ae8fa1d84e1fc945066d1d04ac0406c1f64cbe3225ac0b08fc` | `68c2a6309024a7ae2a4e23374c76547648ae10b7aa1c003b0b58a7a656bf241b` |
| `pre-r33-schema10-stopped-20260717T004052Z` / `aa2b541c-5316-4bbd-8567-01cbdca587b9` | coordinated stopped schema 10, release `e3f8cc6e464faf5c8c9d3a4f624d79cbc3c77852` | `5805ce54c4c57d00babc3a6e5caccda65c7b7598060873c3d9fbb9324315f899` | `9228caeb15326520fff6062ab8d2a3cc46d468c2c25650efda8dc36415ac0705` |
| `post-r33-schema11-20260717T004414Z` / `4888cde3-a5ba-4fab-b647-ac3e624e4b0a` | schema 11, release `377c42bd8e54a1de2f635a9f6aa3bd1a92ce29c0` | `c24508340438d59ace4fbe83ecc48342af5cfb88405ed481f7a0477ed349d804` | `692d6c270d8f50505da953d06f3cfef82585ca9c2be7bd9db9d9fb1e3a800ae7` |

The owner-set SHA-256 was identical in all three generations:
`0b9aadf54e798930e3df5d09d73f727014c8a5c8ffc218cabb8cc94f6568fd5f`.
The pre-cutover manifests contained 4 users and no onboarding rows; the
post-cutover manifest contained the same 4 users and 4 onboarding rows.

A replacement-only schema-10→11 recovery-hook drill restored the temporary
copy, migrated it and verified 4 users, 4 onboarding rows, all 4 established
users suppressed, and zero heartbeat rows before worker startup. Both the exact
temporary database and temporary data directory were removed afterward.

The recovery receipt contains exactly three newline-delimited verified records.
Its permanent lock is mode `0600`, has link count one and is never deleted by a
writer. The receipt and lock are not a substitute for the immutable generation
manifests and dumps.

## Coordinated production cutover

Only the project database `saltanatbotv2`, the two project user units and the
protected frontend release slot were changed. The project PostgreSQL container
remained `11-postgres-1` on `127.0.0.1:55434`; no foreign port, database,
container, volume, service or project was changed.

Accepted production state:

- PostgreSQL schema: 11;
- users: 4;
- onboarding rows: 4, all four established accounts migration-suppressed;
- runtime heartbeat: one `research-worker` row, status `ready`, schema 11,
  release commit `377c42bd8e54a1de2f635a9f6aa3bd1a92ce29c0`;
- public health and readiness: ready on port 4180;
- `saltanatbotv2.service`: PID 226891, `NRestarts=0`;
- `saltanatbotv2-research-worker.service`: PID 229029, `NRestarts=0`.

At the acceptance snapshot the API used 268,185,600 bytes and the worker used
19,677,184 bytes. The host snapshot reported 192 logical CPUs with load averages
25.13/22.79/22.77; 2.0 TiB RAM with 668 GiB used and about 1.3 TiB available;
an 8 GiB swap device with only about 42 MiB free; and a 7.8 TiB root filesystem
with 1.5 TiB used and 6.0 TiB available (20% used). This is a point-in-time
shared-host observation, not the R11 100-user capacity proof. The nearly full
swap remains an operator observation even though available RAM was high.

## Security boundary and next release

Production remains `RUNTIME_PROFILE=public-http-paper`. R3.3 added no TLS
termination, certificate, domain, secure-cookie activation, exchange API-key
entry, private exchange stream, signed REST request, live order, borrowing or
collateral action. Passwords and session cookies are still unsafe on an
untrusted HTTP network; the documented VPN/private-network/IP-allowlist advice
still applies.

R4 is next and remains planned. Its paper-account, capital reservation,
portfolio, journal and “Running” UI contracts are not claimed by this evidence.
