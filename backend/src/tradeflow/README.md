# Public trade-flow domain

- `binance.ts` normalizes Binance aggregate trades; `m=true` is an aggressive sell because the buyer was the resting maker.
- `bybit.ts` normalizes Bybit `publicTrade` batches; `S` is already the taker side.
- `hub.ts` shares one exchange socket per `exchange:symbol`, batches prints for 100 ms and limits every public message to 500 trades.
- `types.ts` contains connector boundaries and strict numeric helpers.

The domain exposes public market prints only. It never accesses exchange credentials, account activity or authenticated order events. A reconnect starts a new live observation window; the frontend must not invent missing historical footprint data.
