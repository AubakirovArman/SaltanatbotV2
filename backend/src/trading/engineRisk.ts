import type { BarIntents } from "./strategy/evaluator.js";
import type { BotConfig } from "./types.js";

export function resolvePositionQty(
  config: BotConfig,
  intents: BarIntents,
  price: number,
  equity: number,
  stop?: number
): number {
  const size = intents.size ?? { mode: mapSizeMode(config.sizeMode), value: config.sizeValue };
  const leverage = Math.max(1, config.leverage);
  switch (size.mode) {
    case "units":
      return config.sizeMode === "quote" && !intents.size ? size.value / price : size.value;
    case "equity_pct":
      return (equity * (size.value / 100) * leverage) / price;
    case "risk_pct":
      return stop && Math.abs(price - stop) > 0
        ? (equity * (size.value / 100)) / Math.abs(price - stop)
        : (equity * leverage) / price;
    default:
      return size.value;
  }
}

export function resolveStopPrice(stop: BarIntents["stop"], direction: "long" | "short", entry: number, atr: number) {
  if (!stop) return undefined;
  if (stop.mode === "price") return stop.value;
  if (stop.mode === "percent") return direction === "long" ? entry * (1 - stop.value / 100) : entry * (1 + stop.value / 100);
  return direction === "long" ? entry - atr * stop.value : entry + atr * stop.value;
}

export function resolveTargetPrice(target: BarIntents["target"], direction: "long" | "short", entry: number, atr: number) {
  if (!target) return undefined;
  if (target.mode === "price") return target.value;
  if (target.mode === "percent") return direction === "long" ? entry * (1 + target.value / 100) : entry * (1 - target.value / 100);
  return direction === "long" ? entry + atr * target.value : entry - atr * target.value;
}

function mapSizeMode(mode: BotConfig["sizeMode"]): "units" | "equity_pct" | "risk_pct" {
  if (mode === "equity_pct") return "equity_pct";
  if (mode === "risk_pct") return "risk_pct";
  return "units";
}
