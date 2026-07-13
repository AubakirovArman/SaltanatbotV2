# Arbitrage screener

This folder owns the read-only cross-exchange spot/perpetual scanner.

- `client.ts` is the same-origin public API contract.
- `ArbitrageScreener.tsx` owns polling, local filters and the semantic results table.
- `text.ts` contains compile-time complete EN/RU/KK copy.
- `loadArbitrageScreener.ts` keeps the workspace out of the initial chart bundle.

The screen never places orders. It compares the spot ask required to buy with the perpetual bid
available to short on the other exchange. Funding, transfer delay and liquidation risk are shown as
explicit boundaries and are not presented as guaranteed profit.
