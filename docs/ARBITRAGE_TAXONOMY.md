# Arbitrage taxonomy

Status: canonical product vocabulary, reviewed 2026-07-14.

This document names the opportunity families that SaltanatbotV2 may display. It separates shipped
behavior from planned research so that “fork”, “spread” and “arbitrage” do not imply guaranteed
profit. The interactive screener publishes Binance/Bybit `spot-perpetual`, single-venue triangular
top-book simulations, Bybit venue-native spreads, a caller-supplied options-parity lab and
operator-allowlisted continuous route-family identities. Bounded research endpoints also evaluate
pairwise, options and four-to-eight-leg inputs. They remain non-executable unless a separate paper
workflow explicitly records a simulation; none is an automatic private-order feed.
Anything else remains a roadmap item until its adapter, tests and user interface are recorded in
[Implementation status](IMPLEMENTATION_STATUS.md).

## Outcome classes

Every opportunity must carry one of these labels. The label describes the mathematical claim, not
the visual color of the row.

| Class | Meaning | Examples | Product wording |
| --- | --- | --- | --- |
| `locked` | All required legs have a defined settlement/conversion relationship and executable quantities; remaining operational risks are still disclosed | a fully executable triangular cycle; a dated-future spread held to known settlement | “locked before operational risks” |
| `projected` | PnL depends on an unknown future basis, funding, borrow, exit price or holding period | spot-perpetual cash-and-carry; perpetual-perpetual funding differential | “projected”, never “guaranteed” |
| `statistical` | The relationship is inferred from historical behavior and can structurally break | pairs trading, mean reversion | “statistical signal”, not “arbitrage” |

A positive entry basis is not a locked return. Perpetual contracts have no expiry, and a funding
forecast is not a receivable until the position survives a settlement event.

## Leg count

### Informal “fork” names

In trader chat, **double fork** usually means a two-leg price relationship, **triple fork** means a
three-leg triangular conversion, and **intra-exchange fork** means all legs stay on one venue. These
names are ambiguous, so SaltanatbotV2 stores the canonical family and ordered leg identity instead:

| Informal name | Canonical interpretation | Example | Main hidden risk |
| --- | --- | --- | --- |
| double / two-way fork | pairwise route | buy spot on venue A, sell spot or derivative on venue B | inventory/collateral, transfer and legging |
| triple fork | triangular cycle | `USDT → BTC → ETH → USDT` on one venue | depth, fee after each leg, lot dust and partial fill |
| intra-exchange fork | any same-venue pair/cycle | spot-perpetual, calendar, native spread or triangle | legs are still non-atomic unless the venue exposes one native instrument |
| inter-exchange fork | any route spanning venues | spot-spot or perpetual-perpetual | independent clocks, custody, settlement and rebalancing |
| multi-fork | N-leg cycle | four-to-eight conversions | combinatorial search, accumulated fees and recovery exposure |

A “fork” row is therefore a route hypothesis, not a profit guarantee. The UI should show family,
ordered legs and outcome class rather than only the informal label.

### Two-leg opportunities

| Canonical ID | Legs | Typical location | Important dependencies | Status |
| --- | --- | --- | --- | --- |
| `cross-venue-spot-perpetual` | long spot, short perpetual | two venues | matched quantity, two books, funding, prefunded collateral | current discovery + browser paper research |
| `same-venue-spot-perpetual` | long spot, short perpetual | one venue | account/margin model, funding, common instrument identity | supported by basis route construction; execution remains unavailable |
| `cross-venue-spot-spot` | buy spot, sell spot | two venues | prefunded quote capital/base inventory, rebalance networks, deposit/withdraw state | deterministic route-family research; exact capital/inventory/rebalance required |
| `reverse-cash-and-carry` | short borrowed spot, long derivative | one or two venues | borrow availability/APR, recalls, margin and liquidation | pure pairwise evaluator; explicit verified borrow required |
| `perpetual-perpetual` | long one perpetual, short another | two venues | funding schedules, mark/index differences, collateral | deterministic route-family research; two verified schedules required |
| `spot-future` | long spot, short dated future | one or two venues | quote capital, expiry, settlement asset and contract multiplier | deterministic route-family research; close-before-expiry assumption required |
| `calendar-spread` | long one expiry, short another | usually one venue | expiry calendars and settlement rules | deterministic route-family research; explicit delivery/convergence assumptions |
| `perpetual-future` | perpetual against dated future | one or two venues | funding plus expiry basis | deterministic route-family research; funding/convergence/delivery required |

For cross-venue spot-spot, transfer cost belongs to inventory rebalancing when both venues are
prefunded; it must not be presented as an atomic third leg of every entry.

### Three-leg triangular cycle

A triangular cycle starts and ends in the same asset on one venue, for example:

```text
USDT -> BTC -> ETH -> USDT
```

An execution-grade scanner must choose bid or ask from the actual trade direction, apply a fee after
every leg, walk depth for one conserved starting amount, round after each venue filter, enforce
minimum quantity/notional and report residual dust. The pure engine supports multi-level books, but
the current public discovery route feeds one venue-wide REST top-book level per market and labels
every result `top-book-only`/`rest-snapshot`; it is a capacity-limited candidate simulation, not a
full-depth execution claim. A graph search such as negative-cycle detection over
`-log(executable rate after fee)` is only a candidate generator; the row is publishable only after
exact quantity/depth simulation. The three orders are not atomic unless the venue explicitly offers
an atomic spread instrument.

A three-edge cycle can technically span several venues, but SaltanatbotV2 should label it a
**multi-venue cycle**, not silently mix it with the current intra-exchange triangle. Every venue
must already hold the required input inventory and collateral, each leg needs an independent
clock/generation proof, and transfers belong to later inventory rebalancing rather than an atomic
entry. Automatic cross-venue triangular discovery is therefore still planned; equal ticker text
or a profitable graph weight is not enough to publish it.

### N-leg cycle

Cycles with four or more legs are a research family. Every added leg increases fees,
latency, rounding loss and partial-fill exposure. The transport-free `n-leg-v1` engine now generates
bounded simple 4–8-leg cycles and applies exact venue/asset/unit identity, side-specific fee assets,
multi-level depth, lot/minimum constraints and residual conservation. Its public results remain
explicitly non-executable: the read-only route/SDK grants no paper or live execution permission,
and a theoretical graph cycle is never published without exact quantity simulation. A bounded
HTTP/SDK surface and a separate authenticated paper-only recovery journal are available; live
venue-wide discovery and real multi-order execution remain separate, unavailable capabilities.

## Location and settlement dimensions

“Intravenue” means all legs are on the same venue; it does not mean “triangular”. An intravenue
opportunity can be spot-perpetual, spot-future, perpetual-future, calendar or triangular. A
cross-venue opportunity requires independent timestamps, collateral and venue-risk disclosure.

The complete opportunity identity is:

```text
strategy family
+ ordered legs (venue, market type, instrument ID, side)
+ settlement/collateral assets
+ quantity and horizon
+ cost-model version
+ market-data-quality state
```

The display symbol alone, such as `BTCUSDT`, is not a safe identity.
The pairwise research contract therefore requires an exact canonical `economicAssetId` match plus
fresh, unexpired, versioned review provenance for both legs. That provenance is supplied by the
caller and is disclosed as such; the public evaluator validates the contract but does not certify
the external review source.

## Native spread and options families

Native venue spreads may reduce leg risk because the venue exposes the spread as an instrument, but
the adapter still has to validate contract multipliers, order semantics and settlement. The current
Bybit read-only adapter ingests `FundingRateArb`, `CarryTrade`, `FutureSpread` and `PerpBasis`
instrument metadata and venue-native spread order books. It exposes research quotes in the UI/API;
it does not expose an order path and does not describe every combination as atomic.

Options parity is a separate pure backend research engine. It evaluates European put-call parity,
conversion/reversal, box spreads and synthetic forwards using exact strike/expiry/right/settlement
identity, executable depth, native quantity steps, premium FX, fees, rates/dividends, short capacity
and hold-to-expiry assumptions. Settlement and valuation assets must currently be identical because
expiry settlement FX is not modelled; mismatches fail closed. Static parity does not require a volatility surface; volatility is a
separate pricing/risk extension. Every result remains `research-simulation` and `executable: false`;
the bounded strict HTTP/TypeScript SDK surface accepts only caller-supplied public snapshots and
explicit assumptions. The EN/RU/KK browser scenario lab exposes that same boundary, not an
automatic live Deribit feed or private order path.

## Required row disclosure

The table above is canonical product vocabulary. Current transports use `edgeKind="projected"` for
basis and `edgeKind="research-simulation"` plus `executable:false` for pure evaluators; a dedicated
`outcomeClass` wire field is still a contract migration, so clients must not infer `locked` from a
green row. Every engine must expose or make derivable:

- outcome class (`locked`, `projected` or `statistical`);
- ordered legs, side, venue and normalized instrument identity;
- requested and executable quantity, residual delta and rounding dust;
- bid/ask/depth source time, receive time, age and cross-leg skew;
- gross basis, each cost component, expected net PnL, capital and margin buffer;
- horizon, funding/borrow assumptions and versioned model ID;
- capacity, confidence and every fail-closed reason;
- whether paper, private execution and regional eligibility are supported.

See [Arbitrage math](ARBITRAGE_MATH_AND_ASSUMPTIONS.md), [Market-data quality](MARKET_DATA_QUALITY.md)
and [Venue capabilities](VENUE_CAPABILITIES.md).
