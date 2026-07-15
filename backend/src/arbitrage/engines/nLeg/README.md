# Bounded N-leg cycle engine

`n-leg-v1` is a transport-free research engine for simple spot conversion cycles
with 4–8 legs. It complements, rather than replaces, the optimized three-leg
engine in `../triangular/`.

## Safety and accounting contract

- A node is the exact tuple `(venue, canonical assetId, native unitId)`. Equal
  display tickers do not connect different venues or accounting units.
- Each market declares side-specific fee schedule/tier identity and the exact
  fee asset. Input-asset and output-asset fees are conserved. A discount token
  or any third-asset fee fails closed because the engine has no external fee
  inventory or FX input.
- Every leg applies visible multi-level bid/ask depth, base lot step, minimum
  base quantity, minimum pre-fee quote notional and its fee before propagating
  output into the next leg. Lot residuals remain exposed as dust and are never
  credited to completed-cycle profit.
- Books must repeat the instrument/base/quote identity and be complete,
  sequence-verified, exchange-time verified, fresh, mutually synchronized and
  strictly sorted. REST top-book data is not accepted.
- Results are always `research-simulation`, `executable: false`. Sequential
  visible-depth arithmetic is not an atomic fill guarantee.

## Bounded graph and simulation work

`buildNLegGraph` enumerates simple directed cycles only. It forbids repeated
nodes and instruments, canonicalizes rotations while preserving direction, and
uses explicit market/cycle/traversal bounds. An oversized market universe is
rejected before topology construction. A bounded result reports `work.truncated`
and its reason; it never silently claims a complete universe.

`evaluateNLegCycle` caps cycle length, book levels, binary-search iterations and
total depth-walk steps. Both graph building and simulation accept an
`AbortSignal`. Limit violations reject or truncate explicitly.

The module performs no network, filesystem, credential, balance or order I/O.
Adapters must normalize and verify all metadata and book provenance before
calling it.
