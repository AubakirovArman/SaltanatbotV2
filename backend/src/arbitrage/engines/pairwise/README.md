# Pairwise basis and carry research engine

This directory contains a transport-free, deterministic two-leg simulator exposed by the bounded
`POST /api/arbitrage/pairwise/evaluate` research endpoint. It is deliberately not connected to
private exchange APIs, order submission or an automatic scanner UI. Callers provide public metadata/books and explicit
capital, inventory, borrow, funding, convergence, rebalance and delivery assumptions.
The result is a research opportunity (`executable: false`), never a claim that
both orders can be filled atomically.

## Supported route shapes

| Strategy | Long leg | Short leg | Mandatory assumptions |
| --- | --- | --- | --- |
| `spot-spot` | buy spot from asks | sell spot into bids on another venue | verified quote capital, prefunded base inventory and rebalancing cost |
| `perpetual-perpetual` | buy/long perpetual from asks | sell/short perpetual into bids on another venue | convergence exit, both exit fees and one full-horizon funding assumption per leg |
| `reverse-cash-and-carry` | buy/long perpetual from asks | borrowed spot sold into bids | verified available borrow, annual borrow rate, convergence/exit fees and long-perpetual funding |
| `spot-dated-future` | buy spot from asks | sell dated future into bids | verified quote capital, convergence/exit fees and close-before-expiry model |
| `perpetual-future` | buy/long either leg from asks | sell/short the other into bids | convergence, perpetual funding and close-before-expiry model |
| `dated-futures-spread` | buy dated future from asks | sell the same-expiry future on another venue into bids | convergence, exit fees and explicit close-before-delivery model |
| `calendar-spread` | buy dated future from asks | sell dated future into bids | convergence plus explicit close-before-expiry or near-settlement/far-roll delivery model |

Reverse carry fails closed unless `borrow.kind === "borrow"`, positive base
availability is explicitly marked verified, and that availability covers the
whole holding horizon. A venue capability flag or a generic “margin enabled”
label is not borrow availability.

Funding inputs are aggregate rates for the declared horizon. Positive funding
means longs pay shorts. The engine subtracts it from a long leg and credits it
to a short leg. `scheduleVerified` confirms the schedule boundary, while
`rateKind` keeps venue estimates and manual stress assumptions visibly distinct.

## Quantity and depth model

Book sizes and venue filters use one native quantity unit:

- `base`: native quantity is base asset;
- `quote`: native quantity is quote value and base equivalent is value/price;
- `contract` + base multiplier: contracts represent a fixed base quantity;
- `contract` + quote multiplier identifies an inverse/quote-valued contract and
  is rejected until the caller supplies a separately designed, explicit
  point-in-time FX/collateral/settlement conversion model. The current route
  schema intentionally has no such assumption, so it never treats this exposure
  as linear quote PnL.

Both legs are independently floored to their native step, walked through the
correct side of visible depth, converted to base equivalent, and iteratively
re-paired. A route is rejected when the residual delta exceeds
`maxResidualDeltaBps`. Verified quote capital caps spot-buy size through bounded deterministic
search over the same walked ask depth. Output separates visible-depth/capital/inventory capacity
shortfall from actual step/contract dust. Minimum native quantity and quote
notional are checked after rounding.

## Economics

`grossEntryPnlQuote` is short bid proceeds minus long ask cost. Convergent
strategies subtract the explicitly assumed exit basis. Net expected PnL then
includes:

- entry taker fees from instrument metadata;
- explicit exit fees for convergent routes;
- annualized spot borrow over the exact horizon;
- long/short funding with the venue sign convention;
- calendar delivery/roll fees;
- cross-venue inventory-rebalancing cost.

`netReturnBps` is an edge on average matched quote notional, not return on
margin or capital. Collateral, liquidation, transfers, latency and atomicity
are not simulated and remain explicit risk flags.

## Fail-closed data boundary

Evaluation rejects missing or invalid metadata, incomplete books, unit
mismatches, empty/crossed/unsorted depth, sequence-less websocket snapshots,
stale/future timestamps, excessive inter-leg skew, stale assumptions, missing
capital/funding/borrow/delivery coverage, expiry inconsistencies, minimum violations,
insufficient depth, excessive base residual and non-profitable net results.
Both legs must share canonical base and quote assets, must share the settlement
asset, and settlement must equal the common quote asset. Cross-quote, inverse,
base-settled and quanto routes fail closed because the engine has no implicit FX
or settlement conversion.

Ticker equality is never economic-identity proof. Every instrument must carry a
lowercase canonical `economicAssetId` in `namespace:value` form plus a
caller-supplied review status, source, version, `asOf` and `validUntil`. Both IDs
must match exactly. The review is valid only through
`min(validUntil, asOf + maxEconomicIdentityAgeMs)` (30 days by default), with the
same future-clock boundary as other timestamped inputs. Missing, malformed,
unreviewed, future, stale, expired and mismatched identities fail closed. Output
preserves this policy and both leg reviews under provenance and adds
`caller-supplied-identity-review`; validation is not a server endorsement of the
external source.

Every opportunity includes deterministic long-then-short book provenance,
metadata IDs, assumption sources/timestamps, cost decomposition, timestamp
quality, capacity, dust and ordered risk flags. Ranking is deterministic by net
edge, expected quote PnL, executable base size and ID.

## Minimal use

```ts
const engine = new PairwiseArbitrageEngine(instruments, routes, {
  maxQuoteAgeMs: 1_500,
  maxLegSkewMs: 200,
  maxAssumptionAgeMs: 60_000,
  maxEconomicIdentityAgeMs: 86_400_000,
  minNetReturnBps: 5
});

engine.updateBook(longBook);
const delta = engine.updateBook(shortBook);
const rankedResearchOnly = engine.opportunities();
```

Adapters must normalize metadata and public depth before calling the engine.
This module must not fetch credentials, balances, borrow state or submit trades.
