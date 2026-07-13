# Arbitrage market scanner

This module aggregates public, credential-free best bid/ask snapshots for Binance and Bybit.

- `service.ts` owns bounded concurrent venue reads, normalization, the two cross-venue routes,
  shared two-second caching and a maximum 30-second stale fallback.
- `routes.ts` validates public query limits and exposes the read-only handler.
- `types.ts` owns backend response/domain contracts.

The executable comparison is always **buy spot at ask** on one venue and **short perpetual at bid**
on the other. Funding is reported but is not added to the edge because the holding period is unknown.
The service never places orders, reads accounts or requires exchange keys.
