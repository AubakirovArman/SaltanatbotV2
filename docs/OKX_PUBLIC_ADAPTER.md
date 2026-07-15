# OKX public REST adapter

Status: current read-only backend capability exposed through `/api/market-data/okx/*` and consumed by
the normalized `/api/instruments` registry, reviewed 2026-07-14. It is not connected to the live
arbitrage scanner, chart UI or private trading.

## Scope and safety boundary

The adapter is a credential-free implementation of OKX API v5 public REST. It supplies normalized
metadata and bounded snapshots available through shared interfaces and the public facade. It
does not accept API keys, sign requests, read an account, place orders or silently enable an OKX
venue in the frontend.

Implemented endpoints:

| Normalized operation | OKX endpoint | Product scope |
| --- | --- | --- |
| Instrument metadata | `GET /api/v5/public/instruments` | `SPOT`, `SWAP`, `FUTURES` |
| Ticker/top book | `GET /api/v5/market/tickers`, `GET /api/v5/market/ticker` | same |
| Depth snapshot | `GET /api/v5/market/books` | same, 1–400 levels |
| Current funding | `GET /api/v5/public/funding-rate` | `SWAP` only |
| Funding history | `GET /api/v5/public/funding-rate-history` | `SWAP` only, 1–100 rows |

The default origin is `https://www.okx.com`. A deployment may inject another official regional
HTTP(S) origin; credentials, query strings and fragments are rejected in the configured base URL.

## Normalization

Native `instId` remains `venueSymbol`; hyphens are not removed. Spot maps `baseCcy`/`quoteCcy` and
uses base-asset quantities. Derivatives map `uly`, `settleCcy`, `ctType`, `ctVal`, `ctMult` and
`ctValCcy`. Their lot rules and book quantities are explicitly marked as contracts. Dated futures
must include a positive `expTime`; an unknown contract direction or state is rejected rather than
defaulted to linear/trading.

`tickSz`, `lotSz` and `minSz` become price tick, quantity step and minimum quantity. OKX public
instrument metadata does not provide one universal minimum order notional for every product, so the
normalized `minimumNotional: 0` means unknown—not zero enforcement. Execution preflight must obtain
an execution-grade constraint before allowing an order.

Funding uses the current venue estimate and preserves its settlement timestamps, sign and optional
formula/method fields. `intervalMinutes` is emitted only when the difference between `fundingTime`
and `nextFundingTime` is a positive whole number of minutes no longer than 24 hours. No fixed
eight-hour assumption is used. Settled history is kept separate from the current estimate.

## Validation and failure behavior

- Every request has a finite timeout and propagates caller cancellation.
- HTTP 429, other HTTP failures, OKX non-zero `code`, malformed JSON and semantic validation have
  distinct error kinds.
- Payload size is bounded before/after reading; only an array in a successful OKX envelope is used.
- Crossed/locked top books, unsorted/crossed depth, invalid prices/sizes/timestamps and missing
  sequence IDs fail closed.
- A list may quarantine malformed rows only when at least one valid row remains. Empty or wholly
  malformed snapshots are rejected.
- Funding history failure does not erase a valid current schedule; current-funding failure rejects
  the whole funding result.
- The instrument registry caches the last successful result independently for each venue/product
  source. A failed OKX SWAP refresh therefore cannot erase the prior SWAP catalog while SPOT and
  FUTURES refresh normally; the failure remains visible in `sourceErrors`.

Recorded fixtures cover SPOT, linear/inverse SWAP, dated futures, top book, depth, variable four-hour
funding, history and error envelopes. Timeout, cancellation, rate-limit, malformed/crossed data and
partial-history/partial-registry failures are tested without calling OKX live.

## Deliberately deferred

- WebSocket top-book/depth stream, checksum/gap recovery and reconnect state machine;
- live scanner, WebSocket aggregation and frontend venue selection;
- margin, options, native spreads and public trades;
- private account, borrow, transfer and execution support;
- regional eligibility and a repeatable, recorded credential-free public canary.

Official reference: [OKX API v5](https://www.okx.com/docs-v5/en/).
