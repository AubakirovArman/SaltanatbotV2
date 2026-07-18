import { roundPaperValue as round } from "./paperCommandSupport.js";
import type { PositionState, Side } from "../types.js";

/**
 * Versioned same-side fill semantics for the paper adapter.
 * - `single-position-v1`: historical behavior — one position; a same-side add
 *   never fills (byte-compatible with every historical ledger).
 * - `averaging-v1`: a same-side add merges into the volume-weighted average
 *   entry (DCA robots only; stamped per bot in its config).
 */
export type PaperFillBehavior = "single-position-v1" | "averaging-v1";

export interface PaperPositionFillEffect {
  position: PositionState | null;
  balanceDelta: number;
  fill: { symbol: string; side: Side; qty: number; fee: number; pnl: number; kind: "open" | "close" };
}

/** Pure position/balance transition for one fill; null means the fill cannot apply. */
export function applyPaperPositionFill(
  position: PositionState | null,
  input: { symbol: string; side: Side; qty: number; price: number; reduceOnly: boolean; feePct: number; leverage: number; behavior: PaperFillBehavior; now: () => number }
): PaperPositionFillEffect | null {
  const { symbol, side, qty, price, feePct } = input;
  if (!qty || qty <= 0) return null;
  // Reduce / close.
  if (position && ((side === "sell" && position.side === "long") || (side === "buy" && position.side === "short"))) {
    const closeQty = Math.min(position.qty, qty);
    const gross = round(position.side === "long" ? closeQty * (price - position.entryPrice) : closeQty * (position.entryPrice - price));
    const fee = round(closeQty * price * (feePct / 100));
    const pnl = round(gross - fee);
    const remainder = position.qty - closeQty;
    return {
      position: remainder <= 1e-9 ? null : { ...position, qty: remainder },
      balanceDelta: pnl,
      fill: { symbol: position.symbol, side, qty: closeQty, fee, pnl, kind: "close" }
    };
  }
  if (input.reduceOnly) return null;
  if (position) {
    // Same-side add: merge only under averaging-v1, on the held symbol.
    if (input.behavior !== "averaging-v1" || position.symbol !== symbol) return null;
    const fee = round(qty * price * (feePct / 100));
    const mergedQty = position.qty + qty;
    return {
      position: { ...position, qty: mergedQty, entryPrice: (position.entryPrice * position.qty + price * qty) / mergedQty },
      balanceDelta: -fee,
      fill: { symbol, side, qty, fee, pnl: 0, kind: "open" }
    };
  }
  // Open (one one-way position per adapter).
  const fee = round(qty * price * (feePct / 100));
  return {
    position: { symbol, side: side === "buy" ? "long" : "short", qty, entryPrice: price, leverage: input.leverage, openedAt: input.now() },
    balanceDelta: -fee,
    fill: { symbol, side, qty, fee, pnl: 0, kind: "open" }
  };
}
