# Venue capability, eligibility and expansion matrix

Status: canonical implementation register, truth-audited against the repository and official venue
documentation on 2026-07-15.

This document separates five things that are easy to confuse: public market-data code, continuous
loss-detecting books, scanner participation, private account/execution code and operator/legal
eligibility. A green result in one layer does not enable the next layer. Nothing in this document is
a mainnet-readiness claim, and the excluded 7–14-day funded Binance/Bybit soak has not been run.

The adapter and continuous-runtime rows below are mechanically locked to the application sources by
the [machine-readable capability truth register](CAPABILITY_TRUTHS.json); changing a registry, UI
mode or generated endpoint total without updating its reviewed documentation makes the semantic
stage of `npm run docs:check` fail.

## Status vocabulary

| Label | Exact meaning |
| --- | --- |
| Implemented public | A credential-free code path is registered, bounded and covered by repository tests |
| Continuous route-ready | A selected-instrument WebSocket book can enter research discovery only after its implemented sequence/checksum, generation and freshness gates pass |
| Continuous research-only | A stream or reducer exists, but its integrity/canonicality evidence is insufficient for route-ready books |
| Experimental private | Authenticated code exists but is disarmed by default and is not mainnet-ready |
| Planned candidate | No adapter is implemented; the row is a researched priority, not a promise |
| Excluded | Deliberately not offered for the stated deployment or legal scope |

Evidence suffixes are independent: **runtime-connected** means the server can mount a path when
configured, **browser-delivered** means an EN/RU/KK surface exists, **deterministic** means repository
fixtures/tests pass, and **public canary** means a credential-free observation was captured at the
stated time/network. **Private evidence** requires authenticated account/order/fill observations.
**Production-ready** additionally requires activated and sustained runtime evidence, operations,
legal eligibility and applicable private gates; none of the earlier labels implies it.

“Route-ready” still means **research input**, not executable arbitrage. It does not prove balances,
borrow inventory, margin, fees, transfer networks, simultaneous fills or jurisdictional access.

## What is actually wired

| Surface | Current truth |
| --- | --- |
| Charts | Binance and Bybit public candle routes only; market type and price-source limitations remain explicit |
| Native Binance/Bybit scanner | Cross-venue and same-venue spot/perpetual basis, selected triangular research and Bybit native spreads |
| Shared public REST facade | OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin and MEXC through `/api/market-data/:venue/*` |
| Instrument registry | Binance/Bybit/OKX native sources plus all registered public adapters; fresh rows are returned by default and stale cache is opt-in |
| Generic continuous module | OKX, Gate.io, Hyperliquid, Deribit, Kraken, Coinbase, dYdX, KuCoin and MEXC only; it is operator-allowlisted and browser read-only |
| Continuous activation | Runtime wiring, a bounded file-backed loader and reviewed `config/continuous-routes.research.json` are implemented, but the file is not auto-loaded; the target process must set its absolute path (or mutually exclusive inline JSON) |
| Continuous diagnostics | Public no-store `/api/arbitrage/continuous-feed-health`, strict SDK and EN/RU/KK Live routes diagnostics are delivered. `idle` is valid when configuration is absent; protocol-ready means fresh same-generation book continuity, not route or execution readiness |
| Network identity | Static reviewed Binance/Bybit BTC/ETH native and Ethereum USDT/USDC registry plus bounded public preflight/SDK are delivered. Dynamic transfer status, fees, limits, confirmations and arrival observer are absent |
| Private trading | Paper plus experimental Binance/Bybit paths only; every shared public adapter declares private execution false |

`GET /api/instruments` exposes normalized metadata from the full registry above. `GET /api/venues`
exposes capability manifests. Both include freshness/provenance state. The bounded public facade has
no credential input. `GET /api/arbitrage/route-families/live` exposes the optional continuous module;
browsers cannot add subscriptions, approve economic identity or change fee overlays.
`GET /api/arbitrage/continuous-feed-health` exposes only the currently instantiated hub state. The
checked-in allowlist, deterministic protocol tests and dated public canary are three different kinds
of evidence and do not establish that this deployment currently has active feeds.

## Current venue matrix

| Venue | Implemented public/read-only scope | Continuous integrity status | Implemented scanner path (runtime activation separate) | Private/account boundary |
| --- | --- | --- | --- | --- |
| Binance | Native registry, chart candles, spot and derivative top-book/depth/funding sources | Scanner-specific feeds exist, but Binance is not part of the generic continuous-public-feed module | Current Binance↔Bybit and same-venue basis plus selected top-book triangular research | USDⓈ-M private execution is experimental. Live Spot submission is disabled until authenticated Spot execution accounting exists. Inverse execution is unsupported |
| Bybit | Native registry, chart candles, spot/linear/inverse public data and native spread metadata/book | Scanner-specific Bybit snapshot/delta books exist, but Bybit is not part of the generic continuous-public-feed module | Current basis, triangular and venue-native spread research | Spot and USDT-linear execution are experimental. UTA collateral/borrow controls are explicit opt-in. No mainnet-readiness claim |
| OKX | Registered REST metadata, BBO, bounded depth and variable funding for spot, swaps and dated futures | Selected `books` stream reconstructs `prevSeqId/seqId`; a valid fresh generation may become route-ready. Deprecated fixed checksum `0` is not integrity proof | Operator-allowlisted generic continuous research; no chart selector | No private/account/order surface |
| Gate.io | Registered REST metadata, BBO, bounded depth and funding for spot and USDT perpetuals | Spot/perpetual OBU uses full plus `U/u`; optional legacy incremental mode requires the governed REST-ID bridge. Valid fresh books may become route-ready | Operator-allowlisted generic continuous research; no chart selector | No private/account/order surface |
| Hyperliquid | Registered public HyperCore `/info` metadata, selected L2 and funding for first-DEX spot/perpetuals | Each `l2Book` is an atomic block snapshot with no protocol sequence/checksum. It stays continuous research-only and is excluded from route-ready books | Generic continuous research signal only | No wallet, address, signing, `/exchange`, HyperEVM or order code |
| Deribit | Registered public JSON-RPC metadata/BBO/depth/funding for perpetuals, dated futures and options | Selected `book` streams use exact `prev_change_id/change_id`; valid fresh books may become route-ready | Generic continuous research plus the separate, read-only options-parity evaluator/workbench | Public-method allowlist only; no credentials or private methods |
| Kraken | Registered Spot plus inverse/linear futures metadata, BBO/depth; inverse perpetual funding | Spot v2 uses lossless decimals and CRC32 after every update and may become route-ready. Futures v1 `seq` is observed but not documented as contiguous per product, so Futures stays research-only | Operator-allowlisted generic continuous research; no chart selector | No private/account/order surface |
| Coinbase | Registered Coinbase Exchange Spot metadata and selected L1/L2 | Advanced Trade public `level2` plus `heartbeats` enforces connection-global sequence across every non-error envelope and independent heartbeat-counter continuity. Sequence zero stays outside route-ready. `market_trades` is never treated as a book. Most `*-USDC` aliases fail closed | Operator-allowlisted generic continuous research; selected Spot canary passed 2026-07-14, no chart selector | No JWT, account or order surface |
| dYdX | **Registered** public Indexer perpetual metadata, selected REST book and funding | The shared hub opens a bounded unbatched Indexer `v4_orderbook` socket and validates `connected` identity plus contiguous `message_id`. Its proof is deliberately `sequence-observed`: the book is non-canonical, research-only and always `routeReady: false`. Funding remains REST-only; the socket does not publish funding | Operator-allowlisted generic continuous research through the dynamic browser filters; no dedicated dYdX workflow or chart selector, and no route-ready economics | No wallet, mnemonic, subaccount, signing, node mutation or order code |
| KuCoin | **Registered** public Spot and linear-USDT-perpetual metadata, executable BBO, bounded REST depth and funding | Spot/Futures public sockets wait for `welcome` and accept only post-2026-07-15 `depth=increment@10ms`, `rpiFilter: 0`; a self-seeded `O=C` snapshot plus exact overlapping `O..C` ranges may become route-ready, while gap/time regression/reconnect withdraws the generation. Binary-marked JSON uses bounded fatal UTF-8 decoding | Operator-allowlisted generic continuous research; selected Spot canary passed 2026-07-14, no chart selector and repeated scheduled evidence pending | No key, signing, account, borrow or order surface |
| MEXC | **Registered** public Spot and linear-USDT-perpetual metadata, BBO/depth and funding | Spot uses a bounded exact public Protobuf decoder plus delta-triggered single-flight REST/version bridge; Futures requests unmerged JSON with `compress: false` and exact `version + 1`. Neither publishes a REST-only seed; gap/reconnect withdraws the generation | Operator-allowlisted generic continuous research; selected Spot canary passed 2026-07-14, no chart selector and repeated scheduled evidence pending | No key, signing, account, borrow or order surface |

The dYdX, KuCoin and MEXC rows correct an older status: they are no longer merely isolated adapter
folders or future candidates. All three now have bounded generic continuous paths, bringing that
module to nine venues. The browser derives venue/source filters from the live response, so all nine
can be inspected without hard-coded buttons. Generic EN/RU/KK reconnect/receive/continuity
diagnostics are delivered; dedicated venue-specific workflows and chart selectors remain separate
UX work. dYdX keeps its explicitly non-canonical, non-route-ready boundary.

The schema-v3 canary now has one reviewed target for every generic continuous venue. The
2026-07-14 local run passed OKX, Gate, Hyperliquid, Deribit public testnet, Coinbase, dYdX, KuCoin
and MEXC; Kraken remained a host TLS-egress failure. Live runs exposed and regression-tested KuCoin
binary-marked JSON, Coinbase connection-global sequencing and the MEXC snapshot/delta bootstrap
race. This is one-time public connectivity evidence, not soak or execution readiness.

## Private execution truth

| Product | Status | Important boundary |
| --- | --- | --- |
| Paper spot/futures and multi-leg journal | Supported for testing | Simulated fills and recovery do not prove venue execution |
| Binance Spot | Disabled | No authenticated Spot execution stream/accounting path yet |
| Binance USDⓈ-M | Experimental | Signed REST, private order updates and reconciliation exist; disarmed by default |
| Binance inverse | Unsupported | No order path |
| Bybit Spot | Experimental | Requires `ENABLE_LIVE_SPOT`, attributed inventory and private v5 accounting |
| Bybit USDT linear | Experimental | Signed v5 lifecycle/reconciliation exists; disarmed by default |
| Bybit UTA cross collateral/manual debt | Explicit opt-in | Borrow, repay and collateral mutations are guard-railed operator actions, not scanner automation |
| All nine shared public adapters | Unsupported by design | Capability manifests keep private execution, borrow and transfers false |

See [Exchange execution capabilities](EXCHANGE_CAPABILITIES.md) for the detailed order and recovery
matrix. Public scanner results must never be used as account entitlement evidence.

## Proposed next-exchange order

These are **planned candidates**. None has repository code or scanner status today. Before any row
below, the higher-priority venue work is to harden the already registered continuous sources, keep
their protocol conformance current and add venue-specific diagnostics where useful. A new venue must
not displace completion and hardening of those existing integrations.

| Priority | Venue | Why it is useful | First acceptable public scope | Integrity and legal gate before scanner use |
| --- | --- | --- | --- | --- |
| Next 1 | Crypto.com Exchange | Spot + derivatives + funding can add cross-venue basis, same-venue carry and funding comparisons | Metadata, exact-decimal selected REST books, then selected `SNAPSHOT_AND_UPDATE` books and funding/estimated-funding | Require `u/pu` continuity, fresh REST resync, endpoint/product identity, regional availability and API/data-terms review. No private methods |
| Next 2 | BitMEX | Strong perpetual/futures, Spot, funding, instrument and settlement data | Public instruments/funding and one selected `orderBookL2` family with explicit liquidity-pool identity | Official WS uses `partial/insert/update/delete`, but the reviewed table protocol does not expose a per-delta contiguous sequence/checksum. Keep research-only until loss detection is proven; handle the 2026 `pool` field and API changelog |
| Next 3 | Bitfinex | Spot, derivatives, funding books and derivative funding/status data are useful for basis and borrow-aware research | Public configs/instrument mapping, selected REST book, then WS v2 books/status | Enable and verify checksum; treat `SEQ_ALL` as documented beta, never hard-code array length, enforce 30-subscription budget, and complete API/Market Data Terms review |
| Next 4 | Gemini | Official metadata distinguishes `spot`/`swap`, REST books preserve exact decimal strings, and derivatives expose funding amounts | Public symbols/details and bounded selected REST book first; then only verified crypto Spot/perpetual differential-depth symbols | Current WS documents snapshot plus `U/u` gap recovery, but examples include prediction-market symbols. Prove product/symbol coverage in fixtures and clarify market-data permission before crypto scanner use |
| Next 5 | Bitstamp | Spot plus public derivatives/funding and public order-event gap-recovery endpoints can broaden basis/funding research | Public markets, exact selected book and funding first; streaming only after protocol fixtures | Commercial exchange-data use explicitly requires a Data License Agreement. Treat this as a blocking product/legal gate for hosted redistribution; separately verify WebSocket book continuity and regional derivative eligibility |
| Next 6 | Backpack | Public crypto Spot/perpetual metadata, mark/index/current funding, funding history and deep books can broaden basis and funding research; its depth protocol has an explicit REST/WS bridge | Crypto `SPOT` and `PERP` only: exact-decimal markets, mark/funding, bounded REST depth, then selected real-time depth. Exclude `IPERP`, `DATED`, `PREDICTION`, `RFQ` and tokenized-stock products until separately reviewed | Bootstrap from REST `lastUpdateId`, accept only contiguous WS `U..u`, and requery REST on a gap. Model the documented 100 ms delay on every non-post-only taker order as execution latency, not as available-book profit. Confirm Kazakhstan product access and hosted data-use/redistribution terms |
| Next 7 | WhiteBIT | Public Spot/perpetual metadata, current and historical funding, and a documented `past_update_id → update_id` book chain are technically useful for basis research | Public markets/futures/funding and one selected depth family, only after the data-use gate; label every book as excluding RPI liquidity | Require the first/full snapshot, exact `past_update_id` continuity and resubscribe on a gap. Public REST/WS depth omits RPI orders. WhiteBIT API terms grant personal use and exclude resale/commercial use, price collection and data mining without written consent, so hosted aggregation is blocked pending permission and Kazakhstan eligibility review |
| Next 8 | Phemex | Spot plus COIN-M and USDⓈ-M perpetual metadata, mark/index/current funding and funding history can add linear/inverse basis comparisons | Public product metadata, selected exact/scaled REST snapshots and funding first; WebSocket books remain research-only | The feed provides subscription snapshots, incremental messages, `sequence` and periodic snapshots, but the reviewed official contract does not state `previous + 1` continuity or a checksum. Do not infer loss detection. Terms license the API for transactions and reject other commercial use of API data; obtain written data-use approval and verify Kazakhstan/product eligibility |
| Excluded for Kazakhstan private live scope | Bitget | Public aggregation could be researched separately | None by default | Terms updated 2026-06-16 list Kazakhstan as a prohibited country. Do not build private execution; public use would still require a separate data-license/terms review |

Priority is based on scanner value **and** the quality of documented loss recovery, not market size
alone. A legal/data-license blocker can move any venue down the order without a code change.

### Kazakhstan and hosted-data gate for the second wave

Review date: **2026-07-14**. The official pages do not establish a legal or product entitlement for a
Kazakhstan operator. Absence from a restricted-country list is not permission:

- WhiteBIT says functions can depend on citizenship/residence and access location, while its API
  terms restrict commercial reuse. Written permission is required before a hosted/public scanner can
  aggregate its prices.
- Phemex's current enumerated restricted-territory list does not name Kazakhstan, but it contains a
  broader catch-all, makes service availability discretionary and restricts API data to the licensed
  purpose. Treat both regional eligibility and hosted data use as unresolved.
- Backpack's current supported-regions page does not list Kazakhstan among the named not-served
  regions, but explicitly says the list can change. That is not a guarantee that every Spot or
  perpetual product, API use or redistribution model is available.

Until the operator records venue confirmation for the deployment region, the specific products and
the intended hosted/open-source data use, these rows remain disabled planned candidates. They add no
private account, borrow, transfer or execution capability.

## How new venues improve the scanner

Adding a venue is useful only after instrument identity and executable books are proven. Then it can
feed several independent research families:

- cross-venue Spot↔Spot and Spot↔perpetual/future “double forks”;
- same-venue Spot↔perpetual/future basis and funding carry;
- same-venue triangular routes when three native markets and quantity conversions are verified;
- N-leg routes only when every leg has compatible units, fees, capacity, freshness and recovery;
- borrow/funding/network overlays as explicit costs, never inferred from a public ticker.

Equal ticker text is not economic identity. Quote/settlement currency, chain/network, linear versus
inverse contract, contract size, expiry, collateral and regional product must all be explicit. More
venues otherwise multiply false positives faster than real opportunities.

The initial exact BTC/ETH catalog is schema 1, version `2026-07-14.v1`, reviewed from 2026-07-14
through 2026-10-12. It covers only the explicit Spot/perpetual IDs normalized in the registered
venue fixtures. Adapter assertions are stripped before catalog application; an unknown, wrapped,
expiry-specific or field-mismatched instrument receives no `economicAssetId` and cannot join a
cross-venue route until a new reviewed catalog version is published.

## Mandatory acceptance gates for every candidate

1. Record the official documentation URL, review date, product/region and data-use terms before code.
2. Build a credential-free adapter with bounded payloads, timeouts, cancellation, resource-governor
   keys and exact symbol/contract/unit normalization.
3. Preserve decimal strings until validated; never infer contract value, stablecoin equivalence,
   exchange timestamp or funding interval.
4. Implement the venue's actual snapshot/delta protocol with connection generations. Any gap,
   checksum failure, crossed book, timestamp regression, overload or reconnect must invalidate the
   book and require a fresh snapshot.
5. Keep a stream research-only when the official protocol cannot prove loss detection. A locally
   increasing counter is not automatically a venue sequence.
6. Add recorded snapshot/update/gap/reconnect/checksum fixtures, malformed-payload tests, bounded
   output tests and an optional credential-free canary. A one-time canary is not soak evidence.
7. Add instrument identity, reviewed fee/funding schedule, freshness/skew and capacity gates before
   the venue can produce scanner candidates.
8. Add private trading only as a later, separately approved project with account snapshots, fills,
   fees, reconciliation, kill switch, test environment and legal review. Public registration must
   never enable it.

## Capability record required from every adapter

The manifest must declare public ticker/top-book/depth/trades; spot, margin, perpetual, dated future,
option and native spread; mark/index/last/candles; funding schedule/history, borrow and network status;
subscription limits, sequence/checksum and REST bootstrap; settlement/collateral and linear/inverse
units; private reads/execution/demo support; and eligibility-review date. Missing means `false`, not
“probably supported”.

The versioned public plugin boundary accepts only `public-read-only` descriptors whose factory takes
no credentials. Plugin certification, live canaries, private lifecycle conformance and operator
eligibility are separate gates.

## Official references

Current integrations:

- [Binance Spot API](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Binance USDⓈ-M Futures API](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)
- [Bybit instruments](https://bybit-exchange.github.io/docs/v5/market/instrument)
- [Bybit spread instruments](https://bybit-exchange.github.io/docs/v5/spread/market/instrument)
- [OKX API](https://www.okx.com/docs-v5/en/)
- [Gate API v4](https://www.gate.com/docs/developers/apiv4/ws/en/)
- [Hyperliquid WebSocket API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)
- [Deribit API](https://docs.deribit.com/)
- [Kraken Spot v2 book](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book)
- [Coinbase Advanced Trade WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- [dYdX Indexer WebSockets](https://docs.dydx.xyz/indexer-client/websockets)
- [dYdX full-node streaming](https://docs.dydx.xyz/nodes/full-node-streaming)
- [KuCoin order-book migration and sequencing](https://www.kucoin.com/docs-new/3470221w0)
- [MEXC Spot API and Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
- [MEXC Futures API](https://mexcdevelop.github.io/apidocs/contract_v1_en/)

Expansion candidates and legal gates:

- [Crypto.com Exchange API v1](https://exchange-developer.crypto.com/exchange/v1)
- [BitMEX WebSocket API](https://www.bitmex.com/app/wsAPI)
- [BitMEX API changelog](https://www.bitmex.com/app/apiChangelog)
- [Bitfinex WS v2 books](https://docs.bitfinex.com/reference/ws-public-books)
- [Bitfinex WebSocket requirements, sequence and checksum flags](https://docs.bitfinex.com/docs/ws-general)
- [Bitfinex derivatives API](https://docs.bitfinex.com/docs/derivatives)
- [Bitfinex API terms](https://www.bitfinex.com/legal/general/api-terms/)
- [Bitstamp API, funding, gap recovery and commercial-data notice](https://www.bitstamp.net/api/)
- [Gemini market-data API](https://developer.gemini.com/trading/rest-api/market-data)
- [Gemini WebSocket depth streams and gap recovery](https://developer.gemini.com/trading/websocket/streams)
- [Gemini derivatives API](https://developer.gemini.com/trading/rest-api/derivatives)
- [Backpack markets, depth, funding and WebSocket streams](https://docs.backpack.exchange/)
- [Backpack supported regions](https://support.backpack.exchange/exchange/exchange-account/identity-verification/supported-regions)
- [Backpack exchange trading rules and market-data boundary](https://support.backpack.exchange/legal/vara-disclosures/exchange-trading-rules)
- [WhiteBIT public market metadata](https://docs.whitebit.com/api-reference/market-data/market-info)
- [WhiteBIT futures and funding metadata](https://docs.whitebit.com/api-reference/market-data/available-futures-markets-list)
- [WhiteBIT funding history](https://docs.whitebit.com/api-reference/market-data/funding-history)
- [WhiteBIT WebSocket depth ordering and recovery](https://docs.whitebit.com/websocket/market-streams/depth)
- [WhiteBIT API terms](https://whitebit.com/terms/api)
- [WhiteBIT user agreement and regional boundary](https://whitebit.com/terms)
- [Phemex public products, funding and order-book protocol](https://phemex-docs.github.io/)
- [Phemex terms, regional and API-use boundary](https://phemex.com/help-center/phemex-terms-of-use)
- [Bitget terms](https://www.bitget.com/support/articles/360014944032-terms-of-use)
