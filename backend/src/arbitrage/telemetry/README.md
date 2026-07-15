# Protected account economics telemetry

This folder is the read-only, authenticated evidence boundary between stored exchange credentials and
the arbitrage economics model. It never submits an order, borrow, repay, transfer, deposit or
withdrawal request.

- `transport.ts` contains GET-only HMAC transports. Every path is explicitly allowlisted, response
  bodies and request duration are bounded, and the existing exchange request guards still account
  for venue/IP limits. A non-allowlisted path is rejected before network I/O.
- `binance.ts` reads signed Spot commission components, USDⓈ-M commission/tier/BNB-burn state,
  cross-margin maximum borrow plus next-hourly rate, and deposit/withdraw network state.
- `bybit.ts` reads signed Spot/Linear fee rates, UTA collateral/borrow capacity and hourly rate, and
  per-coin deposit/withdraw network state.
- `stableFx.ts` reads public stablecoin best bid/ask through the process-wide public governor. Bybit
  provides a venue envelope timestamp. Binance Spot `bookTicker` does not, so its receive-time quote
  is retained as provenance but cannot by itself satisfy economics readiness.
- `service.ts` coalesces identical work, caps the number of symbols/assets, applies a per-venue
  concurrency budget and circuit breaker, and reuses only still-valid evidence under a
  credential-fingerprinted eight-entry cache. Three complete failures open the account source
  circuit for 30 seconds; expired evidence is never a fallback.
- `routes.ts` exposes `GET /api/trade/account-telemetry`. Registration occurs only after the trading
  router's session middleware and additionally requires the `admin` role.

Evidence expires after 30 seconds. A current signed rate is useful for ranking, but a future fill's
commission asset remains execution-dependent. Likewise, Binance/Bybit account endpoints expose
current borrow capacity and rate but do not prove that the loan cannot be recalled. The response
therefore keeps `feeAssets`, `borrowRecall` and global `executable` readiness false. Authenticated
fills and a separately verified borrowing contract remain mandatory before executable claims.

Official endpoint references are maintained in the user/operator guide:
[`docs/ACCOUNT_TELEMETRY.md`](../../../../docs/ACCOUNT_TELEMETRY.md).
