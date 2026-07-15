# Deribit public adapter

This folder is an isolated, read-only Deribit JSON-RPC adapter. It is registered only in the
credential-free public venue registry and is exposed through `/api/market-data/deribit/*`; it is not
connected to the live basis scanner, chart selector, account state, or any order path.

## Trust boundary

- Only the allowlisted `public/get_instrument`, `public/get_instruments`, `public/ticker`, `public/get_order_book`, and `public/get_funding_rate_history` methods can leave the process.
- The transport accepts no API key, token, account identifier, private method, or order payload.
- JSON-RPC version, request id, result/error exclusivity, known timing extensions, HTTP status, maximum body size, timeout, cancellation, and endpoint payloads are validated fail closed.
- Capabilities explicitly report `privateExecution: false`, `borrow: false`, and `depositWithdrawal: false`.

## Units

Deribit uses different native `amount` units. Perpetual and inverse-future amounts are quote/USD units; option and linear-future amounts are base-asset units. `contract_size` remains separate metadata and is never silently applied to an already base-denominated book amount. `qty_tick_size` is used when published; otherwise the adapter records the conservative `min_trade_amount` fallback as the quantity step source.

Option price units are explicit: inverse option premiums use the settlement/base asset, while linear option premiums use the counter currency. Expiry, strike, call/put, European exercise, automatic exercise, economic cash settlement, and the current two-stage linear-option future-then-cash process are preserved in normalized metadata.

## Funding

Deribit perpetual funding is accrued continuously. `funding_8h` is exposed as an eight-hour reference estimate, but `scheduleVerified` remains `false`; `nextFundingTime` is a comparison horizon, not a claim that a discrete payment occurs then. Historical hourly observations preserve both `interest_1h` and `interest_8h`.

## Operational note

Deribit has no bounded bulk endpoint that returns executable prices *and* sizes for the complete
instrument universe. `tickers()` therefore fails explicitly with `unsupported` instead of turning
one anonymous HTTP request into an unbounded per-instrument JSON-RPC fan-out. Use `ticker()` for one
exact instrument. A future streaming integration would require separately bounded public WebSocket
ticker/book subscriptions, sequence recovery, and venue rate-limit evidence.
