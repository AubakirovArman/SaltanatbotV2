# Cross-exchange arbitrage screener

The **Screener** workspace monitors common USDT markets on Binance and Bybit without API keys. It
builds two cash-and-carry discovery routes for every common symbol:

1. buy Binance spot at the current ask and short the Bybit linear perpetual at the current bid;
2. buy Bybit spot at the current ask and short the Binance USD-M perpetual at the current bid.

The table shows gross basis, a route-specific fee deduction, net edge, the maximum notional
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

The fee profile stores separate Binance/Bybit spot/perpetual taker rates plus a round-trip slippage
reserve in this browser. Entry and exit are included automatically. Funding is
shown separately and is not included because the holding duration and future rates are unknown.

## Data and failure behavior

`GET /api/arbitrage` reads public Binance book tickers and premium index plus Bybit V5 spot/linear
tickers concurrently. `/arbitrage-stream` broadcasts the shared two-second server snapshot; the
browser reconnects with bounded backoff and uses REST as a fallback. The connection pauses in a
hidden tab. Individual source failures
are visible; if a complete refresh temporarily fails, a successful snapshot may be served for at
most 30 seconds and is clearly marked stale.

## Depth, alerts and paper positions

`GET /api/arbitrage/depth` fetches up to 100 public levels from both selected books only when the
operator requests an analysis. It walks the spot asks and perpetual bids for the chosen USD
notional and reports filled notional, VWAP, worst price, levels used, directional slippage and
whether both legs have enough visible liquidity. Paper entry fails closed when either leg is
incomplete.

Opportunity alerts fire only when a route crosses the configured net threshold. Desktop delivery
uses browser permission. Telegram delivery is best-effort and is available only to an authenticated
paper-trade session with an enabled notification channel. Alerts never place orders.

Paper positions are a local browser research ledger. Entry uses the depth VWAP for both legs; open
PnL marks the spot leg to its bid and the short perpetual leg to its ask, then subtracts the estimated
round-trip costs. These records are not an exchange account and are capped locally.

Official inputs: [Binance Spot market data](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market), [Binance USD-M market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [Bybit V5 tickers](https://bybit-exchange.github.io/docs/v5/market/tickers), and [Bybit order book](https://bybit-exchange.github.io/docs/v5/market/orderbook).

## Risk boundary

The screener is research-only and never places orders. Quotes from separate venues are asynchronous.
Fees, depth changes after the snapshot, slippage, funding, borrow availability, transfer time, position
limits, API latency and liquidation risk can remove the displayed edge. A positive row is not a
profit guarantee and does not prove that both legs can execute atomically.
