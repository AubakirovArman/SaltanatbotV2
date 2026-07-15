# Deterministic arbitrage replay

This module validates immutable historical event datasets and replays them without
wall-clock or network access. Events are ordered by `receivedAt` (the logical
arrival/availability time), never by exchange time. `exchangeTs` remains
provenance and freshness data, and a future exchange timestamp relative to
arrival is rejected. This prevents a late packet with an older exchange timestamp
from being moved backwards into the strategy's information set.

A schema-v4 manifest binds the exact ordered event digest, the sorted canonical
`economicAssetIds` and every point-in-time execution-constraint epoch, source-file digests, adapter
versions, registry snapshot ID **and digest**, cost-model version and
survivorship policy. The manifest carries a canonical
`instrumentConstraintEpochs` row for every listing and
`instrument-constraints-updated` event. Each instrument starts at
`constraintVersion: 1`; updates must advance by exactly one and atomically carry
positive `quantityStep`, `minimumQuantity` and `minimumNotional`. This records a
venue rule change without inventing a delist/relist or changing economic identity.
Both identity lists are derived from immutable events and are rejected if forged,
unsorted or inconsistent. Point-in-time datasets require listing before market data and
reject data after delisting. The basis simulator additionally removes cached depth
on delisting and requires both route identities to have listing events. Every
listing carries an immutable canonical `namespace:value` economic asset identity,
venue/symbol, base, quote, settlement, market type and
quantity-conversion metadata; that payload is covered by the event digest and an
identity digest and explicit economic asset ID are copied into each trade.
Same-ticker legs with different economic identities, mixed base/quote identities,
non-quote settlement and stale listing epochs fail closed.

`runHistoricalBasisBacktest` is a conservative two-leg research simulator. It requires
ordered `depth-snapshot` events and walks spot asks/derivative bids at entry and
spot bids/derivative asks at exit. Quantity is matched after both venue steps and
the requested quote budget; trade prices are deterministic VWAPs with the number
of levels used. Both entry legs and both exit legs must meet the quantity step,
minimum quantity and `minimumNotional` of the constraint version available at that
event; an incompatible order is rejected rather than treated as executable. A top-book-only dataset is rejected instead of being described as
depth simulation. The simulator also uses explicit fees and freshness/skew gates.
Verified discrete funding is ordered and made eligible by its actual settlement
`exchangeTs` on the half-open actual holding interval `[openedAt, closedAt)`.
The close is processed before a possible reopen on the same depth event, so a
settlement exactly at that boundary belongs to the new position once, never both.
If liquidity delays the exit past its target horizon, verified settlements up to
the actual close are included. `receivedAt` remains immutable
arrival provenance and event ordering, but a delayed funding record does not move
the settlement or mutate an already-emitted trade: the complete settlement
timeline is indexed before deterministic trade accounting. Each credited
settlement records its source, sequence, arrival time and event digest. The
configured slippage reserve is stored as `slippageReserveUsd`
and deducted from net PnL; it cannot silently exist only in the entry filter. It never invents an
exit: positions without fresh two-sided capacity at/after the horizon remain open
and are reported as unresolved.

## Point-in-time replay for the other research engines

`createEngineReplayManifest` and the replay adapters extend immutable evidence to
triangular, pairwise route families, Bybit venue-native spreads, options parity and
bounded 4–8-leg cycles. This is a deterministic **point-in-time evaluation**, not a
claim that the repository ships a historical data lake or a multi-period PnL
backtest for those engines.

The engine manifest binds the schema-v4 dataset/event digest, registry snapshot ID
and digest, cost-model version, exact engine/version, canonical engine-input digest,
evaluation time and every selected depth event. Each evidence row carries event
index, instrument, source, positive sequence, exchange/receive timestamps and its
own content digest. The published result is always `readOnly: true`,
`executable: false` and carries manifest/input/evidence/output digests.

Replay fails closed when evidence is missing or duplicated, belongs to an inactive
instrument, arrived after `evaluatedAt`, is not the latest depth that was available
at that logical time, no longer matches the dataset, or when the dataset itself is
late-reordered, duplicated, regressing or digest-mutated. Point-in-time quantity
step, minimum quantity and (where the engine uses it) minimum notional must match
the active registry constraint epoch. Venue/symbol/market/economic identity fields
are also checked when the engine input declares them. Engine inputs are canonical
JSON, capped at 2 MiB, reject credential-shaped fields, use at most 64 evidence
books and at most 1,000 levels per side.

Runtime-callable adapters and their current scope:

- `replayTriangularEvaluation`: sequence-verified three-leg visible-depth cycles,
  capped at 64 markets and 1,024 generated cycles;
- `replayPairwiseEvaluation`: up to 256 spot-spot, perpetual-perpetual, reverse
  carry, spot/future, perpetual/future, calendar or same-expiry future routes;
- `replayNLegEvaluation`: one exact conserved-quantity 4–8-leg cycle with the
  engine's native depth/traversal bounds;
- `replayOptionsParityEvaluation`: primary/optional secondary European option
  series plus underlying, with immutable rate/FX/fee/borrow/settlement assumptions;
- `replayNativeSpreadEvaluation`: a signed-price Bybit native spread book with
  venue and matching-engine timestamp provenance, retained as historical and
  non-executable.

Deterministic fixtures prove replay semantics only. Durable capture/object storage,
dataset catalog/retention, live historical ingestion, CEX–DEX replay, replay UI and
multi-period lifecycle/PnL simulation outside the basis engine remain separate
work.

Generic reducer replay still accepts current-universe datasets only as exploratory
inputs and labels them `verifiedPointInTime: false`. Historical basis backtests
reject them because executable identity/depth claims require a point-in-time universe.

Reducer replay clones the initial state and immutable event dataset once, then owns
the working state for the duration of the synchronous replay. It does not clone a
growing state before and after every event. Public snapshots and final state are
canonical independent clones with matching digests. Snapshot output has absolute
ceilings of 1,000 snapshots, 32 MiB serialized data and 1,000,000 aggregate state
entries. Caller options can only lower those ceilings. This prevents a permissive
`maxSnapshots` value or growing reducer state from recreating quadratic/unbounded
output work. Historical basis exits use a due-time min-heap plus per-instrument
retry index: each depth event examines only newly due positions and failed exits
whose route consumes the changed book, not the full route universe.

Schemas v1, v2 and v3 remain readable only for generic reducer migration. V1 did not
declare canonical economic identities, its result is always
`identityVerified: false`, `verifiedPointInTime: false` and carries an explicit
identity-unverified warning even when its old survivorship policy says
`point-in-time`. V2 declared economic identities but not point-in-time minimum
notionals, so it is also exploratory with `verifiedPointInTime: false`. V3 bound
listing-time minimum notionals but could not represent an in-place versioned
constraint change, so it is also exploratory. Historical basis backtests reject
all three legacy schemas; new manifests are emitted only as v4.
