import { resolveExecutionSize, resolveProtectionPrice } from "@saltanatbotv2/execution-core";
import type { Candle } from "../types.js";
import type { Managed } from "./engineRuntime.js";
import type { BarIntents } from "./strategy/evaluator.js";
import type { BotConfig } from "./types.js";

/** Intrabar trailing-stop ratchet: the managed stop only ever tightens. */
export function ratchetTrailingStop(m: Managed, candle: Candle, atr: () => number): void {
  if (!m.trail) return;
  const trailAtr = m.trail.mode === "atr" ? atr() : 0;
  if (m.side === "long") {
    const candidate = m.trail.mode === "percent" ? candle.high * (1 - m.trail.value / 100) : candle.high - trailAtr * m.trail.value;
    m.stop = Math.max(m.stop ?? -Infinity, candidate);
  } else {
    const candidate = m.trail.mode === "percent" ? candle.low * (1 + m.trail.value / 100) : candle.low + trailAtr * m.trail.value;
    m.stop = Math.min(m.stop ?? Infinity, candidate);
  }
}

export function resolvePositionQty(
  config: BotConfig,
  intents: BarIntents,
  price: number,
  equity: number,
  stop?: number
): number {
  const size = intents.size ?? { mode: mapSizeMode(config.sizeMode), value: config.sizeValue };
  const normalized = config.sizeMode === "quote" && !intents.size
    ? { mode: "units" as const, value: size.value / price }
    : size;
  return resolveExecutionSize(normalized, equity, price, stop, {
    leverage: Math.max(1, config.leverage),
    maxLeverage: Math.max(1, config.leverage),
  }).qty;
}

export function resolveStopPrice(stop: BarIntents["stop"], direction: "long" | "short", entry: number, atr: number) {
  return resolveProtectionPrice("stop", direction, entry, stop, atr);
}

export function resolveTargetPrice(target: BarIntents["target"], direction: "long" | "short", entry: number, atr: number) {
  return resolveProtectionPrice("target", direction, entry, target, atr);
}

function mapSizeMode(mode: BotConfig["sizeMode"]): "units" | "equity_pct" | "risk_pct" {
  if (mode === "equity_pct") return "equity_pct";
  if (mode === "risk_pct") return "risk_pct";
  return "units";
}
