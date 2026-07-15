# KuCoin and MEXC modern public adapters

Status: public/read-only adapters registered in the shared process registry, public HTTP facade,
generic SDK path, instrument catalog and REST governor; official documentation reviewed 2026-07-14.
Recorded fixtures and deterministic failure/reconnect tests are implemented. KuCoin and MEXC now
have bounded runtime socket/protocol-factory/hub paths. Both Spot targets passed the 2026-07-14
local schema-v3 credential-free canary; repeated scheduled evidence and browser venue workflows
remain. This is research market data, not private execution, soak or mainnet readiness.

Both venues participate in the existing dynamic venue/source filters of the generic read-only
continuous browser view. Neither has a dedicated venue workflow, diagnostic page or chart selector;
those UX additions are separate from the already connected socket/factory/hub paths.

## Capability boundary

| Venue | Implemented | Explicitly unsupported |
| --- | --- | --- |
| KuCoin | Spot and linear USDT perpetual metadata, bulk/selected executable BBO, bounded REST depth, current/predicted/settled funding; bounded Spot/Futures public sockets for post-retirement `increment@10ms` books | retired `depth=increment`, inverse/delivery contracts, account/private API, orders, borrow/transfers |
| MEXC | Spot and linear USDT perpetual metadata, Spot bulk/selected BBO, selected perpetual BBO via depth, bounded REST depth, current/settled funding; bounded Spot Protobuf decoder/socket and separate Futures `version + 1` socket | retired Spot JSON WebSocket, size-less perpetual bulk BBO, account/private API, orders, borrow/transfers |

Both manifests set `privateExecution`, `borrow` and `depositWithdrawal` to `false`. Their versioned
plugin factories accept transport controls only and contain no credential/signing surface.

## KuCoin protocol and units

The streaming reducer accepts only `obu` messages with `depth=increment@10ms`. This is the mode
KuCoin introduced on 2026-06-17 to replace the legacy incremental channel retired on 2026-07-15.
It requires an initial `snapshot` where `O=C`; later absolute deltas must satisfy
`O <= previous C + 1` and `C > previous C`. Zero size removes a level. Reconnect clears the
generation and requires another snapshot. Both sides are capped at 500 levels.

The shared continuous protocol connects directly to the documented credential-free
`wss://x-push-spot.kucoin.com` or `wss://x-push-futures.kucoin.com` endpoint. It waits for the
generation-local `welcome`, validates its bounded keepalive interval, sends only the scoped
`obu`/`rpiFilter: 0` subscription and uses application-level ping/pong. Native `O`, `C`, `M`, `P`
and pong timestamp integer lexemes are preserved before parsing. A book can enter the scanner's
route-ready input only after the self-seeded snapshot establishes a positive safe sequence; a gap,
timestamp regression, replacement snapshot, malformed/oversized message, missing pong or reconnect
withdraws the generation. This still does not prove fills, account state or mainnet readiness.
Real KuCoin sockets may flag JSON market-data payloads as binary frames. Those frames pass a 2 MiB
cap and fatal UTF-8 decoding before the same lossless parser; invalid byte sequences fail closed
instead of being replaced with Unicode replacement characters.
KuCoin's current UTA introduction also labels the API under active development and says not to use
it for production live trading; this integration therefore remains public research-only even when
a sequence proof is valid.

Spot book quantities are base units. Perpetual book quantities are contracts and `multiplier` is
preserved as the base amount represented by one contract. Only non-expiring, non-inverse,
USDT-quoted/settled products are normalized; other rows are quarantined rather than guessing
inverse quote-value units. The current funding response proves `granularity`, `fundingTime`, cap and
floor; history points remain settled values.

## MEXC protocols and units

MEXC Spot uses the replacement `wss://wbs-api.mexc.com/ws` service and published Protobuf schemas.
The binary transport never coerces a frame to text. Its bundled explicit decoder accepts only the
published public `PushDataV3ApiWrapper.publicAggreDepths` wire tags and rejects every other oneof
body, including private/account payloads. A protoc-generated decoder can be injected through the
same narrow interface while frame/update caps remain independently enforced. Open/ack/control
traffic does not start REST. The first actual depth delta is buffered and triggers one single-flight
`/api/v3/depth` request for that connection generation; further deltas remain buffered while it is
pending. The reducer bridges the snapshot version into `[fromVersion,toVersion]`, and then requires
`fromVersion = previous toVersion + 1`. The snapshot is explicitly bounded: unchanged levels
outside the REST response cannot be reconstructed.

MEXC Futures remains a different native JSON `push.depth` protocol. The subscription explicitly
sets `compress: false`: MEXC documents `true` as merged/zipped pushes, which cannot prove that every
intermediate version was observed. After a REST snapshot, every new unmerged
event must have `version = previous version + 1`; sizes are absolute contract counts and zero
removes a level. The two reducers share no sequence assumptions. Both fail closed on gaps, crossed
books, empty sides, oversized buffers/messages and generation changes.

Both sockets are registered in the shared hub and use the process-wide MEXC REST/WebSocket
governors. Deferring REST until the first depth delta closes the subscribe/snapshot race. Close or
reconnect aborts the generation's pending request, and any late stale completion is ignored. A REST
snapshot alone is never mislabeled as WebSocket evidence: publication waits until a real event
advances its version. Only a fresh positive safe version in the current generation may enter
route-ready research. The surrounding discovery is still `readOnly`, `research-only` and
`executable: false`; route-ready does not grant order permission.

The REST transport defaults both products to `https://api.mexc.com`, reflecting the January 2026
futures-domain migration. `contractSize`, `priceUnit`, `volUnit` and `minVol` prove linear perpetual
units. `collectCycle` (hours) and `nextSettleTime` prove the funding schedule. Since the bulk
perpetual ticker does not publish executable bid/ask sizes, the adapter rejects it and derives a
selected BBO from bounded depth.

Some enabled MEXC Spot rows publish zero `baseSizePrecision`/`quoteAmountPrecision`. Zero is kept as
the registry's explicit “minimum unknown” sentinel, not interpreted as absence of a venue minimum.

## Resource and failure policy

- anonymous `GET` only; no authorization/key/signature headers;
- 8-second default timeout and caller abort propagation;
- 4 MiB response ceiling and eight queue-free concurrent requests per adapter;
- KuCoin REST output depth 1–100; MEXC output depth 1–500;
- list/source, protocol-message, level and pre-snapshot buffer caps;
- structured cancellation, timeout, local/HTTP rate-limit, HTTP, exchange and validation errors;
- empty, wholly malformed, identity-inconsistent, unsorted, crossed or locked books fail closed.

## Evidence and remaining integration

`backend/tests/kucoinPublicAdapter.test.ts`, `backend/tests/mexcPublicAdapter.test.ts` and
`backend/tests/modernVenueBookProtocols.test.ts` cover recorded metadata/BBO/depth/funding fixtures,
native units, timestamps, plugin authority, gaps, stale messages, zero deletes, reconnect,
retired/wrong protocol rejection, timeouts, cancellation, overload and exchange/HTTP failures.

`backend/tests/kucoinContinuousProtocol.test.ts` additionally covers welcome-before-subscribe,
Spot/Futures endpoint selection, exact numeric-token preservation, OBU subscription scope,
snapshot/range proof, overlap, replacement/gap/time-regression invalidation, hard level/message
bounds, binary-marked JSON through fatal UTF-8 decoding, malformed-byte rejection, application
ping/pong and reconnect generation withdrawal.

`backend/tests/mexcSpotProtobufDecoder.test.ts` and
`backend/tests/mexcContinuousProtocol.test.ts` cover exact public wire tags, rejection of other
oneof bodies, binary byte/update caps, both native subscriptions/heartbeats, delta-triggered
single-flight REST bridging, buffering during REST, REST-only publication suppression, exact
Futures `version + 1`, cancellation and stale reconnect-generation withdrawal.

The expanded 2026-07-14 live run passed both selected Spot targets. It exposed KuCoin's
binary-marked JSON frames and the MEXC subscribe/snapshot race; the bounded fatal UTF-8 path and
delta-triggered single-flight REST bridge above are their deterministic regression coverage.
Remaining work is browser-specific venue workflows, repeated scheduled canary artifacts and
ongoing regional/terms review. One public observation is not soak or readiness evidence. Streaming
funding remains REST-only. Bitget private connectivity remains excluded; this slice neither
changes that legal boundary nor adds any private trading path.

## Official sources

- KuCoin: [public WebSocket welcome/ping/subscription lifecycle](https://www.kucoin.com/docs-new/websocket-api/base-info/introduction-uta),
  [new UTA order book](https://www.kucoin.com/docs-new/3470221w0),
  [Spot symbols](https://www.kucoin.com/docs-new/rest/spot-trading/market-data/get-all-symbols),
  [Futures symbols](https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-all-symbols),
  [current funding](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-current-funding-rate)
  and [public funding history](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-public-funding-history).
- MEXC: [Spot REST/Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/),
  [published Protobuf definitions](https://github.com/mexcdevelop/websocket-proto),
  [Futures REST/WebSocket](https://mexcdevelop.github.io/apidocs/contract_v1_en/),
  [futures domain migration](https://www.mexc.com/announcements/article/futures-api-access-domain-update-17827791532974)
  and [old Spot WebSocket retirement](https://www.mexc.com/en-NG/announcements/article/mexc-v3-websocket-service-replacement-announcement-17827791522393).
