import type { OrderBookLevel } from "../types.js";

/** Mutable exchange book kept behind a snapshot-only public contract. */
export class LocalOrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  reset(bids: OrderBookLevel[], asks: OrderBookLevel[]) {
    this.bids.clear();
    this.asks.clear();
    this.apply(bids, asks);
  }

  apply(bids: OrderBookLevel[], asks: OrderBookLevel[]) {
    applySide(this.bids, bids);
    applySide(this.asks, asks);
  }

  snapshot(limit = 20) {
    return {
      bids: [...this.bids].sort((a, b) => b[0] - a[0]).slice(0, limit) as OrderBookLevel[],
      asks: [...this.asks].sort((a, b) => a[0] - b[0]).slice(0, limit) as OrderBookLevel[]
    };
  }
}

function applySide(side: Map<number, number>, levels: OrderBookLevel[]) {
  for (const [price, size] of levels) {
    if (size === 0) side.delete(price);
    else side.set(price, size);
  }
}
