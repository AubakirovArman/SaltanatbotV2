import type { BarIntents } from "@saltanatbotv2/strategy-core";
import type { Candle } from "@saltanatbotv2/contracts";
import {
  applyExecutionSlippage,
  resolveExecutionSize,
  resolveProtectionPrice,
} from "@saltanatbotv2/execution-core";
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
  return applyExecutionSlippage(price, direction, entering, config.slippagePct);
}

export function resolveStop(
  direction: "long" | "short",
  entry: number,
  stop: NonNullable<BarIntents["stop"]>,
  atr: number
): number {
  return resolveProtectionPrice("stop", direction, entry, stop, atr) ?? 0;
}

export function resolveTarget(
  direction: "long" | "short",
  entry: number,
  target: NonNullable<BarIntents["target"]>,
  atr: number
): number {
  return resolveProtectionPrice("target", direction, entry, target, atr) ?? 0;
}

export function resolveSize(
  sizing: NonNullable<BarIntents["size"]>,
  equity: number,
  price: number,
  stopPrice: number | undefined,
  config: Required<BacktestConfig>
): SizeResult {
  return resolveExecutionSize(sizing, equity, price, stopPrice, {
    leverage: 1,
    maxLeverage: config.maxLeverage,
    qtyStep: config.qtyStep,
  });
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
