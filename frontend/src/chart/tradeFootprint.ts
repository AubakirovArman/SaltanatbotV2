import type { TradeFlowTrade } from "../types";
import type { Viewport } from "./types";

export interface FootprintCell {
  time: number;
  row: number;
  x: number;
  y: number;
  buyNotional: number;
  sellNotional: number;
}

export interface DeltaBar {
  time: number;
  x: number;
  buyNotional: number;
  sellNotional: number;
  prints: number;
  delta: number;
  cumulative: number;
}

export interface TradeFootprint {
  cells: FootprintCell[];
  bars: DeltaBar[];
  buyNotional: number;
  sellNotional: number;
  maxCellNotional: number;
  maxAbsDelta: number;
}

/** Aggregate real exchange prints into visible candle × screen-price cells. */
export function aggregateTradeFootprint(trades: TradeFlowTrade[], viewport: Viewport, priceRowPx = 9): TradeFootprint {
  const cells = new Map<string, FootprintCell>();
  const barTotals = new Map<number, { buyNotional: number; sellNotional: number; prints: number }>();
  let buyNotional = 0;
  let sellNotional = 0;
  let maxCellNotional = 0;

  for (const trade of trades) {
    const bucketTime = Math.floor(trade.exchangeTs / viewport.barTimeMs) * viewport.barTimeMs;
    const x = viewport.timeToX(bucketTime);
    const rawY = viewport.priceToY(trade.price);
    if (x < viewport.plot.left - viewport.barSpacing || x > viewport.plot.right + viewport.barSpacing) continue;
    if (rawY < viewport.plot.top || rawY > viewport.plot.bottom) continue;
    const row = Math.floor((rawY - viewport.plot.top) / priceRowPx);
    const key = `${bucketTime}:${row}`;
    const cell = cells.get(key) ?? {
      time: bucketTime,
      row,
      x,
      y: viewport.plot.top + row * priceRowPx + priceRowPx / 2,
      buyNotional: 0,
      sellNotional: 0
    };
    const notional = trade.price * trade.size;
    if (trade.side === "buy") {
      cell.buyNotional += notional;
      buyNotional += notional;
    } else {
      cell.sellNotional += notional;
      sellNotional += notional;
    }
    cells.set(key, cell);
    const bar = barTotals.get(bucketTime) ?? { buyNotional: 0, sellNotional: 0, prints: 0 };
    if (trade.side === "buy") bar.buyNotional += notional;
    else bar.sellNotional += notional;
    bar.prints += 1;
    barTotals.set(bucketTime, bar);
  }

  for (const cell of cells.values()) maxCellNotional = Math.max(maxCellNotional, cell.buyNotional, cell.sellNotional);
  let cumulative = 0;
  let maxAbsDelta = 0;
  const bars = [...barTotals.entries()].sort(([a], [b]) => a - b).map(([time, totals]) => {
    const delta = totals.buyNotional - totals.sellNotional;
    cumulative += delta;
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta));
    return { time, x: viewport.timeToX(time), ...totals, delta, cumulative };
  });
  return { cells: [...cells.values()], bars, buyNotional, sellNotional, maxCellNotional, maxAbsDelta };
}

export function tradeFlowDeltaPercent(buyNotional: number, sellNotional: number) {
  const total = buyNotional + sellNotional;
  return total > 0 ? ((buyNotional - sellNotional) / total) * 100 : 0;
}
