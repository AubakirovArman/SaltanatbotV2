# Exchange execution capability matrix

This matrix is deliberately conservative and describes retained code paths
covered by adapter/transport tests. It is not an activation guide or a
mainnet-readiness claim. The current `public-http-paper` build rejects
`private-live`, credential use, signed requests, private streams and live
orders; `ENABLE_LIVE_SPOT=true` stops startup. Every non-paper row below is a
**dormant future/private-live reference** and is unreachable in this release.

| Venue / market | Market | Limit | Conditional stop/TP | Exchange-held entry SL/TP | Private order/execution stream | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Paper spot/futures | Yes | Yes | Yes | Simulated locally | Synchronous simulated fills | Supported for testing |
| Binance spot | Adapter code exists, but live submission is disabled | Adapter code exists, but live submission is disabled | Disabled | No protected strategy-entry guarantee | None; the USDⓈ-M stream cannot account for spot executions | Disabled until authenticated spot execution accounting exists |
| Binance USDⓈ-M linear | Yes | Yes | Stop-market / take-profit-market | Acknowledgement required; accepted entry is retained and paused on protection failure; separately identified emergency close | `ORDER_TRADE_UPDATE` + REST polling fallback | Dormant adapter; current runtime rejects activation |
| Binance inverse | No | No | No | No | No | Unsupported |
| Bybit spot | Yes | Yes | Adapter commands only; live replace/turnover are disabled | No protected strategy-entry guarantee | v5 `order` + `execution` with REST polling fallback | Dormant adapter; `ENABLE_LIVE_SPOT` is rejected by current runtime |
| Bybit USDT linear | Yes | Yes | Trigger orders / trading stop | Acknowledgement required; accepted entry is retained and paused on protection failure; separately identified emergency close | v5 order/execution + REST polling fallback | Dormant adapter; current runtime rejects activation |
| Bybit UTA cross collateral | Account snapshot + explicit collateral switch | Manual variable-rate borrow | No-conversion repay by default | IMR/MMR, funded-collateral and 80% borrow-usage guards | Signed V5 account APIs + audit log | Dormant future reference; every private/account mutation is rejected |
| Bybit inverse | No | No | No | No | No | Unsupported |

Private execution normalization preserves venue execution ID, cumulative and
incremental fill quantity, execution price, actual fee amount/asset and venue
realized PnL. Replayed execution IDs are idempotent. Unknown, conflicting or
regressing updates cannot advance durable order state.

Every risk-increasing live order must carry an explicit positive base `qty` before preflight. Quote,
deposit and balance-percentage quantity forms remain available to paper/general command resolution,
but they cannot reach a risk-increasing live submit. Durable reservations remain active for
`accepted`, `partially_filled` and `filled`-but-not-accounted journal rows. Spot sells separately
reserve attributed inventory so concurrent closes cannot sell the same quantity twice.

Live `replace` and `turnover` are disabled on every venue/market until each child action has an
independent durable lifecycle. Cancelled/expired rows retain unaccounted partial fills; legacy
replaced rows stay reserved conservatively. Futures exposure is the maximum of venue gross positions
and the durable fill-accounted shadow quantity. Matched venue/local orders use maximum quantity/price,
identity conflicts fail closed, live collision `override` is forbidden, and a terminal REST status
without authenticated execution accounting pauses the bot.

Live starts are serialized by exchange+symbol. Protection failure after an accepted entry does not
turn that entry into a rejection or release its reservation: managed state remains paused, and the
best-effort reduce-only emergency close uses a distinct `…-safety` client ID plus its own venue order
ID. A missing ID or close failure is explicit. Likewise, an accepted ordinary live close leaves the
managed position intact and paused until authenticated execution accounting proves the fill.

## Future security-review checklist before any live release

These are future release gates, not current operator steps. Do not enter keys,
arm adapters or attempt private exchange access in `public-http-paper`.

1. Keep withdrawal permission disabled and enable exchange IP allowlisting.
2. Verify encrypted keys, host NTP/chrony and the global live-trading kill switch.
3. Run unit/contract/E2E CI and the protected opt-in exchange testnet read smoke.
4. Validate on real-provider candles, backtest and paper; review Pine fidelity
   diagnostics and report data gaps.
5. Confirm market type, filters, leverage, position mode, fee asset,
   quantity/notional limits and every protection acknowledgement.
6. Rehearse restart reconciliation, private-stream disconnect/poll fallback,
   timeout/unknown outcome, duplicate execution and rejected protection.
7. Arm live only for intentionally tiny operator-approved exposure and keep the
   order journal visible. Disarm on any unknown state.

The proposed continuous 7–14-day Binance/Bybit testnet soak is explicitly
excluded from current P0–P2 scope by project decision. This checklist therefore
does not upgrade the project to mainnet-ready status.
