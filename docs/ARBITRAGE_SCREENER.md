# Arbitrage research workspace

The **Screener** workspace is read-only and requires no exchange keys. Its basis mode monitors common
USDT markets on Binance and Bybit and builds four cash-and-carry discovery routes per common symbol:

1. Binance spot → Binance USD-M perpetual;
2. Binance spot → Bybit linear perpetual;
3. Bybit spot → Binance USD-M perpetual;
4. Bybit spot → Bybit linear perpetual.

The mode selector exposes 7 source-backed modes: **Spot ↔ perpetual** (`basis`), **Triangular**
(`triangular`), **Bybit native spreads** (`native`), **Options parity** (`options`), **Funding stress**
(`funding`), **Live routes** (`continuous`) and **Order-book ML** (`ml`). The exact list is
mechanically checked against the UI by the
[machine-readable capability truth register](CAPABILITY_TRUTHS.json).

The same workspace also provides directional single-venue triangular-cycle simulation from
venue-wide REST top-book snapshots and Bybit venue-native spread books. Its live-routes mode
observes the operator-allowlisted continuous public registry with public source health and
venue/family filters. It is deliberately separate from the automatic
Binance/Bybit basis feed: compatible routes have no account-capital, borrow, transfer or execution
claim. An **Options parity** mode provides a caller-supplied European call/put/underlying scenario
lab for put-call parity, conversion, reversal and synthetic-forward research. All scenario capacity,
margin, borrow, rates, fees and settlement values are explicit assumptions, not live account
evidence. The transport-safe TypeScript client lives in `packages/arbitrage-sdk`.

The basis, triangular and native-spread browser modes share a local research workspace with
user-selected table columns, a compact heatmap and an ordered route graph plus current-candidate
comparison. Options, funding and continuous modes use dedicated purpose-specific panels and do not
yet share these presets or visualizations. Up to twelve named presets in the shared workspace
store bounded filters and presentation settings in a versioned local schema; version-1 data is
migrated and malformed or oversized values fail back to safe defaults. Presets contain no API keys
and do not enable execution. Heatmaps retain exact values and rank labels instead of relying on
color alone, while route graphs have text and semantic-table alternatives. High-frequency visual
rows stop updating when the tab is hidden. Basis mode also shows the read-only lifecycle aggregate;
it remains `executionPermission: false` and is not an order control.

On mobile, basis results default to compact cards so the useful columns and row actions remain
readable without forcing the whole page wider than the viewport. The explicit **Full table** switch
keeps the complete semantic table available inside its own horizontal scroll region; switching
back to **Cards** unmounts the table rather than leaving two hidden result trees.

The collapsible **Fork types** guide beside the mode selector maps informal trader wording to the
actual engine shapes: double means a two-leg pairwise route, triple means a three-leg triangular
conversion, intra-exchange describes the venue location rather than a separate strategy, and
multi-leg refers to the bounded four-to-eight-leg research engine. Every row repeats the relevant
depth, fee, non-atomic execution, capital and recovery risks. The canonical terminology and wider
current/planned matrix are in [Arbitrage taxonomy](ARBITRAGE_TAXONOMY.md).

Triangular REST rows are research candidates, not execution signals. The response is explicitly
`rest-top-book` / `rest-snapshot`, `sequenceVerified: false` and
`executionStatus: non-executable-candidate`; every row repeats that classification and risk flags.
The sequence-verified depth engine is exposed as an explicit second-stage action on each route. It
opens three bounded on-demand L2 streams, bridges snapshots and deltas, verifies the current
connection generation, and repeats depth, fee, lot/minimum, freshness and skew simulation. The UI
shows sequence/generation evidence and explains when a top-book candidate disappears. Even a passed
route remains `readOnly`, `researchOnly`, `executable: false`: three sequential orders are not
atomic and no credentials, balances or private orders enter this verification path.

The table shows gross basis, a route-specific fee deduction, net edge, the maximum notional
visible at both best prices and the perpetual funding rate. Only instruments with executable,
positive bid/ask prices and sizes are accepted. Delivery futures are excluded by normalized
registry market type and expiry metadata; both legs must also pass exact native/economic identity
rules. A perpetual with an unknown funding schedule can remain a discovery row, but receives zero
projected funding credit rather than a synthesized schedule.
Cross-venue matching also requires a reviewed economic-asset mapping. The initial production
allowlist contains BTC and ETH; other equal ticker strings are suppressed until their identity,
redenomination and settlement semantics are reviewed. Same-venue routes are not limited by that
cross-venue allowlist: they require both instruments to share one strict venue-native registry
identity and compatible quote, settlement, direction, multiplier and quantity semantics.
Rows with an absolute basis above 20% fail closed because they are more likely to be same-ticker
asset collisions, redenominations or stale markets than an executable opportunity.
Rows are discovery candidates, not execution claims. A row without both venue timestamps remains
visible as `unverified`, ranks below `fresh`, never fires an alert and cannot pass the paper gate.

## Automation research handoff

Supported basis, triangular, Bybit native-spread and compatible continuous-market rows expose an
action that opens the result in **Automation**. The action first normalizes the source into the
strict `market-opportunity-v1` contract. That common envelope carries the route family, ordered
legs, declared economics/cost coverage, visible capacity, timestamp/sequence evidence and explicit
paper/live blockers; it does not add evidence the source engine did not have.

The browser stores at most one strictly re-parsed handoff in `sessionStorage`, with a 48 KiB bound
and a default 15-minute expiry (never above one hour). Invalid, oversized, future-dated or expired
records are removed. Automation consumes the record and renders a research card; the card is an
inspection surface, not an execution form. `market-opportunity-v1` always has `live: blocked`, and
the existing basis, REST triangular, native-spread and continuous adapters do not promote their
rows to paper plans.

The SDK permits `paperPlan: ready` only for a separately verified `n-leg-v1` opportunity with
sequence and exchange-time evidence and concrete leg sides. Even then the handoff is not the exact,
short-lived `paper-multi-leg-plan-v1` accepted by the protected paper journal. The operator must
still obtain and review that plan; clicking the Screener handoff alone cannot place a paper or live
order.

## Calculation

```text
gross spread (bp) = (perpetual bid - spot ask) / spot ask × 10,000
net edge (bp)     = gross spread - estimated total costs
matched base qty  = min(spot ask size, perpetual bid size)
top-book capacity = matched base qty × spot ask
```

The browser fee profile stores separate Binance/Bybit spot/perpetual taker rates, a round-trip
slippage reserve, expected holding time, annual financing/borrow rate and a fixed transfer cost.
Entry and exit are included automatically. The current perpetual funding rate is applied only to
discrete settlements crossed by the configured horizon when `nextFundingTime` and a registry-derived
contract interval are verified. An unverified positive rate receives no speculative credit; an
unverified negative rate is charged for at least one settlement whenever holding time is non-zero,
even when `nextFundingTime` is absent. Verified positive funding is credited to the short leg and
negative funding is treated as a cost. The future rate and
actual borrow rate remain unknown.

## Data and failure behavior

`GET /api/arbitrage` bootstraps public Binance book tickers/premium index and Bybit V5 spot/linear
tickers concurrently. The server then owns one direct public WebSocket per exchange/market and
subscribes only to common symbols. Binance Spot REST `bookTicker` has no venue timestamp, so its
bootstrap rows remain explicitly `unverified`; the shared Spot `ticker` stream supplies event time
and current bid/ask fields and can promote them to `fresh`. Binance Futures continues to use
`bookTicker`; Bybit uses V5 ticker updates. The server
sends the Bybit application heartbeat, becomes healthy only after a valid market-data event,
terminates silent feeds, reconnects with jittered exponential backoff and coalesces rapid
ticks before `/arbitrage-stream` broadcasts them to browsers. REST refreshes every 30 seconds as a
discovery/failure boundary rather than the former two-second polling loop. The browser connection
pauses in a hidden tab. Routes retain independent venue/receive timestamps and fail closed outside
the current age/skew limits. Each leg explicitly says whether its exchange timestamp came from the
venue. A missing venue timestamp stays absent and makes the route unverified. Quote age is the worst
venue/receive age and cross-leg skew is the worst venue/receive skew; local time is never used as a
synthesized venue clock. REST applies spread/capacity filters before its limit, ranks expected
executable dollars by default and discloses total/truncated counts. Individual source failures
are visible; if a complete refresh temporarily fails, a successful snapshot may be served for at
most 30 seconds and is clearly marked stale.

The basis screen also polls `GET /api/arbitrage/clock-health` every 30 seconds while the tab is
visible. Binance, Bybit, OKX, Deribit, Kraken, Coinbase, Gate, KuCoin and MEXC are shown
independently from their official public server-time endpoints, with calibrated/degraded/expired/unavailable
state, measured RTT and the conservative offset uncertainty. Hidden tabs stop this polling. The
diagnostic uses bounded public server-time probes and never substitutes local time for venue time.
The one-second Kraken and Coinbase timestamps can remain degraded under a tighter uncertainty
policy; Hyperliquid and dYdX receive no invented clock. Basis REST ranking, stream refreshes, server
alerts, continuous cross-venue market economics and Funding Curve comparison use conservative
corrected age/skew intervals. Missing, expired, degraded or incompatible calibration fails closed;
this improves timing correctness but every opportunity remains explicitly research-only.

The server also maintains a bounded lifecycle (`first-seen`, `confirmed`, `decaying`, `expired`).
Confirmation requires distinct observations and complete market plus instrument-identity coverage;
`GET /api/arbitrage/lifecycle` is read-only and always returns `executionPermission: false`.

## Depth, alerts and paper positions

`POST /api/arbitrage/triangular/verify-depth` is the selected-route equivalent for a three-leg
triangle. It requires the exact three symbols from discovery and returns either a current
sequence-verified simulation or explicit rejection evidence. A gap, reconnect or generation change
withdraws the result instead of retaining an optimistic candidate.

`GET /api/arbitrage/depth` requests bounded public levels from both selected books only when the
operator requests an analysis. Its primary path reconstructs Binance/Bybit L2 on demand and derives one base-asset quantity from the selected spot USD budget,
reduces it to visible perpetual liquidity, floors both legs to a common quantity step and reports
precision status, original per-book timestamps/age/skew, rounding dust, residual delta, filled
notional, VWAP, worst price, levels used and directional slippage. A result can be `complete` only
when both books provide venue timestamps, both snapshot/delta sequences are verified and timing is
fresh; otherwise quality is `unverified`. Binance Spot buffers diff-depth before bridging a REST
snapshot at `lastUpdateId + 1`; USD-M then chains `pu`, while Bybit Spot/Linear reset from the V5
WebSocket snapshot and apply contiguous `u` deltas. Any gap/reconnect withdraws the previous book.
An unavailable live reconstruction falls back to an explicitly `rest-snapshot`,
`sequenceVerified: false` research result, which cannot open or close a paper position.
Paper entry fails closed when either leg is incomplete or the executed
quantities are not matched. Before either book is fetched, the public endpoint requires current
registry records for both exact venue instruments, verified lot steps and venue minimums; missing or
unverified metadata fails closed. `quantityStepSource` remains provenance in the response contract,
but a successful public analysis is `instrument`-sourced with `precisionVerified: true`. Every response also carries both stable instrument IDs,
the native/reviewed identity scope and any reviewed economic asset ID. The browser verifies those
fields together with symbol, venues, markets and entry/exit sides against the original request before
opening or closing a paper position. Client disconnect cancels upstream work after the last shared
subscriber leaves; excess unique book requests receive explicit overload backpressure rather than an
unbounded queue.

Opportunity alerts fire only when a route crosses the configured net threshold. Desktop delivery
uses browser permission. Remote delivery is available only to an authenticated paper-trade session
with an enabled notification channel. An authenticated operator can save up to 50 persistent server
rules. Enabled rules keep the shared feed active when the browser is closed. Crossing and cooldown
state is tracked independently for every rule + opportunity, so a new route is not hidden behind an
already-eligible best row. Stale, skewed and unverified rows fail closed.

Server notifications use a durable at-least-once outbox. A crossing is persisted before delivery;
failed sends retain their error and retry with bounded exponential backoff across process restarts.
The authenticated alerts response exposes `queued`, `sending`, `retrying`, `delivered`, `failed` and
`cancelled` states. Updating, disabling or deleting a rule cancels its outstanding retries. A crash
after the remote channel accepts a message but before the delivered state is persisted can produce a
duplicate, which is the normal at-least-once boundary. Alerts never place orders.

`GET /api/arbitrage/history` reads a bounded seven-day SQLite series. While the feed is active, the
server records the 50 best routes at most once per minute; the depth panel renders the selected
route's last 24 hours. Old samples are pruned hourly.

Historical basis replay is a separate deterministic backend research boundary. Its immutable
schema-v4 manifest binds event/source/registry/version digests, canonical economic asset IDs and
versioned quantity-step/minimum-quantity/minimum-notional updates. Listings, constraint changes and
delistings are applied point in time, entry and exit walk recorded depth, and only verified funding
whose settlement `exchangeTs` lies inside `[openedAt, actualClosedAt)` affects PnL. A delayed
funding record keeps its `receivedAt` provenance and cannot move the settlement or mutate the
already chosen entry/exit.

Paper positions are a local browser research ledger. Entry uses the depth VWAP for both legs; close
requests the inverse books for the exact open quantity and uses exit VWAP. Open PnL marks the spot
leg to its bid and the short perpetual leg to its ask, then subtracts the non-funding round-trip
cost estimate. Funding changes PnL only through a manually confirmed event containing settlement
time, rate and reference price; the current ticker rate is never silently booked as cash flow. The
panel reports realized/open PnL, closed win rate and average closed PnL.
These records are not an exchange account and are capped locally. The live table renders 50 rows
per page so high-frequency updates do not rebuild hundreds of DOM rows.

## Multi-leg cycle research

`POST /api/arbitrage/n-leg/evaluate` accepts caller-supplied exact spot metadata and complete,
sequence-verified depth to discover and simulate bounded simple cycles with four to eight legs. It
checks exact venue/asset/unit identity, visible depth, lot/minimum rules, side-specific fees and
rounding dust. The HTTP response and public SDK are permanently read-only and non-executable.

An isolated server-side paper module can convert an evaluated N-leg or two-leg route-family result
into a short-lived `paper-multi-leg-plan-v1`. It records deterministic failure-injection fill ratios,
stops at the first incomplete leg, journals the compensation decision, and simulates reverse fills
in reverse leg order. A plan finishes as completed, compensated, aborted without exposure, or manual
review with exact unresolved paper quantities. The append-only SQLite journal verifies hashes and
event sequence, has hard run/event caps, and resumes incomplete runs after restart. It is mounted
only below authenticated `/api/trade/paper-multi-leg` with the `paper-trade` role and CSRF on
mutation. The Trade workspace provides a strict EN/RU/KK plan-import, recovery, run-list and event
journal UI. A separate one-click Screener action can now open the normalized opportunity research
card in Automation, but it deliberately does not copy or create the exact plan JSON required here.
The module has no private exchange client, accepts no credentials, is absent from the public SDK,
and is not a live venue-wide scanner or real multi-order executor.

## Funding curve scenarios

The **Funding stress** tab selects up to four fresh perpetual instruments from the server-owned
`GET /api/arbitrage/funding-curve/universe` response. That endpoint intersects the verified registry
with the adapters actually implemented by the funding service, so a general venue manifest cannot
make an unsupported Binance/Bybit instrument appear selectable. `POST /api/arbitrage/funding-curve` then builds a
point-in-time sequence of discrete settlements for a bounded horizon and applies baseline plus
additive positive/negative stress per settlement. The strict public SDK revalidates schedule,
freshness, unit, timestamp, scenario arithmetic and the permanent non-executable envelope.

The browser compares a funding-rate gap only when instruments share the same exact reviewed
`economicAssetId` **and** the server's `crossVenueClock` gate is eligible. Every successful curve
labels a calibrated venue-time interval or an explicit local-receipt fallback. Comparison requires
calibration for every participating venue and worst-case interval skew within the requested bound;
missing, expired or skewed evidence displays a typed blocker instead of a gap. Positive funding
means longs pay shorts, so it labels the lower cumulative rate as the research long and the higher
rate as the research short. This is not a trade or P&L: entry and exit basis, fees, margin,
liquidation, capital, borrow and fill risk remain outside that number. Adapters with continuous or
inferred funding boundaries are shown as explicit fail-closed rejections rather than receiving an
invented interval.

## Continuous multi-venue routes

The **Live routes** tab polls `GET /api/arbitrage/route-families/live` only while the page is visible.
The server, not the browser, owns the bounded instrument allowlist and fee overlays. Economic identity
comes only from the central exact versioned catalog; an environment row must match it and cannot
declare a new equivalence. An absent allowlist opens no WebSocket subscriptions and is shown as `disabled`. A registry
failure, expired identity review, gap or unsupported instrument withdraws its evidence rather than
reusing a stale route.

OKX, Gate.io and Deribit books can enter the sequence-ready set only after their protocol continuity
checks pass. Hyperliquid full block snapshots remain visible source evidence but are explicitly not
treated as sequence proof. A cross-venue `market-only` evaluation additionally requires calibrated
corrected-local intervals for both public sources. Missing, degraded, expired, stale, future or
worst-case-skewed evidence becomes a typed market-data blocker; calibrated-but-invalid exchange
time never silently falls back to receipt time. Same-venue rows may expose an explicitly labelled,
non-cross-venue-comparable receipt fallback. With that timing gate, the server aligns
sequence- or checksum-verified books fenced to the current connection generation through both
normalized quantity models and uses the maximum common base quantity visible at the current buy ask
and sell bid. The
result reports the short-bid quote value minus the long-ask quote value and the corresponding entry
basis, both before and after public taker quote-equivalent fee estimates from the operator
environment. These are entry value differences, not a trading return or expected profit. The
calculation is top-book and entry-only, not a full-depth or round-trip result. The fee asset is not
verified and its effect on base/quote exposure is not included; the profile also proves no account
tier, discount or rebate.

The server enumerates the complete compatible universe under the 24-instrument hard bound (at most
552 ordered pairs), evaluates all candidates and only then publishes the best bounded set. Ranking
uses fee-adjusted entry quote-value first, followed by basis, visible capacity, continuity quality
and freshness. Separate evaluated and published counters make truncation explicit; route IDs or
family order can no longer discard a better market row before economics are calculated.

Each `market-only` row carries two economic-identity records in strict long/short order. Every record
binds `instrumentId`, `economicAssetId`, reviewed status, source, version, `asOf` and `validUntil`,
and must be valid at `evaluatedAt`. Invalid, not-yet-valid or expired identity provenance fails
closed. Derived capacity, quote values, fee estimates and basis arithmetic must remain finite,
positive where required and internally consistent; overflow, underflow or a forged derived field is
rejected rather than published. The strict SDK independently checks the ordered provenance and
recomputes the derived arithmetic. Continuity, generation, freshness, quantity and venue-minimum
failures likewise produce explicit market-data blockers instead of an entry-value result.

`market-only` does not mean executable. Every evaluation remains `readOnly: true`,
`researchOnly: true`, `executable: false` and `strategyStatus: blocked`, with an execution boundary
that does not support orders. The evaluation has no verified balances, capital, inventory,
network/withdrawal path, borrow, derivative margin, full-horizon funding, convergence,
expiry/delivery, exit costs, order fills or profit guarantee. Those missing strategy inputs remain
visible as blockers even when the two market books are complete.

The top-level runtime and discovery snapshots publish the same coverage authority:
`complete`, `current`, `retainedPriorDiscovery` and a bounded reason (`complete`, configuration
disabled/invalid, refresh pending/failed or partial instruments). A successful partial refresh is
current but incomplete. A later registry refresh failure may retain the last discovery so it remains
observable, but marks it incomplete, non-current and explicitly retained; it is stale evidence, not
a successful refresh. Failure of the first refresh retains nothing and does not fabricate
`refreshedAt`.

The continuous lifecycle may use the entry basis after estimated fees as a research observation,
but every leg remains evidence-incomplete and `actionable: false`. A candidate blocked by market
data and carrying no usable evidence is omitted instead of being converted to a synthetic zero-score
route, so it cannot invalidate a separate good observation. Its real blocker codes still enter
lifecycle failure coverage. Runtime refresh reasons, non-live sources, excluded/rejected inputs,
candidate/economics truncation and stale-market codes propagate into incomplete/stale/truncated
coverage. Candidate rows and lifecycle state therefore describe bounded public-market evidence;
neither is an order signal or an authorization boundary.

The separate daily/manual credential-free canary observes one selected target on every one of the
nine generic continuous venues. Spot targets require a public book; derivative targets require a
book and public funding observation, except the explicitly reviewed book-only dYdX research target.
Its retained schema-v3 JSON artifact records exact requirements, environment, integrity and
continuity plus permanent `credentialsUsed: false`, `executionAttempted: false`, `soakClaimed:
false` and `mainnetReadinessClaimed: false` fields. A red venue remains evidence of a failed network
path, not an empty market. The 2026-07-14 local run passed OKX, Gate, Hyperliquid, Deribit public
testnet, Coinbase, dYdX, KuCoin and MEXC. Kraken remained unreachable through this host's TLS
egress. Live runs exposed and regression-tested KuCoin binary-marked JSON, Coinbase
connection-global sequencing and the MEXC snapshot/delta bootstrap race. One run is not soak or
execution-readiness evidence.

Official inputs: [Binance Spot WebSocket streams](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-streams/~), [Binance USD-M WebSocket streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public), [Bybit V5 connection rules](https://bybit-exchange.github.io/docs/v5/ws/connect), [Bybit V5 tickers](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker), and [Bybit order book](https://bybit-exchange.github.io/docs/v5/market/orderbook).

## Order-book ML research

The admin-only **Order-book ML** Screener workflow is a bounded lab for anonymous aggregate
liquidity behavior. Its `/api/orderbook-ml/research` API and localized browser panel create and
delete temporary sessions, accept strict snapshot batches, train an inspectable baseline and run
exact-scope inference while exposing quality counters, split metrics and provenance.

Input must be caller-uploaded `sequenced-l2-snapshot-v1` data from a reconstructed WebSocket book:
positive sorted non-crossed levels, exact venue/instrument/normalizer identity, connection
generation, verified source sequences and monotonic exchange timestamps are required. The service
rejects gaps, generation switches, stale/future input and malformed depth instead of repairing it.
The current public browser order-book hub is intentionally not connected because its throttled
partial depth does not prove the required source-sequence continuity.

Versioned features summarize spread/microprice, multi-level depth imbalance, book-state
refill/depletion and add/cancel approximations, slopes/concentration and optional classified trade
flow. Future-mid-return labels use only later snapshots, and chronological train/validation/test
splits purge rows whose label horizon crosses a boundary. The baseline is one-instrument ridge
regression with train-only feature scaling. Inference reports predicted basis points, direction,
signal-to-validation-noise, feature contributions and out-of-distribution distance; none of those
values is a calibrated probability.

The registry is process-memory only: at most four sessions, 2,000 snapshots and three models per
session, with a 30-minute TTL, 250 snapshots per upload batch, a 1 MiB JSON body cap and a bounded
cooperative processing budget. There is no online collector, raw-data persistence, durable model
registry, scheduled retraining or drift monitor. Public aggregate L2 does not identify a person,
account, market maker or other participant, so every artifact states
`participantIdentityInferred: false`. The API and UI are research-only and expose neither paper nor
live order actions.

## Risk boundary

The screener is research-only and never places orders. Quotes from separate venues are asynchronous.
Fees, depth changes after the snapshot, slippage, funding, borrow availability, transfer time, position
limits, API latency and liquidation risk can remove the displayed edge. A positive row is not a
profit guarantee and does not prove that both legs can execute atomically.

Canonical engineering boundaries: [taxonomy](ARBITRAGE_TAXONOMY.md),
[math and assumptions](ARBITRAGE_MATH_AND_ASSUMPTIONS.md),
[market-data quality](MARKET_DATA_QUALITY.md), [venue capabilities](VENUE_CAPABILITIES.md) and
[verification matrix](ARBITRAGE_TEST_MATRIX.md).
