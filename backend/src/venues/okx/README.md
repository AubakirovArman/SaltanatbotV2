# OKX public REST adapter

`OkxPublicAdapter` implements an isolated, credential-free subset of OKX API v5:

- `SPOT`, `SWAP` and dated `FUTURES` instrument metadata;
- all-ticker and single-ticker top book;
- complete REST depth snapshots up to 400 levels;
- current funding estimate/schedule plus bounded funding history.

It does not implement margin metadata, options, public trades, WebSocket streaming, account reads or
private execution. Its capability manifest keeps all of those fields false.

## Files

- `adapter.ts` — endpoint routing, cancellation, timeout, payload bounds and exchange error mapping.
- `normalize.ts` — strict conversion from native rows to shared contracts.
- `types.ts` — deliberately loose raw response shapes; runtime validation lives in normalizers.
- `index.ts` — public exports.

Derivative book and lot sizes use `quantityUnit: "contract"`. `ctVal` and optional `ctMult` are
retained as effective contract metadata, including `linear`/`inverse`, settlement currency and
`ctValCcy`. Spot sizes use base units. Public instrument rows do not expose one universal minimum
notional, so `minimumNotional` remains `0` (unknown) and dependent order logic must fail closed or
obtain an execution-grade rule from a separate source.

Funding intervals are derived from each returned `fundingTime`/`nextFundingTime` pair. The adapter
does not assume eight hours because OKX may use shorter schedules. Current funding failure rejects
the request; history-only failure preserves the current estimate and records a source error.

The base URL is configurable for regional public API domains and test fixtures. It must be an
absolute HTTP(S) origin without credentials, query or fragment. Recorded tests make no live network
requests.
