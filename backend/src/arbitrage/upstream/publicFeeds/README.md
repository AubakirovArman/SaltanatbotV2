# Continuous public research feeds

This folder connects credential-free public venue adapters
adapters to a bounded, reconnecting public WebSocket layer. It is research-only: there is no
credential, wallet, account or order method, and every route-family snapshot says
`executable: false`.

## Continuity contract

| Venue | Public book channel | Proof retained by this module | Funding observation |
| --- | --- | --- | --- |
| OKX | `books` | initial snapshot plus exact `prevSeqId == prior seqId`; empty same-sequence keepalives are allowed | `funding-rate`; interval is verified only from positive integral `fundingTime -> nextFundingTime` |
| Gate spot | `spot.obu` | full replacement plus contiguous `U/u` | none |
| Gate USDT perpetual | `futures.obu` | first/full replacement plus contiguous `U/u`; the parser also supports governed REST `with_id` bridging for the documented incremental shape | `futures.tickers`; current rate only, schedule remains unverified |
| Deribit | `book.<instrument>.100ms` | first full snapshot plus exact `prev_change_id == prior change_id` | `ticker.<instrument>.100ms`; 8h reference rate, continuous accrual, no invented discrete settlement |
| Hyperliquid | `l2Book` | each message is an independent full block snapshot; explicitly **not** sequence-verified | `activeAssetCtx`; current observation without a venue timestamp or invented horizon schedule |
| Kraken Spot | v2 `book` | lossless decimal decoding, exact subscribed-depth truncation and CRC32 of the top ten levels after every snapshot/update; the sequence is a connection-local ordinal scoped by generation | none |
| Kraken Futures | v1 `book` | native `seq` must advance, but is explicitly **not** called gap-free because the official contract does not promise contiguous per-product values | none; existing inverse funding remains REST-only |
| Coinbase Advanced | `level2` plus `heartbeats` | full snapshot, exact connection-global `sequence_num + 1` across every non-error L2/control/ignored/heartbeat envelope, snapshot-before-update and independent heartbeat-counter continuity; `market_trades` is never used as a book | none |
| dYdX Indexer | unbatched `v4_orderbook` | exact connection identity and contiguous `message_id`, but the view is explicitly non-canonical and non-route-ready because it is not the current block proposer's mempool | none; Indexer funding remains REST-only |
| KuCoin Spot/Futures | `obu` with `depth=increment@10ms`, `rpiFilter: 0` | generation-local welcome, bounded fatal UTF-8 decoding when KuCoin marks JSON as binary, self-seeded `O=C` snapshot, then exact range overlap `O <= prior C + 1` and advance `C > prior C`; only a positive safe sequence becomes route-ready | none; current/scheduled funding remains REST-only |
| MEXC Spot | binary `spot@public.aggre.depth.v3.api.pb@10ms` | first actual delta triggers a single-flight governed REST bridge into buffered `[fromVersion,toVersion]`, then `fromVersion = prior toVersion + 1`; open/ack and a REST-only seed never publish | none; funding remains REST-only |
| MEXC Futures | unmerged native JSON `push.depth` with `compress: false` | first actual delta triggers a single-flight governed REST seed, followed by exact `version = prior version + 1`; merged/zipped pushes are not accepted as continuity proof and open/ack or a REST-only seed never publish | none; current/settled funding remains REST-only |

OKX deprecated its JSON-book checksum in June 2026 and directs consumers to sequence IDs. This
module therefore does not pretend that fixed `checksum: 0` proves integrity. Hyperliquid has no
protocol sequence in `WsBook`, and Kraken Futures does not document a contiguous per-product
sequence. Both remain useful top-book/research signals, but `pairwiseBookFromContinuous` refuses to
label them route-ready. Kraken Spot is route-ready only after its CRC32 matches. A Coinbase
sequence-zero snapshot remains a research book; it becomes route-ready only after a positive L2
publication while the connection-global sequence has remained contiguous across every envelope.
The snapshot envelope timestamp is not compared with delta matching-engine `event_time`: Coinbase
documents epoch sentinels in snapshot rows and current production can deliver the first sequenced
delta event before the snapshot envelope time. Delta event-time monotonicity is still enforced from
the first delta onward.
KuCoin is route-ready only after the post-retirement self-seeded snapshot; a range gap, timestamp
regression, replacement snapshot, missing pong or reconnect withdraws the whole generation.
MEXC Spot/Futures start their single-flight REST seed only after the first real depth event is
buffered, closing the subscribe/snapshot race; ack/control traffic cannot start it. They are
route-ready only after a WebSocket event advances that governed seed. Binary decoder failure,
version gap, oversized buffer/frame or reconnect withdraws the generation, aborts pending REST and
ignores late completion from the stale generation.

Official protocol references:

- [OKX API books and sequence IDs](https://www.okx.com/docs-v5/en/)
- [OKX checksum deprecation](https://www.okx.com/en-us/help/okx-order-book-channels-checksum-field-deprecation)
- [Gate spot WebSocket API](https://www.gate.com/docs/developers/apiv4/ws/en/)
- [Gate futures local-book procedure](https://www.gate.com/docs/developers/futures/ws/en/)
- [Hyperliquid subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
- [Deribit order-book subscription](https://docs.deribit.com/subscriptions/orderbook/bookinstrument_nameinterval)
- [Deribit ticker subscription](https://docs.deribit.com/subscriptions/market-data/tickerinstrument_nameinterval)
- [Kraken Spot v2 book](https://docs.kraken.com/api/docs/websocket-v2/book/)
- [Kraken Spot v2 checksum](https://docs.kraken.com/api/docs/guides/spot-ws-book-v2/)
- [Kraken Futures book](https://docs.kraken.com/api/docs/futures-api/websocket/book/)
- [Coinbase Advanced WebSocket overview and sequence rules](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview)
- [Coinbase Advanced level2 and heartbeat channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels)
- [dYdX Indexer WebSocket API](https://docs.dydx.xyz/indexer-client/websockets)
- [dYdX non-canonical order-book and logical-offset rules](https://docs.dydx.xyz/interaction/data/watch-orderbook)
- [KuCoin public WebSocket welcome and ping lifecycle](https://www.kucoin.com/docs-new/websocket-api/base-info/introduction-uta)
- [KuCoin post-2026-07-15 Increment Best 500 order book](https://www.kucoin.com/docs-new/3470221w0)
- [MEXC Spot REST/Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
- [MEXC published Protobuf definitions](https://github.com/mexcdevelop/websocket-proto)
- [MEXC Futures REST/WebSocket and version rules](https://mexcdevelop.github.io/apidocs/contract_v1_en/)

## Runtime bounds and failure isolation

- `ContinuousPublicFeed` owns one instrument lifecycle. A malformed relevant payload, crossed
  reconstruction, sequence gap, silence timeout or reconnect withdraws that generation before any
  replacement is published.
- `ContinuousPublicFeedHub` shares one feed per stable instrument ID, caps total streams, caps each
  venue independently, caps listeners and evicts only idle entries. One venue/instrument
  invalidation cannot clear another entry.
- `processPublicStreamGovernor` admits connection attempts with per-venue queue-free budgets and a
  cooldown circuit. The hub caps live sockets; an attempt lease is released after the connection
  produces an accepted protocol message. Gate REST bridging separately consumes the existing
  process-wide per-venue REST budget for every protocol that requires snapshot bridging, including
  Gate incremental mode and MEXC Spot/Futures.
- Books retain exact native quantity units from registry metadata. Coinbase public channels alias
  most `*-USDC` subscriptions to `*-USD`, so those instruments are rejected except for the two
  officially documented public-channel exceptions. No symbol equality, unit
  conversion, funding horizon, capital, inventory, borrow, convergence or delivery assumption is
  synthesized.

## Route-family bridge

`ContinuousRouteFamilyDiscovery` subscribes to a caller-selected bounded set of normalized registry
instruments and continuously rebuilds the existing six-family deterministic candidate set. Only
gap-free sequence or checksum-proven books become `PairwiseBookSnapshot` values. Funding messages remain point-in-time
observations; they are not converted to the full-horizon funding assumptions required by
`evaluateRouteFamilies`.

Market-only entry economics also pass through the shared venue-clock boundary. A cross-venue row
requires calibrated corrected-local intervals for both public sources and fails closed on missing,
degraded, expired, future, stale or worst-case-skewed evidence. A same-venue row may explicitly use
`local-receipt-fallback`, which is labelled non-comparable across venues. The evaluator never
silently replaces calibrated-but-ineligible exchange time with receipt time.

`marketEconomics.ts` owns bounded candidate evaluation, evidence gates and deterministic ranking.
Exact native-step/base-quantity alignment and per-leg top-book projection live in
`marketEconomicsQuantity.ts`; finite-number edge arithmetic remains in
`marketEconomicsArithmetic.ts`. These internal modules do not add a public API surface.

The server instantiates the service with an empty set by default. Opening a stream requires the
operator-owned allowlist plus reviewed identity/fee overlays; browser callers cannot create or
change that configuration. `scripts/public-feed-canary.ts` is an optional credential-free
connectivity check and is not a soak, execution test or release guarantee.

## Verification

- `publicContinuousProtocols.test.ts` — deterministic venue snapshots, updates, funding and gap
  injection.
- `krakenCoinbaseContinuousProtocols.test.ts` — CRC32/decimal precision, connection-global Coinbase
  sequence interleaving across L2/control/ignored/heartbeat envelopes, sequence-zero route gating,
  snapshot-envelope/delta-event clock separation, USD/USDC identity, non-contiguous Futures
  boundary and reconnect generations.
- `dydxContinuousProtocol.test.ts` — unbatched subscription, exact connection/message continuity,
  bounded publication and the permanent non-canonical route-ready exclusion.
- `kucoinContinuousProtocol.test.ts` — welcome-before-subscribe, exact integer tokens, bounded
  snapshot/range continuity, ping/pong, failure injection and reconnect-generation withdrawal.
- `mexcSpotProtobufDecoder.test.ts` and `mexcContinuousProtocol.test.ts` — exact public PB wire tags,
  private oneof rejection, byte/update caps, native Futures `version + 1`, delta-triggered
  single-flight REST bridging, buffering while REST is pending, REST-only publication suppression,
  binary transport, cancellation and stale reconnect-generation withdrawal.
- `publicContinuousFeed.test.ts` — reconnect generation leases, governed Gate bridge, overload and
  per-venue isolation.
- `publicContinuousDiscovery.test.ts` — route-family bridge, stale/sequence rejection and the
  Hyperliquid atomic-snapshot boundary.
- `backend/tests/fixtures/public-feeds/` — small deterministic protocol fixtures derived from the
  official schemas, not claimed as live captures.
