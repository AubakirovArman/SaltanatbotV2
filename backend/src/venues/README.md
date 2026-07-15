# Public venue adapters

This folder contains transport-neutral, read-only venue integrations. It is intentionally separate
from `trading/exchange`: importing a public adapter must never create account authority or make a
private request.

## Layout

- `publicTypes.ts` — normalized adapter interface, snapshots and structured public errors.
- `publicRegistry.ts` / `publicRoutes.ts` — explicit adapter allowlist and bounded credential-free HTTP facade.
- `okx/` — isolated OKX REST implementation for metadata, top book, depth and funding.
- `gate/` — isolated Gate API v4 REST implementation for SPOT and USDT perpetual public data.
- `hyperliquid/` — isolated HyperCore `/info` implementation; executable quotes come only from L2 books.
- `deribit/` — allowlisted public JSON-RPC futures/options metadata, books and continuous funding history.
- `dydx/` — isolated public Indexer perpetual metadata/books/funding plus pure Indexer/full-node
  sequence and finality reducers; every book remains explicitly non-canonical research data.
- `conformance/` — versioned public-only plugin descriptor, compatibility gate, normalized snapshot
  invariants and deterministic fake-venue certification harness.
- `index.ts` — stable exports for backend consumers.

All network methods require a finite timeout, support caller cancellation, validate exchange
envelopes and fail closed when a snapshot cannot be trusted. Invalid rows may be quarantined only
when at least one valid row remains; a wholly invalid or empty source is an error.

The public HTTP facade shares identical in-flight reads and also consumes a named per-venue
process-wide resource budget. Both caps reject immediately with `503` plus `Retry-After`; neither
creates an unbounded queue. Consecutive upstream failures open a cooldown circuit with one
half-open recovery probe. `GET /api/market-data/health/upstreams` publishes only read-only counters,
latency and circuit state. Each client remains an independent subscriber, so one disconnect does
not cancel work still used by another client. Funding requests must explicitly use the `perpetual`
scope and a stable instrument ID with the same scope; the scope is retained in the response.

The instrument registry may consume adapters for metadata discovery. Scanner streaming and private
execution are separate integrations and must be enabled explicitly after their own conformance
tests.

When adding a venue, include recorded fixtures, happy/error conformance tests, a capability manifest
that advertises only implemented behavior, and a folder README describing native quantity units and
recovery guarantees.
