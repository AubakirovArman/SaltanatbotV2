# `@saltanatbotv2/arbitrage-sdk`

Transport-safe, public/read-only TypeScript client for SaltanatbotV2 arbitrage
research endpoints. It includes bounded timeout/cancellation/payload handling and
strict runtime validation for basis, triangular, pairwise research, Bybit
native-spread, options-parity, funding-curve and N-leg research, instrument registry,
venue-capability, allowlisted public venue market-data and continuous-feed-health responses.

`market-opportunity-v1` is the common, fail-closed research envelope for basis,
continuous pairwise routes, N-leg cycles and venue-native spread quotes. It
normalizes legs, economics coverage, capacity, evidence and execution
boundaries without turning public/research output into a live-order contract.
Only N-leg output with verified sequence/timestamp evidence is currently marked
`paperPlan: "ready"`; every normalized opportunity remains `live: "blocked"`.

`networkIdentityRegistry()` validates the complete server-owned identity
snapshot, aggregate validity window and exact cross-references.
`networkTransferPreflight()` accepts no evaluation timestamp or registry rows;
the server supplies time and evaluates only its captured snapshot. Both methods
are public/read-only and every preflight result remains `executable: false`.
The delivered registry is a static reviewed identity snapshot, not dynamic
transfer telemetry: deposit/withdraw status, fees, limits, confirmations and an
arrival observer are absent. `maximumArrivalMs` is a requirement, not a measured
arrival, and every preflight continues to require external arrival proof.

Public top books require positive two-sided size and an uncrossed spread. Depth
requires non-empty, strictly price-sorted, positive-size bid/ask sides and a
complete uncrossed snapshot. Venue provenance is retained: for example,
Hyperliquid `source`, `executable`, `sequenceAvailable`, `sequenceVerified`,
`network`, `currentEstimateSource` and `timestampSource` are not discarded by
runtime parsing.

Bybit native-spread rows retain the complete instrument contract (`status`,
price and quantity bounds, tick/lot grids, launch/delivery time and typed legs)
plus book `sequence`, exchange time, matching-engine time and local receive time.
The parser fails closed on non-trading/duplicate-leg instruments, crossed or
off-grid books, inconsistent width/capacity/age/counts, and unknown or missing
read-only risk flags.

`instruments()` returns verified registry rows by default and accepts
`{ includeStale: true }` only when a caller deliberately wants retained stale
catalog rows. Its runtime parser validates the exact `updatedAt`, `checkedAt`,
`stale`, `includeStale`, `sourceErrors` and `sourceStates` envelope, including
coherent receipt/check age and `fresh`/`stale-cache`/`quarantined` status rules.
Because registry sources are polled concurrently, a `fresh` source may have a
non-zero age; `receivedAt <= checkedAt` and
`ageMs === checkedAt - receivedAt` remain mandatory. A `fresh` source never
carries an error message.
`venues()` validates the same freshness envelope around capability manifests.
For Binance/Bybit it also validates unique product/operation `scopes`; missing combinations are
unsupported, and coarse booleans cannot authorize private execution, borrowing or transfers.

Scanner parsing does not trust derived wire fields. Basis rows are checked
against their envelope, source dependencies, route identity, capture/receipt
times, spread, cost, capacity and profit formulas. Native-spread quote age is
recomputed from its exchange timestamp at scan completion. Pairwise research
responses are checked against ordered book provenance, timestamp aggregates,
leg quantities/notionals, cost totals and PnL/return identities.
Options-parity parsing additionally enforces its fixed caller-supplied assumption
contract, strategy/direction/leg shape, expiry and settlement identity, fee/net-edge
arithmetic, quote age/skew and the permanent non-executable boundary.

```ts
import { SaltanatArbitrageClient } from "@saltanatbotv2/arbitrage-sdk";

const client = new SaltanatArbitrageClient({ baseUrl: "http://127.0.0.1:4180" });
const scan = await client.basis({ minCapacityUsd: 5_000, limit: 100 });
const depth = await client.venueDepth("okx", {
  marketType: "perpetual",
  instrumentId: "BTC-USDT-SWAP",
  limit: 50
});
const funding = await client.venueFunding("okx", {
  marketType: "perpetual",
  instrumentId: "okx:perpetual:BTC-USDT-SWAP",
  historyLimit: 100
});

const evaluation = await client.pairwise({
  instruments: [longInstrument, shortInstrument],
  books: [longBook, shortBook],
  route,
  options: { maxQuoteAgeMs: 2_000 }
});

const native = await client.nativeSpreads({
  contractType: "FundingRateArb",
  maxCandidates: 20
});
const options = await client.optionsParity({
  primary: primaryCallPutSeries,
  secondary: secondStrikeSeries,
  underlying: underlyingSnapshot,
  targetBaseQuantity: 1,
  assumptions: explicitOptionsAssumptions,
  limits: { maxQuoteAgeMs: 2_000, maxLegSkewMs: 250 }
});
const cycleResearch = await client.nLeg({
  evaluatedAt: Date.now(),
  requestedStartQuantity: 1_000,
  startAsset: { venue: "okx", assetId: "USDT", unitId: "NATIVE" },
  markets: exactSpotMetadata,
  books: sequenceVerifiedDepth,
  graph: { minLegs: 4, maxLegs: 6, maxCycles: 50 }
});
const verifiedTriangle = await client.verifyTriangularDepth({
  venue: "binance",
  startAsset: "USDT",
  startQuantity: 1_000,
  takerFeeBps: 10,
  minimumNetReturnBps: 0,
  symbols: ["BTCUSDT", "ETHBTC", "ETHUSDT"]
});
const fundingCurves = await client.fundingCurve({
  selections: [
    { venue: "okx", instrumentId: "okx:perpetual:BTC-USDT-SWAP", marketType: "perpetual", rateUnit: "decimal-per-settlement" },
    { venue: "gate", instrumentId: "gate:perpetual:BTC_USDT", marketType: "perpetual", rateUnit: "decimal-per-settlement" }
  ],
  horizon: { value: 24 * 60, unit: "minutes" },
  stressScenarios: [
    { id: "down", bumpBps: -1, unit: "basis-points-additive-per-settlement" },
    { id: "base", bumpBps: 0, unit: "basis-points-additive-per-settlement" },
    { id: "up", bumpBps: 1, unit: "basis-points-additive-per-settlement" }
  ]
});
const liveRoutes = await client.continuousRoutes();
console.log(liveRoutes.state, liveRoutes.discovery.sources);
const feedHealth = await client.continuousFeedHealth();
console.log(feedHealth.state, feedHealth.counts, feedHealth.sources);
const networkIdentity = await client.networkIdentityRegistry();
const transferResearch = await client.networkTransferPreflight({
  schemaVersion: 1,
  registryVersion: networkIdentity.registry.registryVersion,
  routeId: "route:binance-bybit-btc",
  assetId: "asset:bitcoin",
  amount: "1",
  source: { venue: "binance", withdrawalNetworkCode: "BTC" },
  destination: { venue: "bybit", depositNetworkCode: "BTC" },
  maximumEvidenceAgeMs: 30 * 86_400_000,
  maximumFutureClockSkewMs: 1_000,
  maximumArrivalMs: 86_400_000
});
console.log(networkIdentity.validity, transferResearch.failures);
const registry = await client.instruments({
  venue: "okx",
  marketType: "perpetual",
  includeStale: false,
  limit: 100
});
if (registry.stale) console.warn(registry.sourceStates);
console.log(native.opportunities[0]?.matchingEngineTs);
console.log(options.candidates[0]?.netEdgeValue);
```

`venueFunding()` requires `marketType: "perpetual"`; the server validates the same scope in stable
instrument IDs and the runtime parser requires it in the response. A spot, margin, dated-future,
option or native-spread ID cannot be relabelled as a funding instrument.

The package intentionally exposes no API-key, account, order or private-execution
methods. `pairwise()` posts only caller-supplied public metadata, books and explicit
research assumptions to the deterministic evaluator. It runtime-checks that both
instruments carry the same well-formed canonical `economicAssetId` and complete
reviewed source/version/time provenance before sending. Responses are rejected if
identity provenance is mismatched, stale, expired, beyond its declared future-clock
boundary or inconsistent with its effective validity calculation. Every result is
also validated as `executable: false`. Review provenance remains caller-supplied;
the server and SDK validate its contract, not its real-world authority. A scanner
row remains research data, not a fill or profit guarantee.

`optionsParity()` posts only caller-supplied public snapshots and explicit rate,
expiry/settlement, premium-FX, fee, short-capacity and borrow assumptions. Its response parser
rejects unknown/execution-shaped fields and recomputes the identities available on the wire.
The server and SDK are deterministic research boundaries; neither supplies Deribit credentials,
account state, private margin verification or order submission.

`nLeg()` posts at most 80 caller-supplied spot markets and sequence-verified books to the bounded
four-to-eight-leg cycle evaluator. Its parser independently checks the permanent non-executable
envelope, exact accounting-unit chain, per-leg conservation and fee arithmetic, residual/fee
aggregates, time provenance, deterministic ranking and graph work proof. It exposes no live book
subscription, account inventory or multi-order execution method.

`verifyTriangularDepth()` posts exactly three symbols selected from the venue-wide candidate scan.
Its parser requires three current sequence/generation proofs, recomputes capacity/return/timestamp
identities and rejects top-book/unsequenced provenance. The envelope remains permanently
`executable: false` and `execution: "none"`; L2 continuity is not account or order authorization.

`continuousRoutes()` observes the operator-selected public WebSocket route-family runtime. It is a
GET-only research surface: the strict parser returns candidate identity, source state, top books and
funding evidence while full depth remains server-side. New runtimes add the atomic
`marketEconomics`/`marketEvaluations` pair and explicit runtime coverage; both economics siblings are
required together, while their joint absence remains compatible with an older server. The SDK
recomputes visible top-book capacity, entry value/basis differences, quote-equivalent public taker-fee
estimates, freshness and ordered sequence/checksum and economic-identity provenance. Fee asset and
exposure impact remain explicitly unverified, every strategy stays blocked/non-executable, and retained
prior discovery is exposed as stale rather than current coverage. The SDK has no method for changing
the allowlist, adding credentials or placing orders.

The runtime can load exactly one bounded operator allowlist from inline JSON or an absolute file
path. The reviewed `config/continuous-routes.research.json` and its fail-closed file loader are
implemented, but the SDK neither activates nor mutates them. A checked-in file or deterministic
loader test does not prove that the current server process opened those subscriptions.

`continuousFeedHealth()` validates the public no-store `continuous-feed-health-v1` diagnostics
envelope, aggregate counts/state, reconnect generations, last-receive freshness and sequence/
checksum continuity relationships. The EN/RU/KK Live routes browser uses the same strict contract.
`bookContinuityReady` proves only a fresh, current-generation protocol book; `idle` is a valid result
when no allowlist is active. Neither value proves compatible economics, private account state,
orders or execution permission.

`fundingCurve()` requests bounded point-in-time public funding projections only for discrete,
verified perpetual schedules. It preserves source/freshness/history provenance and additive stress
assumptions, but intentionally accepts no notional, account, margin or order input and does not
return P&L. Every curve remains `researchOnly: true` and `executable: false`.

SDK availability and parser tests are deterministic public-contract evidence. They are distinct
from a runtime being configured, the browser being delivered, a dated credential-free public
canary, authenticated private evidence and production readiness. No SDK method collapses those
gates or authorizes mainnet trading.
