# Arbitrage screener

This folder owns the read-only cross-exchange spot/perpetual scanner.

- `client.ts` validates the same-origin REST/WebSocket contracts.
- `useArbitrageStream.ts` owns reconnect, visibility pause and REST fallback behavior.
- `ArbitrageScreener.tsx` coordinates local filters, alerts, depth requests and paper state.
- `ArbitrageTable.tsx`, `ArbitrageControls.tsx` and `ArbitragePaperPanel.tsx` own focused UI regions.
- `fees.ts` and `paper.ts` are pure, persisted browser models with no execution path.
- `text.ts` contains compile-time complete EN/RU/KK copy.
- `loadArbitrageScreener.ts` keeps the workspace out of the initial chart bundle.

The screen never places orders. It compares the spot ask required to buy with the perpetual bid
available to short on the other exchange. Funding, transfer delay and liquidation risk are shown as
explicit boundaries and are not presented as guaranteed profit. Depth requests are user-triggered
and paper entry fails closed unless both visible books cover the configured notional.
