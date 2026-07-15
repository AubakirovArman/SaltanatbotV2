# MEXC public adapter

This folder isolates two different MEXC market-data protocols behind one credential-free adapter.
The code contains no signing, API-key, account or order path, and its plugin descriptor is
`public-read-only`. The reducers are connected to the operator-allowlisted generic continuous
research runtime; that runtime remains browser read-only and globally `executable: false`.

`adapter.ts` uses the post-January-2026 `https://api.mexc.com` origin for both Spot and futures
REST. It normalizes Spot metadata/BBO/depth and linear USDT perpetual metadata/depth/funding where
the public schemas prove quantity units, contract size and settlement schedule. The perpetual bulk
ticker lacks bid/ask sizes, so it is rejected; single perpetual BBO is derived from bounded depth.

The streaming protocols are intentionally separate:

- `spotProtobufDecoder.ts` is a bounded explicit decoder for the exact public
  `PushDataV3ApiWrapper.publicAggreDepths` wire tags published by MEXC. It rejects every other
  wrapper oneof body, including private/account bodies. The continuous protocol may instead
  receive a protoc-generated decoder through the same interface, while retaining its independent
  binary-frame and update limits. Binary frames are never converted to UTF-8 before decoding.
- `spotProtobufBook.ts` accepts only objects decoded from MEXC's published Protobuf definitions on
  `wss://wbs-api.mexc.com/ws`. It buffers deltas while acquiring the REST snapshot, bridges
  `[fromVersion,toVersion]`, then requires `fromVersion = previous toVersion + 1`.
- `futuresBook.ts` explicitly subscribes with `compress: false` so merged/zipped pushes cannot hide
  intermediate versions. It implements native JSON `push.depth` absolute updates and requires
  every new `version` to equal the preceding version plus one. It is not reused for Spot Protobuf.

Both reducers cap levels/messages, delete zero-size levels, reject gaps/crossed books and require a
fresh REST snapshot after reconnect. Spot snapshots are marked bounded because unchanged levels
outside the REST snapshot cannot be reconstructed. Futures quantities remain contracts and
`contractSize` records the base amount per contract.

`mexcProtocol.ts` in the generic continuous-feed folder owns the native Spot/Futures socket,
application heartbeat, governed REST bootstrap and reconnect-generation boundary. Bootstrap is
protocol-triggered: open/ack/control traffic never starts REST; the first actual depth delta is
buffered and starts one single-flight snapshot request for that connection generation. Further
deltas remain buffered while REST is pending. Close/reconnect aborts that request and a late result
from an old generation is ignored. A REST snapshot alone is never published as
`source: public-websocket`: Spot/Futures become route-ready only after an actual WebSocket delta
advances the snapshot version under the documented continuity rule. Reconnect immediately
withdraws the prior generation. “Route-ready” here means eligible for read-only market research;
it is not permission to trade and does not prove balances, borrow, funding horizon, convergence,
exit liquidity or simultaneous fills.

MEXC publishes `baseSizePrecision` or `quoteAmountPrecision` as zero for some enabled Spot rows.
Those zeros are retained as the shared registry's explicit “minimum unknown” sentinel, never as
proof that an order has no minimum; an execution-grade rule refresh would still be required.

Official sources reviewed 2026-07-14:

- [MEXC Spot API and Protobuf WebSocket](https://mexcdevelop.github.io/apidocs/spot_v3_en/)
- [MEXC published Protobuf definitions](https://github.com/mexcdevelop/websocket-proto)
- [MEXC futures API and version rules](https://mexcdevelop.github.io/apidocs/contract_v1_en/)
- [MEXC futures API domain migration](https://www.mexc.com/announcements/article/futures-api-access-domain-update-17827791532974)
- [MEXC retirement of the old Spot WebSocket URL](https://www.mexc.com/en-NG/announcements/article/mexc-v3-websocket-service-replacement-announcement-17827791522393)
