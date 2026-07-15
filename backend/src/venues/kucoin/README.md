# KuCoin public adapter

This folder is an isolated, credential-free KuCoin market-data slice. Nothing here signs requests,
reads an account or places an order, and the plugin descriptor advertises `public-read-only`
authority only. The adapter is registered in the shared credential-free registry and its selected
Spot/perpetual book protocol is wired into the bounded continuous public-feed factory/hub. That
research surface still cannot authorize account or order actions.

`adapter.ts` exposes bounded Spot and linear USDT perpetual metadata, executable BBO, REST depth
and the documented perpetual funding schedule/history. `transport.ts` permits anonymous `GET`
requests only, caps response size and concurrency, validates both KuCoin origins and classifies
timeout/cancellation/rate/HTTP/exchange failures. `normalize.ts` owns strict unit conversion.

`orderBook.ts` implements only the post-15-July-2026 `obu` mode `depth=increment@10ms`: the first
message must be a snapshot (`O=C`), later deltas must overlap `last C + 1`, updates are absolute and
zero removes a level. The retired `depth=increment` mode is rejected explicitly. A reconnect resets
the generation and requires a new snapshot. Both sides are capped at the venue's documented 500
levels and crossed, empty or discontinuous books fail closed.

`../../arbitrage/upstream/publicFeeds/kucoinProtocol.ts` waits for the public socket `welcome`, then
sends only `obu`, `depth=increment@10ms`, `rpiFilter: 0` to the documented Spot/Futures endpoint.
It preserves integer sequence/timestamp lexemes, uses application ping/pong and publishes a
sequence-verified generation only after the self-seeded snapshot. Gap, replacement snapshot,
timestamp regression, missing pong or reconnect withdraws that generation. There is no repeatable
live canary or mainnet-readiness claim yet.
KuCoin currently marks some JSON market-data frames as WebSocket binary. The same lossless JSON
parser is used only after a bounded fatal UTF-8 decode; malformed bytes are never replaced silently.

Only non-expiring, non-inverse USDT-settled futures rows are normalized. Futures sizes remain
contracts; `multiplier` is the base amount per contract. Inverse and dated contracts are
quarantined rather than guessing quote-value units. SPOT sizes remain base units. Receipt time is
used only where the official REST response has no exchange-authored timestamp.

Official sources reviewed 2026-07-14:

- [KuCoin UTA order-book snapshot/delta protocol](https://www.kucoin.com/docs-new/3470221w0)
- [KuCoin public WebSocket welcome/ping lifecycle](https://www.kucoin.com/docs-new/websocket-api/base-info/introduction-uta)
- [KuCoin Spot symbols](https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-all-symbols)
- [KuCoin futures symbols](https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-all-symbols)
- [KuCoin current funding](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-current-funding-rate)
- [KuCoin public funding history](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-public-funding-history)
