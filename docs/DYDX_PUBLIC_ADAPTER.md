# dYdX public and chain-aware market data

Status: current shared-facade read-only adapter plus a generic continuous **research-only** Indexer
socket, reviewed 2026-07-14.

`backend/src/venues/dydx` contains a credential-free dYdX Indexer adapter for perpetual metadata,
one selected top book/depth snapshot and current plus historical funding. It also contains pure
reducers for the Indexer `v4_orderbook` channel and decoded full-node order-book batches. Nothing in
the folder accepts a wallet, mnemonic, private key, subaccount, signature or order request.

The adapter is registered in the shared public venue facade, process REST governor and normalized
instrument registry. The generic continuous hub can now open one operator-allowlisted public
Indexer stream per selected instrument, governed by the same connection, listener, payload,
generation and idle bounds as the other venues. It reaches the browser through the existing dynamic
venue/source filters in the read-only continuous view; there is no dedicated dYdX workflow or chart
selector. Connection does not upgrade the book: every dYdX observation remains non-canonical,
research-only and `routeReady: false`.

## Indexer REST boundary

The transport permits only bounded `GET` requests to:

- `/v4/perpetualMarkets` for market metadata and the current `nextFundingRate` estimate;
- `/v4/orderbooks/perpetualMarket/:ticker` for one selected book;
- `/v4/historicalFunding/:ticker?limit=…` for at most 100 settled funding observations.

Requests have caller cancellation, a finite timeout and a 4 MiB default response cap. The default
origins are the official mainnet and testnet Indexers. A custom origin cannot contain credentials,
a path, query or fragment. No authorization header is created.

Metadata retains native `clobPairId`, tick/step size, base-sized quantity units, USD quote and USDC
settlement. Market status is fail-closed: only documented states are accepted, and limited states
such as `POST_ONLY` are not labeled fully trading. Invalid rows are quarantined only while at least
one valid row remains.

## Why the Indexer book is research-only

dYdX documents that each block proposer has a different mempool and therefore a different
canonical order book for that block. The Indexer/front end cannot directly observe that exact
book, and Indexer prices can temporarily cross. Consequently every REST book returns:

- `canonical: false`;
- `executable: false` and `executionStatus: research-only`;
- `sequenceAvailable: false`;
- `timestampSource: local-receive` because the REST response has no exchange event timestamp.

A crossed REST snapshot is rejected because it contains no logical offsets with which to uncross
safely. The adapter never invents a sequence or venue timestamp.

The unbatched WebSocket path first binds the documented `connected` identity, sends only
`v4_orderbook` with `batched: false`, starts only from `type=subscribed`, requires contiguous
`message_id` values and invalidates the generation on a gap or connection change. It implements the
documented logical-offset uncrossing rule, including equal-offset quantity subtraction. Even with a
continuous message sequence its view remains `canonical: false` and `routeReady: false`: message
order proves local subscription continuity, not the current proposer's mempool. The common wire
view therefore labels it `sequence-observed`/`dydx-indexer-message-id`, uses local receipt only to
age the observation, and is rejected by route-ready conversion and market economics.

## Full-node finality reducer

`DydxNodeBookReconciler` consumes already decoded, bounded batches with `block_height`, `exec_mode`,
snapshot and place/fill/remove operations. It discards updates before a snapshot, stores absolute
filled quantums, bounds orders/operations, rejects unsafe integer quantities and invalidates a
finalized-height regression. `execMode=7` creates a finalized checkpoint; other modes remain
optimistic. Later optimistic changes can be discarded back to the last finalized checkpoint.

This reducer does not open gRPC or WebSocket connections. dYdX recommends full-node streaming only
against an operator's own node, and the node's off-chain order book may still differ from other
nodes. Thus even a finalized checkpoint stays `routeReady: false`. A production integration still
needs the official protobuf decoder, owned-node authentication/network policy, reconnect snapshots,
generation handling, process resource governance and repeatable node/reorg evidence.

## Funding semantics

The current estimate comes from `perpetualMarkets.nextFundingRate`; settled points retain exact
`effectiveAt`, `effectiveAtHeight`, price and rate. The market schema describes a one-hour funding
rate, but the row does not include the estimate's exact effective timestamp. The adapter therefore
uses the next UTC-hour boundary as a visible local inference and sets `scheduleVerified: false`.
Historical points are labeled `indexer-settled` and are not replaced by that estimate.
The continuous Indexer socket publishes books only. It does not synthesize or stream funding;
funding observations remain bounded REST data with the schedule limitation above.

## Verification

```bash
npx vitest run backend/tests/dydxPublicAdapter.test.ts backend/tests/dydxContinuousProtocol.test.ts
npm run check --workspace @saltanatbotv2/backend
npm run docs:check
```

Fixtures cover metadata quarantine, bounded REST books/funding, timeout/cancel/rate-limit/payload
failures, message gaps, connection generations, crossed/equal-offset books, optimistic apply/revert,
finality, height regression, unknown orders, pair identity and work bounds. They are deterministic
contract evidence, not a live Indexer/node availability or mainnet-execution claim.

## Official references

- [Indexer HTTP API](https://docs.dydx.xyz/indexer-client/http)
- [Indexer WebSocket API](https://docs.dydx.xyz/indexer-client/websockets)
- [Watch orderbook and logical-offset uncrossing](https://docs.dydx.xyz/interaction/data/watch-orderbook)
- [Full Node gRPC Streaming](https://docs.dydx.xyz/nodes/full-node-streaming)
- [Perpetual market schema](https://docs.dydx.xyz/types/perpetual_market)
