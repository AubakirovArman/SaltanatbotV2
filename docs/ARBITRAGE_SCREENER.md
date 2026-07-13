# Cross-exchange arbitrage screener

The **Screener** workspace monitors common USDT markets on Binance and Bybit without API keys. It
builds two cash-and-carry discovery routes for every common symbol:

1. buy Binance spot at the current ask and short the Bybit linear perpetual at the current bid;
2. buy Bybit spot at the current ask and short the Binance USD-M perpetual at the current bid.

The table shows gross basis, a configurable total-cost deduction, net edge, the maximum notional
visible at both best prices and the perpetual funding rate. Only instruments with executable,
positive bid/ask prices and sizes are accepted. Delivery futures are excluded: a current funding
schedule is required for a contract to be classified as perpetual.
Rows with an absolute basis above 20% fail closed because they are more likely to be same-ticker
asset collisions, redenominations or stale markets than an executable opportunity.

## Calculation

```text
gross spread (bp) = (perpetual bid - spot ask) / spot ask × 10,000
net edge (bp)     = gross spread - estimated total costs
top-book capacity = min(spot ask × ask size, perpetual bid × bid size)
```

The cost field should include all expected entry and exit fees plus a slippage reserve. Funding is
shown separately and is not included because the holding duration and future rates are unknown.

## Data and failure behavior

`GET /api/arbitrage` reads public Binance book tickers and premium index plus Bybit V5 spot/linear
tickers concurrently. A two-second server cache is shared by viewers. Individual source failures
are visible; if a complete refresh temporarily fails, a successful snapshot may be served for at
most 30 seconds and is clearly marked stale. Browser polling pauses while the page is hidden.

Official inputs: [Binance Spot market data](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints), [Binance USD-M book ticker](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Order-Book-Ticker), and [Bybit V5 tickers](https://bybit-exchange.github.io/docs/v5/market/tickers).

## Risk boundary

The screener is research-only and never places orders. Quotes from separate venues are asynchronous.
Fees, depth beyond the top level, slippage, funding, borrow availability, transfer time, position
limits, API latency and liquidation risk can remove the displayed edge. A positive row is not a
profit guarantee and does not prove that both legs can execute atomically.
