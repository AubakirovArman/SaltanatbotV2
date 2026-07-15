# dYdX public fixtures

Recorded-shape, deterministic fixtures cover the public Indexer market/order-book/funding
envelopes, unbatched `v4_orderbook` logical sequencing and decoded full-node orderbook batches.
They contain no wallet, subaccount, signature or private-node credentials. REST book prices are
research observations; the WebSocket fixture demonstrates offset-based uncrossing rather than a
claim that the Indexer sees the current block proposer's canonical mempool.
