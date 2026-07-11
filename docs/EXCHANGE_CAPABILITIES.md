# Exchange execution capability matrix

This matrix is deliberately conservative and describes code paths covered by
adapter/transport tests. It is not a mainnet-readiness claim. Live trading
remains **Experimental** and disarmed by default.

| Venue / market | Market | Limit | Conditional stop/TP | Exchange-held entry SL/TP | Private order/execution stream | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Paper spot/futures | Yes | Yes | Yes | Simulated locally | Synchronous simulated fills | Supported for testing |
| Binance spot | Yes | Yes | Adapter commands only | No protected strategy-entry guarantee | Futures stream is not a spot guarantee | Experimental; explicit inventory override |
| Binance USDⓈ-M linear | Yes | Yes | Stop-market / take-profit-market | Acknowledgement required; emergency close on rejection | `ORDER_TRADE_UPDATE` + REST polling fallback | Experimental |
| Binance inverse | No | No | No | No | No | Unsupported |
| Bybit spot | Yes | Yes | Adapter commands only | No protected strategy-entry guarantee | Linear stream is not a spot guarantee | Experimental; explicit inventory override |
| Bybit USDT linear | Yes | Yes | Trigger orders / trading stop | Acknowledgement required; emergency close on rejection | v5 order/execution + REST polling fallback | Experimental |
| Bybit inverse | No | No | No | No | No | Unsupported |

Private execution normalization preserves venue execution ID, cumulative and
incremental fill quantity, execution price, actual fee amount/asset and venue
realized PnL. Replayed execution IDs are idempotent. Unknown, conflicting or
regressing updates cannot advance durable order state.

## Operator checklist before any live use

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
