# Route economics

This folder owns the pure `route-economics-v1` feasibility and cost boundary shared by arbitrage
families. It performs no I/O, receives no credentials and cannot place orders.

Every fee tier, FX rate, funding event, borrow facility, transfer-network state, margin rule,
capital balance and settlement claim carries versioned evidence with an explicit validity window.
Stale, future-dated or horizon-incomplete evidence fails closed. A non-quote fee asset requires the
venue-derived fee quantity; it is never inferred from a ticker conversion. Conditional maker
rebates are excluded from the conservative result.

Future estimated funding can increase projected PnL, but the conservative result credits only
already-settled funding and always retains adverse estimated debits. Borrow availability must cover
the requested size and full horizon. Recall risk is disclosed and may be configured as a rejection.
Transfer checks bind the exact asset and network, require both deposit and withdrawal availability,
price the fee through a verified FX rate and enforce a maximum arrival time.

Capital is checked per venue and asset after reservations and haircuts. Spot buys require quote
capital, uncovered spot sells require base inventory and derivative legs require explicit initial
margin plus safety buffer. This is a research feasibility proof for the supplied snapshot, not an
account reservation or an execution authorization.

Outcome labels are deliberately conservative:

- `locked` requires fixed settlement, venue-atomic execution, settled funding, no transfer and no
  recallable borrow;
- `projected` covers convergence/funding/legging-dependent routes;
- `statistical` is reserved for explicitly statistical settlement claims.

No positive result is a profit guarantee. Market data and account evidence must be revalidated at
the actual order boundary.

## Portfolio allocation

`allocateCapital` consumes already-evaluated route candidates. It performs a bounded,
deterministic discrete search across venue/asset balances, route minimums, family risk-capital
limits, outcome-class policy and a maximum number of open routes. It never places or reserves an
order.

If the hard node budget is reached, the result is marked `truncated`, `optimal` remains false and a
valid (possibly loose) profit upper bound is returned. A bounded incumbent is therefore never
mislabelled as the optimum.
