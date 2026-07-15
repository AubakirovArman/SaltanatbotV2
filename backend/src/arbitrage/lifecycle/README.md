# Opportunity lifecycle

This folder contains a pure, scanner-agnostic reducer for the lifecycle of research opportunities.
It accepts a prior JSON-compatible state, an explicitly timestamped universe snapshot and a policy,
then returns a new state plus deterministic events. It has no clock reads, database access,
notifications, exchange credentials or trading callbacks.

## Adapter boundary

Basis, triangular, native-spread and pairwise scanners map their rows to the same small candidate:

- `universeId` identifies the feed whose presence/absence is comparable. Never mix a partial symbol
  page with a venue-wide universe under the same ID.
- `policyId` is the caller's explicit immutable policy version. Its resolved values are hashed in
  state; reusing the ID with different thresholds, freshness or confirmation rules fails closed. A
  deliberate policy revision uses a new ID and is recorded as a deterministic universe event.
- `routeId` is the stable economic route identity; `observationId` identifies one immutable set of
  market observations. Retried delivery must reuse the observation ID and does not count as another
  confirmation.
- `score` is caller-defined, normally estimated net basis points. The policy's higher entry and lower
  exit thresholds provide hysteresis.
- every independently timestamped leg is evidence. Route quality is the weakest leg, evidence is
  complete only when every supplied leg is complete and the configured minimum source count is met.
- `coverage.complete` must be false for stale, truncated or failed-source scans. The reducer also
  derives incomplete coverage when those flags disagree, the candidate bound is exceeded or duplicate
  route rows conflict.

## State machine

`first-seen → confirmed → decaying → expired`

A route becomes confirmed only after the configured number of distinct, monotonic, fresh observations
and optional minimum duration. A confirmed route stays confirmed between the entry and exit thresholds.
Falling below exit, complete-universe absence, incomplete evidence or stale evidence starts decay. A
recovery above entry begins a new confirmation cycle. Decay expires at the exact deterministic grace
boundary; expired tombstones and event history are bounded.

An incomplete universe never proves route absence and never advances confirmation. Previously confirmed
state may be retained while its evidence is still fresh, but every route returned for that universe has
`actionable: false`. Evidence still ages and can decay/expire. This prevents a partial scan from causing
false expiry/re-entry events without treating an old route as currently eligible.

## Safety boundary

`actionable` means only that the lifecycle policy is satisfied on a complete snapshot. It is **not** an
order permission or a claim of economic executability. Fees, inventory, capital, depth, sequence,
identity, account risk and private execution gates remain the owning engine's responsibility. This
module deliberately cannot send alerts or submit orders; downstream consumers decide how to use its
event stream.

State is schema-versioned and JSON-compatible. A caller that needs persistence can atomically store the
returned state, but no persistence implementation is coupled here. Snapshot IDs are idempotent; reuse
with different content or policy, oversized input and non-monotonic universe time are rejected instead
of silently rewriting history.

## Runtime coordinator

`OpportunityLifecycleCoordinator` is the bounded in-memory owner used by the backend runtime. Every
reduction is transactional: the reducer receives a defensive state copy and the coordinator replaces
its state only after a successful evaluation. Adapter or reducer failures increment sanitized runtime
diagnostics without retaining the rejected payload. Routes, recent observation IDs and history remain
bounded by the immutable lifecycle policy.

The coordinator's `read()` method and `createOpportunityLifecycleHandler()` expose defensive copies
only. The intended public registration is `GET /api/arbitrage/lifecycle`; there is deliberately no POST,
PUT or DELETE lifecycle endpoint. The response repeats `readOnly: true` and
`executionPermission: false`, supports exact universe/route/kind/status/actionable filters, an event
sequence cursor, and route/event caps of 500 rows. Events are returned newest first. Lifecycle
`actionable` still means policy-confirmed research evidence only; it does not authorize alerts, paper
orders or live orders.

`attachBasisOpportunityLifecycle()` subscribes to the internal, unpaginated basis stream before reading
its current value, closing the bootstrap race. Snapshot retry is idempotent and a rejected lifecycle
snapshot never stops the market-data stream. The adapter uses process-local `receivedAt` for ordering
and freshness across venues. Raw Binance and Bybit exchange timestamps remain provenance; verified
evidence quality is emitted only when the scanner also supplies a valid `venue-clock-v1` correction.

## Scanner adapters and complete-universe rules

- Basis requires one healthy status for Binance spot/perpetual and Bybit spot/perpetual, a fresh and
  explicitly complete instrument-identity registry proof, a non-stale scan, and no truncation or
  invalid candidate. The production scanner derives that proof from five required registry sources;
  older/custom producers without it fail closed as `identity-registry:coverage-unproven`. This prevents
  a registry outage from looking like valid cross-venue route absence. Observation identity changes
  only when a leg's actual price/quantity/receipt evidence changes; a periodic age refresh cannot create
  a fake confirmation.
- The current public triangular REST scan is always incomplete for lifecycle absence semantics. It
  exposes top-book, unsequenced research candidates but cannot prove that every graph market had a
  continuous book, so those candidates are `unverified` and non-actionable under the production policy.
- Bybit native-spread coverage is complete only when every eligible instrument was scanned, every book
  was healthy, no source error occurred and neither candidate selection nor output was truncated. A
  snapshot sequence is `fresh`, not sequence-continuity `verified`.
- Route-family/pairwise coverage is complete only when discovery is untruncated, every candidate was
  evaluated, instrument metadata was accepted and no missing/stale/invalid evidence or assumption
  rejection occurred. Non-profit, capacity and minimum-size rejections are valid evaluated absence;
  missing books/assumptions are not.

All adapters hash canonical observation evidence into deterministic IDs. They map scores into the
reducer's "higher is better" convention; native spread uses negative relative book width as a tightness
proxy and must use a family-specific policy rather than a profitability threshold.
