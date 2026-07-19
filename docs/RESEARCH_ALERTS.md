# Account-aware research arbitrage alerts

Status: policy/outbox runtime is mounted behind the authenticated `paper-trade` boundary and starts
and stops with the server. A protected EN/RU/KK operator workspace manages bounded policies and
delivery/retry evidence for `paper-trade`, `live-trade` and `admin` sessions. Engine-owned
candidate/economics producers are not yet connected, so the mount and UI alone cannot create a
notification.

Production now runs the accepted and deployed R5.1 release on PostgreSQL
schema 13 from protected slot r5a-schema13-66394fd
([evidence](./evidence/R5_1_OWNER_ALERTS.md)). This disconnected producer
workflow is still not claimed as accepted or deployed.

## Distinction from generic R5.1 price alerts

This document describes the older account-aware arbitrage policy/economics
workflow. It is not the generic owner-scoped R5.1 alert control plane and its
policy state must not be merged into a generic price rule merely because both
systems use notification/outbox terminology.

The current generic control plane supports only `price-threshold` over public Binance/Bybit or
first-DEX perpetual Hyperliquid last-price closed candles with in-app delivery. It never reads
account evidence or exchange credentials and cannot trade. Its beta bounds are
100 active and 200 non-archived rules per owner, 400 total retained
rule/history rows per owner and 480 globally active rules. Scheduler admission
is four concurrent public reads, 16 unique reads per sweep and eight per
provider. Evaluation receipts retain for 2 days and event/outbox/archive
history for 30 days.

R5.1 uses an owner-bound forward event cursor and intentional at-least-once
publish-before-checkpoint behavior. Its release gate — browser-closed
restart/dedup, same-owner multi-tab convergence, local-storage failure and
desktop/mobile accessibility/visual evidence — passed before the production
cutover. R5.2 technical screener integration, R5.3 notification
worker/Telegram delivery and R11 integrated 100-user proof remain pending and
unproven.

See [Owner-scoped server alerts](./ALERTS.md),
[Russian](./ru/ALERTS.md) and [Kazakh](./kk/ALERTS.md).

## Safety contract

The generic alert evaluator is notification-only. Every evaluation, intent and protected HTTP
response fixes `researchOnly: true` and `executionPermission: false`. The module imports neither
exchange credentials nor order adapters, and a passed policy never changes a research candidate's
execution status.

The boundary can normalize these families: basis; the six pairwise families; triangular;
native-spread; options parity; N-leg; and a future CEX-DEX family. Family support in the schema does
not claim that every scanner already publishes a runtime lifecycle feed. In particular, an adapter
must supply current lifecycle and economics evidence before that family can trigger.

## Required evidence

An eligible notification requires all gates below:

1. `economicAssetId` is canonical and carries a current reviewed source/version/validity interval.
2. Ordered economic identity legs exactly equal the economics request's venue, instrument, market
   type and side. Display tickers cannot substitute for this identity.
3. Lifecycle is an exact route match in `confirmed` state, complete, within the observation-age
   policy and at least `fresh` or `verified` as configured.
4. The backend recomputes `route-economics-v1`. Missing or stale fee, funding, borrow, transfer,
   margin, capital, stable-asset or FX evidence fails closed.
5. Every capital requirement has a conservative valuation rate and no shortfall. Policy limits are
   then applied to risk capital, account-constrained capacity, conservative net profit and net edge.

Gross route profit and account-constrained capacity remain route-engine values and therefore share
explicit versioned route evidence.
Conservative net profit subtracts `costs.totalConservative`; edge uses the conservatively valued
required capital, never a caller-selected denominator.

## Cross-family deduplication and durability

`researchAlertDedupKey()` hashes canonical `economicAssetId` plus the sorted exact directed leg set.
It deliberately excludes family labels and display symbols, so the same economic route mislabeled
or discovered by two engines produces one winner. It retains venue, instrument, market type and
side, so economically different routes do not collapse.

The reducer seeds the first snapshot without startup noise, emits only an ineligible-to-eligible
crossing, applies per-policy/per-economic-route cooldown, treats absence only from a complete
universe as evidence, detects snapshot-ID equivocation and retains bounded idempotency history.
The separate persistent outbox provides `queued`, `sending`, `retrying`, `delivered`, `failed` and
`cancelled` states, bounded leases, exponential retry and restart recovery. It is structurally
compatible with the current basis alert operator workflow but uses its own state key.

## Integration work still required

- Build server-owned adapters from basis, continuous pairwise, triangular, native-spread,
  options-parity and N-leg engines. Browser-submitted account evidence must not become the trusted
  production source; the protected router deliberately exposes no snapshot-ingest endpoint.
- Connect protected account telemetry to point-in-time `RouteEconomicsRequest` builders and retain
  provenance/history.
- Retain the protected policy/delivery workflow as an internal session surface; no public SDK is
  required for account-aware data.

No funded mainnet/testnet soak or live-order readiness is claimed.
The missing producer integrations above remain separate from R5.2/R5.3 and
cannot inherit acceptance from the accepted generic R5.1 release.
