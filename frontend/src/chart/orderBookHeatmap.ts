import type { OrderBookSnapshotMessage } from "../types";

export interface OrderBookFrame extends OrderBookSnapshotMessage {
  capturedAt: number;
}

export interface HeatmapCell {
  x: number;
  width: number;
  y: number;
  side: "bid" | "ask";
  notional: number;
}

export function buildHeatmapCells(
  frames: OrderBookFrame[],
  priceToY: (price: number) => number,
  now: number,
  durationMs = 60_000,
  rowSize = 3
) {
  const start = now - durationMs;
  const visible = frames.filter((frame) => frame.capturedAt >= start && frame.capturedAt <= now);
  const cells: HeatmapCell[] = [];
  let maxNotional = 0;
  for (let index = 0; index < visible.length; index += 1) {
    const frame = visible[index];
    const nextAt = visible[index + 1]?.capturedAt ?? Math.min(now, frame.capturedAt + 500);
    const x = (frame.capturedAt - start) / durationMs;
    const width = Math.max(1 / durationMs, (nextAt - frame.capturedAt) / durationMs);
    const grouped = new Map<string, HeatmapCell>();
    for (const [side, levels] of [["bid", frame.bids], ["ask", frame.asks]] as const) {
      for (const [price, size] of levels) {
        const baseY = Math.floor(priceToY(price) / rowSize) * rowSize;
        const y = baseY + (side === "bid" ? rowSize * 0.45 : -rowSize * 0.45);
        const key = `${side}:${y}`;
        const notional = price * size;
        const existing = grouped.get(key);
        if (existing) existing.notional += notional;
        else grouped.set(key, { x, width, y, side, notional });
      }
    }
    for (const cell of grouped.values()) {
      maxNotional = Math.max(maxNotional, cell.notional);
      cells.push(cell);
    }
  }
  return { cells, maxNotional, visibleFrames: visible.length };
}

export function orderBookSpreadBps(snapshot: OrderBookSnapshotMessage | undefined) {
  const bid = snapshot?.bids[0]?.[0];
  const ask = snapshot?.asks[0]?.[0];
  if (!bid || !ask || ask < bid) return undefined;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? (ask - bid) / midpoint * 10_000 : undefined;
}
