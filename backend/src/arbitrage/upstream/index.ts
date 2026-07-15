import { BinanceTickerFeed } from "./binance.js";
import { BybitTickerFeed } from "./bybit.js";
import type { StatusListener, TickerListener } from "./types.js";

export * from "./publicFeeds/index.js";

/** Owns exactly one public ticker connection per exchange/market for all browser clients. */
export class ArbitrageUpstream {
  private readonly feeds: Array<BinanceTickerFeed | BybitTickerFeed>;

  constructor(onTicker: TickerListener, onStatus: StatusListener) {
    this.feeds = [new BinanceTickerFeed("spot", onTicker, onStatus), new BinanceTickerFeed("perpetual", onTicker, onStatus), new BybitTickerFeed("spot", onTicker, onStatus), new BybitTickerFeed("perpetual", onTicker, onStatus)];
  }

  setSymbols(symbols: Iterable<string>) {
    for (const feed of this.feeds) feed.setSymbols(symbols);
  }
  start() {
    for (const feed of this.feeds) feed.start();
  }
  stop() {
    for (const feed of this.feeds) feed.stop();
  }
}
