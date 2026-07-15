# Account economics telemetry

Status: implemented as a protected, read-only P0 evidence API for Binance and Bybit. It is research
and operator telemetry, not an order-execution or mainnet-readiness claim.

## Endpoint and access boundary

`GET /api/trade/account-telemetry` is mounted inside the existing trading session boundary and
requires the `admin` role. Keys are loaded only from encrypted server settings; the request cannot
supply credentials, and the response never returns keys, signatures or secrets. The route does not
require live trading to be armed because every upstream operation is GET-only.

Query parameters are intentionally small:

| Parameter | Default | Hard bound |
| --- | --- | --- |
| `venues` | `binance,bybit` | Binance and/or Bybit, at most 2 |
| `symbols` | `BTCUSDT,ETHUSDT` | 1–2 native symbols |
| `assets` | `BTC,USDT,USDC` | 1–4 assets |
| `stableAssets` | `USDC` | 1–3 non-USDT assets |

Example after creating an authenticated admin session:

```text
GET /api/trade/account-telemetry?symbols=BTCUSDT,ETHUSDT&assets=BTC,USDT,USDC&stableAssets=USDC
```

The response contains `venues`, `stablecoinFx`, bounded `issues`, a private governor snapshot and an
explicit `readiness` object. `Cache-Control: private, no-store` prevents account-derived evidence
from entering a shared cache.

## Evidence collected

| Venue | Fee evidence | Borrow evidence | Transfer evidence | Stablecoin FX |
| --- | --- | --- | --- | --- |
| Binance | Spot standard/special/tax side components and BNB discount; USDⓈ-M maker/taker/RPI rate, fee tier and BNB burn status | Cross-margin current maximum borrow and next-hourly rate, annualized linearly for comparison | Per-network deposit/withdraw status, fixed fee, limits, confirmations, busy flag and documented arrival minutes | Spot book ticker; receive-time provenance only |
| Bybit | Current signed Spot and Linear maker/taker rates | UTA `availableToBorrow`, maximum, hourly rate, borrowable and usage status | Per-coin chain status, fixed/percentage fee, limits and confirmations | Spot ticker with Bybit envelope time |

Every evidence record has `source`, schema `version`, `asOf`, `validUntil`, `timestampQuality` and
`fresh`. The default validity interval is 30 seconds. Invalid, future-skewed, expired, oversized or
schema-incompatible responses never become usable evidence. There is no stale-success fallback.

## Browser workflow

An authenticated administrator can open **Trade → Settings → Account economics evidence** and issue
the same bounded refresh without exposing credentials to JavaScript. The EN/RU/KK panel validates
the response again at the browser boundary, rejects unsafe readiness flags, crossed FX books,
unsupported versions and unbounded collections, and renders semantic fee, borrow, transfer-network
and FX tables. It never persists the account snapshot in browser storage and has no order action.
Non-admin sessions do not render the panel.

## Conservative readiness rules

- A negative signed maker/taker rate is marked as a verified rebate. Zero or positive rates are
  marked `none`; the code never infers a rebate from a public fee table.
- Binance Spot side-dependent standard, special and tax components are retained. `makerBps` and
  `takerBps` use the more expensive buy/sell side before any conditional discount.
- A discount asset such as BNB is reported only when the signed account endpoint exposes it. The
  actual commission asset remains `execution-dependent` until an authenticated fill arrives, so
  `feeAssets` and `usableForSettlementAccounting` remain false.
- Current borrow amount and rate can support projected-cost ranking. Neither venue endpoint proves a
  non-recallable facility, so `recallStatus` is `unknown`, `borrowRecall` is false and routes that
  require non-recallable borrow must fail closed.
- A transfer network is usable only when deposit and withdrawal are both enabled, the fixed fee is
  parseable, evidence is fresh and Binance does not mark the network busy. Route construction must
  still match equivalent network identities on both venues.
- Binance REST book ticker has no venue timestamp. It is visible for provenance but cannot satisfy
  stablecoin economics readiness alone. A fresh Bybit venue-timestamped quote can satisfy the
  requested asset's FX evidence gate.
- Global `readiness.executable` is deliberately always false. This API supplies evidence to research
  and ranking; it cannot replace sequence-verified depth, capital reservations, authenticated fill
  accounting, transfer arrival proof or an explicit borrow contract.

## Bounded I/O and failure handling

The API coalesces identical concurrent refreshes, reuses only evidence that is still inside its
30-second validity interval (the bounded cache key changes with the configured credentials), allows
at most one refresh per private venue and at most three internal HTTP reads at once. Each fetch has a
five-second deadline; the complete refresh has a twenty-second deadline. Payloads are bounded per
endpoint (the Binance all-coins response has the largest explicit cap). Three consecutive total
venue failures open a 30-second circuit; partial responses remain `partial`, list their issues and
never masquerade as complete. Expired evidence is never used as a failure fallback.

## Official API references

- Binance [Query Commission Rates](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints#query-commission-rates-user_data), [Wallet Trade Fee](https://developers.binance.com/docs/wallet/asset/trade-fee), [All Coins' Information](https://developers.binance.com/docs/wallet/capital/all-coins-info), [Margin borrow/rate endpoints](https://developers.binance.com/docs/margin_trading/borrow-and-repay/Query-Max-Borrow), and [USDⓈ-M account/commission configuration](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/User-Commission-Rate).
- Bybit [Get Fee Rate](https://bybit-exchange.github.io/docs/v5/account/fee-rate), [Get Collateral Info](https://bybit-exchange.github.io/docs/v5/account/collateral-info), [Get Coin Info](https://bybit-exchange.github.io/docs/v5/asset/coin-info), and [Get Tickers](https://bybit-exchange.github.io/docs/v5/market/tickers).
