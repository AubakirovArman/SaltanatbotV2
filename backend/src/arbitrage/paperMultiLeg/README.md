# Multi-leg paper journal

This module is an isolated, paper-only execution proof for two-leg route-family opportunities and
four-to-eight-leg cycle opportunities. It never imports an exchange private client and cannot place
an order. Engine-specific builders convert an already evaluated opportunity into an exact plan;
each plan records short-lived source provenance and explicit deterministic fill/compensation ratios.

The journal advances by one append-only event per SQLite transaction:

1. accept a fresh plan under a unique idempotency key;
2. record original paper fills in leg order;
3. stop on the first partial/unfilled leg;
4. record an explicit compensation decision;
5. simulate reverse fills in reverse leg order;
6. finish as `completed`, `compensated`, `aborted-no-exposure`, or
   `manual-review-required` with exact unresolved paper exposure.

`PaperMultiLegService.recoverIncomplete()` replays and completes non-terminal runs after restart.
Replay verifies the plan hash, event IDs, contiguous sequence, monotonic timestamps, safety marker,
and every deterministic transition. Conflicting idempotency keys and corrupt journals fail closed.
Persistence is bounded by a hard run cap and a 24-event per-run cap; reaching either cap returns an
error instead of deleting audit history.

`createPaperMultiLegRouter()` exposes bounded `POST /runs`, `GET /runs`, `GET /recovery`, and
`GET /runs/:runId` handlers. The trading router mounts it at
`/api/trade/paper-multi-leg` below authentication and `requireRole("paper-trade")`; session
mutations therefore also require CSRF. The process singleton uses
`backend/data/arbitrage-paper-multi-leg.sqlite` unless `PAPER_MULTI_LEG_DB_PATH` overrides it, and
recovers incomplete runs before serving the router.

The Trade workspace lazy-loads a strict internal client and EN/RU/KK browser panel for exact plan
JSON, recovery status, bounded run lists and append-only event details. This internal surface is
intentionally absent from the public arbitrage SDK. A one-click screener-to-plan handoff and any
live/private multi-order execution remain outside this module.
