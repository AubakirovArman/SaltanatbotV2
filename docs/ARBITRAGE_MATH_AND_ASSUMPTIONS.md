# Arbitrage math and assumptions

Status: canonical calculation reference, reviewed 2026-07-14.

The basis scanner discovers one projected cash-and-carry entry: buy spot at its ask and short a
linear perpetual at its bid on the same or another supported venue. Separate triangular,
venue-native spread and caller-supplied pairwise research engines are documented in the taxonomy.
None claims atomic execution, convergence or profit.

## Canonical economic identity

Two equal display tickers do not prove that two instruments represent the same economic asset.
Pairwise research requires both legs to carry the exact same lowercase `namespace:value`
`economicAssetId` and independent caller-supplied review metadata (`reviewed`, source, version,
`asOf`, `validUntil`). At evaluation time each review must be non-future, unexpired and younger than
the configured maximum age and within the declared future-clock tolerance. Its deterministic effective boundary is:

```text
effectiveValidUntil = min(validUntil, asOf + maxEconomicIdentityAgeMs)
```

The response preserves both reviews, the boundary policy and the `caller-supplied` authority. This
prevents same-ticker collisions but does not turn caller provenance into a server guarantee.

## Prices and basis

For spot ask `S_a`, perpetual bid `P_b` and 10,000 basis points per unit:

```text
entryBasisBps = (P_b - S_a) / S_a * 10,000
topBookMatchedQuantity = min(spotAskSize, perpetualBidSize)
topBookCapacityUsd = topBookMatchedQuantity * S_a
```

Capacity is the spot-capital/reference notional for the exact matched base quantity, not the
smaller of two independently valued notionals. The derivative leg keeps its own entry price for PnL
and margin analysis.

The displayed gross basis is an entry observation. For a matched base quantity `q`, a later spot bid
`S_x` and perpetual ask `P_x`, mark-to-close PnL before funding/costs is:

```text
markPnlUsd = q * (S_x - S_entry) + q * (P_entry - P_x)
```

If exit basis remains wide, the entry basis is not realized. Scenario analysis should therefore show
100%, 75%, 50%, 25% and 0% convergence rather than treating the initial basis as a receivable.

## Matched quantity

Both legs must share one executable base quantity. The current depth analyzer uses the spot USD
budget to derive a target quantity, reduces it to visible perpetual liquidity and floors it to a
common venue quantity step:

```text
targetQuantity = spot quantity purchasable within requested USD budget
rawMatched = min(targetQuantity, visible perpetual bid quantity)
matchedQuantity = floor(rawMatched / commonStep) * commonStep
residualDelta = executedSpotQuantity - executedPerpetualQuantity
```

Paper entry fails closed unless both executed quantities match `matchedQuantity` within numerical
tolerance. The public endpoint requires current verified metadata for both exact instruments before
fetching either book, including lot steps and venue minimums; missing or unverified metadata fails
closed. A successful analysis therefore reports `quantityStepSource: "instrument"` and
`precisionVerified: true`. Private execution still needs an independent preflight for contract
multiplier, linear/inverse conversion, minimum quantity/notional and settlement asset.

## Depth and slippage

For requested quantity `q`, each leg walks prices in executable order. VWAP is:

```text
VWAP = sum(levelPrice * filledQuantityAtLevel) / sum(filledQuantityAtLevel)
```

Buy slippage is measured above the top ask; sell slippage is measured below the top bid. An analysis
is complete only when both legs fill the matched quantity. Visible depth can disappear before an
order reaches the venue and is not a fill guarantee.

## Cost model

The browser research model separates:

```text
entry taker fees
+ exit taker fees
+ round-trip slippage reserve
+ borrow/financing over the selected holding horizon
+ expected funding cash flows
+ inventory rebalance/transfer cost where applicable
```

For requested capital `C` and total cost `costBps`:

```text
estimatedCostUsd = C * costBps / 10,000
displayedNetEdgeBps = entryBasisBps - estimatedNonFundingCostBps + projectedFundingBps
```

The fee profile is a user-maintained estimate, not account telemetry. It does not currently know VIP
tier, maker rebates, borrow availability, asset-specific APR, withdrawal network status, margin
interest or partial fills. Transfer cost should be a rebalance assumption for prefunded cross-venue
inventory, not silently charged as an instantaneous entry leg.

## Funding

Funding is a discrete cash flow at venue-defined settlement times:

```text
fundingCashFlow = positionNotionalAtSettlement * signedFundingRate
```

The UI projection and server-alert forecast count discrete settlements between `now` and the
selected holding horizon using `nextFundingTime` and a registry-verified contract interval. An
unverified positive schedule receives no speculative funding credit. To avoid deleting a liability,
an unverified negative current rate is charged for at least one settlement whenever the holding
horizon is non-zero, even if `nextFundingTime` is absent. The browser paper ledger never turns a
forecast into cash: it accepts only an explicit manually confirmed settlement event. Deterministic
replay consumes recorded funding arrival/settlement events and never rewrites them from the latest
rate. Implemented boundaries are:

- sign convention for long/short and settlement asset;
- actual append-only paper ledger funding events instead of silently rewriting past PnL.

Account-grade forecasting must still present historical realized rate, current venue estimate and
future forecast confidence as separate values; the latest published rate is not necessarily the next
final rate.

## Capital, margin and liquidation

Expected return must specify a denominator. The current basis analysis exposes:

```text
requiredCapital = spot purchase + derivative initial margin + safety buffer + rebalance inventory
ROI = expectedNetPnl / requiredCapital
```

Cross-venue positions cannot net margin across venues. Maintenance margin, mark price, leverage,
collateral haircut and liquidation fee remain route-specific. A high basis with insufficient margin
buffer ranks below a smaller executable route.

## Ranking

Percentage spread alone rewards tiny, illiquid books. The target primary score is based on expected
executable dollars and capital efficiency, adjusted by data confidence:

```text
expectedNetPnlUsd = executableNotional * expectedNetEdgeBps / 10,000
capitalEfficiency = expectedNetPnlUsd / requiredCapital
qualityAdjustedScore = capitalEfficiency * dataQualityConfidence
```

The current REST scanner applies minimum spread/capacity before its limit, defaults to expected
executable dollars and returns total/truncated metadata. The browser stream ranks its complete fresh
route set the same way. The UI supports explicit ranking by projected net dollars, ROI, edge,
capacity and data quality. Duration remains an input to funding/financing scenarios rather than an
independent route property for the current cash-and-carry universe.

## Reproducibility

Every computed result should bind:

- normalized instrument and adapter versions;
- source timestamps/sequence IDs;
- requested and matched quantity;
- all book levels used;
- cost profile/version and funding horizon;
- rounding and residual delta;
- result class and quality gates.

See [Taxonomy](ARBITRAGE_TAXONOMY.md) and [Market-data quality](MARKET_DATA_QUALITY.md).
