# dYdX public adapter

This folder is a credential-free, public/read-only integration boundary.

- `transport.ts` allowlists bounded Indexer market, selected-book and funding `GET` routes.
- `normalize.ts` preserves native metadata/units and labels REST books non-canonical research-only.
- `adapter.ts` implements the shared public venue contract for perpetuals only.
- `plugin.ts` provides the versioned zero-credential public plugin descriptor; registration is
  intentionally external to this folder.
- `indexerBook.ts` reduces an unbatched `v4_orderbook` subscription with snapshot, connection,
  contiguous `message_id` and logical-offset uncrossing rules; the generic public-feed module now
  owns the bounded socket wrapper around this reducer.
- `indexerProtocol.ts` strictly decodes the official snake-case unbatched WebSocket envelope.
- `nodeBook.ts` reduces already decoded full-node batches, separating optimistic exec modes from
  `execMode=7` checkpoints and supporting explicit optimistic rollback.
- `types.ts` contains dYdX-specific provenance/finality extensions; `validation.ts` centralizes
  fail-closed parsing.

The venue reducers themselves open no socket. The generic wrapper opens only the public Indexer
WebSocket; Indexer continuity does not prove the block proposer's mempool, and one full node's
off-chain book is not globally canonical. Both remain `routeReady: false`. See
[`docs/DYDX_PUBLIC_ADAPTER.md`](../../../../docs/DYDX_PUBLIC_ADAPTER.md) for the capability boundary,
remaining integration and official references.
