import type { BarIntents } from "@saltanatbotv2/strategy-core";
import type { BacktestConfig, Trade, TradeMarker } from "../backtestTypes";
import { resolveSize, resolveStop, resolveTarget, type Position } from "./broker";

export interface OpenPositionRequest {
  direction: "long" | "short";
  fill: number;
  index: number;
  time: number;
  stop?: BarIntents["stop"];
  target?: BarIntents["target"];
  trail?: BarIntents["trail"];
  size: NonNullable<BarIntents["size"]>;
  atr: number;
  equity: number;
  config: Required<BacktestConfig>;
}

export interface OpenPositionResult {
  position?: Position;
  marker?: TradeMarker;
  warning?: string;
}

export interface ClosePositionRequest {
  position: Position;
  index: number;
  time: number;
  price: number;
  reason: Trade["reason"];
  commissionPct: number;
}

export interface ClosePositionResult {
  trade: Trade;
  marker: TradeMarker;
  equityDelta: number;
}

export function openBacktestPosition(request: OpenPositionRequest): OpenPositionResult {
  const { direction, fill, index, time, stop, target, trail, size, atr, equity, config } = request;
  let stopPrice = stop ? resolveStop(direction, fill, stop, atr) : undefined;
  if (trail && stopPrice === undefined) {
    stopPrice = trail.mode === "percent"
      ? direction === "long" ? fill * (1 - trail.value / 100) : fill * (1 + trail.value / 100)
      : direction === "long" ? fill - atr * trail.value : fill + atr * trail.value;
  }
  const targetPrice = target ? resolveTarget(direction, fill, target, atr) : undefined;
  const sized = resolveSize(size, equity, fill, stopPrice, config);
  if (!(sized.qty > 0) || !Number.isFinite(sized.qty)) return { warning: sized.warning };

  return {
    position: {
      dir: direction,
      qty: sized.qty,
      entryPrice: fill,
      entryIndex: index,
      entryTime: time,
      stopPrice,
      targetPrice,
      trail,
      maeAbs: 0,
      mfeAbs: 0
    },
    marker: {
      time,
      price: fill,
      kind: direction === "long" ? "buy" : "sell",
      label: `${direction === "long" ? "Long" : "Short"} ${fill.toFixed(2)}`
    },
    warning: sized.warning
  };
}

export function closeBacktestPosition(request: ClosePositionRequest): ClosePositionResult {
  const { position, index, time, price, reason, commissionPct } = request;
  const gross = position.dir === "long"
    ? position.qty * (price - position.entryPrice)
    : position.qty * (position.entryPrice - price);
  const commission = position.qty * (position.entryPrice + price) * (commissionPct / 100);
  const pnl = gross - commission;
  const notional = position.entryPrice * position.qty || 1;

  return {
    equityDelta: pnl,
    trade: {
      direction: position.dir,
      entryIndex: position.entryIndex,
      exitIndex: index,
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: price,
      qty: position.qty,
      pnl,
      pnlPct: (pnl / notional) * 100,
      reason,
      barsHeld: index - position.entryIndex,
      maePct: (position.maeAbs / notional) * 100,
      mfePct: (position.mfeAbs / notional) * 100
    },
    marker: { time, price, kind: "exit", label: `Exit ${price.toFixed(2)}` }
  };
}
