# ADR 0002: owner-only direct-main release gate

Status: Accepted
Date: 2026-07-17
Decision owners: project owner and release maintainer

## Context

The project owner selected direct publication of accepted changes to `main`.
Until a required-check GitHub ruleset supersedes this decision, that workflow
needs an explicit exception that preserves the same fail-closed release
properties without pretending that tests are enforced by GitHub before the
push.

This ADR governs repository publication and production cutover only. It does
not authorize unrelated changes, destructive host operations, HTTPS activation,
private exchange connectivity or live trading. The runtime remains
`RUNTIME_PROFILE=public-http-paper`.

## Decision

1. **Owner-only exception.** Only the project owner may publish an accepted
   release commit directly to `main`. The release maintainer prepares and
   attests the evidence but may use the exception only when they are also the
   project owner. Another contributor, automation token or administrator role
   cannot bypass the gate.
2. **Exact-worktree evidence.** Before any local release gate, evidence records
   the canonical project root, current `main` branch, upstream remote URL, local
   base SHA, current remote `main` SHA, worktree status and the accepted staged
   tree identity. A gate run in another checkout, against another staged tree or
   before the final accepted edit does not count.
3. **Mandatory local gates.** The release ledger's applicable type, lint, unit,
   integration, build, documentation, architecture, PWA, browser, visual,
   performance, coverage and secret checks run in that exact worktree. Their
   commands, exit status and artifacts are retained with the release evidence.
   If a gate changes a tracked file or the accepted tree changes afterward, the
   affected review and gates run again before commit.
4. **Scoped commit.** Only reviewed, accepted paths are staged. The resulting
   commit tree must equal the gated staged-tree identity. Unrelated user changes
   are neither staged nor rewritten.
5. **No foreign-resource mutation.** Release checks and publication must obey
   the recorded project/service/container/port/database/data-directory identity.
   Kill-by-port, broad `pkill`, forceful or global Docker cleanup, root-systemd
   mutation, foreign database changes and foreign volume reuse remain forbidden.
   An identity mismatch or resource collision stops the release.
6. **Remote-head recheck.** Immediately before push, the publisher fetches the
   target remote and verifies that remote `main` still equals the recorded base
   SHA and that the proposed update is a fast-forward. If remote `main` moved,
   publication stops; the change is reconciled with the new head and the exact
   tree is reviewed and gated again.
7. **No history rewrite.** Publication uses a normal fast-forward push to
   `main`. `--force`, `--force-with-lease`, ref deletion and any equivalent
   history rewrite are prohibited. After push, the remote head is fetched or
   queried again and must equal the intended local commit SHA.
8. **Post-push GitHub Actions gate.** The publisher identifies the GitHub Actions
   runs for the exact pushed SHA and waits for every required workflow to finish
   successfully. A run for another SHA, a skipped or missing required workflow,
   an unavailable result or a red result is not acceptance evidence.
9. **Production cutover gate.** No migration, service restart, frontend-slot
   switch or other production cutover may begin until the exact pushed SHA has
   green GitHub Actions and the release-specific backup, restore/rollback and
   project-identity checks are complete. Production remains on the previous
   accepted release while this gate is pending or failed.
10. **Fix-forward or revert without force.** If post-push validation fails,
    production cutover stays blocked. A small, understood defect may be fixed
    forward with a new commit; a security, authorization, data-integrity,
    runtime-profile or uncertain failure is reverted with a new `git revert`
    commit. Either path repeats this ADR's exact-worktree local gates,
    remote-head recheck, normal push and exact-SHA GitHub Actions verification.
    Published history is never rewritten to hide the failed commit.

## Evidence required for each direct-main release

- canonical project root, branch, remote URL, base SHA, pre-push remote SHA,
  accepted staged-tree identity and final commit SHA;
- the exact local gate commands, results and release artifacts;
- confirmation that only accepted paths were committed and no foreign resource
  was mutated;
- the immediate pre-push remote-head/fast-forward check and post-push remote SHA;
- links or machine-readable identifiers for all required GitHub Actions runs for
  that exact SHA;
- the production cutover decision, backup/rollback evidence and final smoke
  result, or the fix-forward/revert evidence when validation failed.

## Supersession

This exception must be superseded when `main` has a verified required-check
GitHub ruleset that enforces an equivalent or stronger workflow, rejects force
pushes and cannot be silently bypassed for ordinary releases. The replacement
decision records the ruleset configuration and proof against an exact test SHA;
until then this ADR remains the mandatory release gate.

## Consequences

- Direct publication to `main` is permitted only after the accepted local gate;
  it is not an informal shortcut around review or CI.
- A pushed commit is not a releasable production commit until GitHub Actions for
  that exact SHA are green.
- Failure recovery adds commits through fix-forward or `git revert`; it never
  rewrites shared history or mutates unrelated infrastructure.
- HTTPS and live execution remain outside the pre-HTTPS roadmap.
