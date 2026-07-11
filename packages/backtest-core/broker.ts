import type { BarIntents } from "@saltanatbotv2/strategy-core";
import type { Candle } from "@saltanatbotv2/contracts";
import type { BacktestConfig } from "./types.js";

export interface Position {
  dir: "long" | "short";
  qty: number;
  entryPrice: number;
  entryIndex: number;
  entryTime: number;
  stopPrice?: number;
  targetPrice?: number;
  trail?: { mode: "percent" | "atr"; value: number };
  /** Worst / best unrealized PnL observed while the position is open. */
  maeAbs: number;
  mfeAbs: number;
}

export interface SizeResult {
  qty: number;
  warning?: string;
}

export function applySlippage(
  price: number,
  direction: "long" | "short",
  entering: boolean,
  config: BacktestConfig
): number {
  const worseUp = (direction === "long") === entering;
  const factor = worseUp ? 1 + config.slippagePct / 100 : 1 - config.slippagePct / 100;
  return price * factor;
}

export function resolveStop(
  direction: "long" | "short",
  entry: number,
  stop: NonNullable<BarIntents["stop"]>,
  atr: number
): number {
  if (stop.mode === "price") return stop.value;
  if (stop.mode === "percent") {
    return direction === "long" ? entry * (1 - stop.value / 100) : entry * (1 + stop.value / 100);
  }
  const distance = (atr || 0) * stop.value;
  return direction === "long" ? entry - distance : entry + distance;
}

export function resolveTarget(
  direction: "long" | "short",
  entry: number,
  target: NonNullable<BarIntents["target"]>,
  atr: number
): number {
  if (target.mode === "price") return target.value;
  if (target.mode === "percent") {
    return direction === "long" ? entry * (1 + target.value / 100) : entry * (1 - target.value / 100);
  }
  const distance = (atr || 0) * target.value;
  return direction === "long" ? entry + distance : entry - distance;
}

export function resolveSize(
  sizing: NonNullable<BarIntents["size"]>,
  equity: number,
  price: number,
  stopPrice: number | undefined,
  config: Required<BacktestConfig>
): SizeResult {
  if (price <= 0 || !Number.isFinite(price)) return { qty: 0 };

  let qty: number;
  if (sizing.mode === "units") {
    qty = sizing.value;
  } else if (sizing.mode === "risk_pct") {
    if (stopPrice === undefined || Math.abs(price - stopPrice) === 0) {
      return { qty: 0, warning: "Skipped risk_pct entry: no stop set, so risk-based size is undefined." };
    }
    qty = (equity * (sizing.value / 100)) / Math.abs(price - stopPrice);
  } else {
    qty = (equity * (sizing.value / 100)) / price;
  }

  if (!(qty > 0) || !Number.isFinite(qty)) return { qty: 0 };

  let warning: string | undefined;
  const maxNotional = equity * config.maxLeverage;
  if (price * qty > maxNotional && maxNotional > 0) {
    qty = maxNotional / price;
    warning = `Position clipped to ${config.maxLeverage}x leverage (requested notional exceeded margin).`;
  }

  if (config.qtyStep > 0) {
    qty = Math.floor(qty / config.qtyStep) * config.qtyStep;
    if (!(qty > 0)) return { qty: 0, warning };
  }

  return { qty, warning };
}

export function stopHit(position: Position, candle: Candle): boolean {
  if (position.stopPrice === undefined) return false;
  return position.dir === "long" ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
}

export function targetHit(position: Position, candle: Candle): boolean {
  if (position.targetPrice === undefined) return false;
  return position.dir === "long" ? candle.high >= position.targetPrice : candle.low <= position.targetPrice;
}

export function unrealized(position: Position | null, price: number): number {
  if (!position) return 0;
  return position.dir === "long"
    ? position.qty * (price - position.entryPrice)
    : position.qty * (position.entryPrice - price);
}
