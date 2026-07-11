import type { Candle } from "@saltanatbotv2/contracts";
import { applyExecutionSlippage } from "@saltanatbotv2/execution-core";

export type HistoricalOrderType = "market" | "limit" | "stop";
export type HistoricalOrderStatus = "resting" | "partially_filled" | "filled";

export interface HistoricalOrder {
  id: string;
  side: "buy" | "sell";
  type: HistoricalOrderType;
  qty: number;
  filledQty: number;
  price?: number;
  /** Maximum share of candle volume available to this order; 100 by default. */
  participationPct?: number;
}

export interface HistoricalOrderFill {
  orderId: string;
  qty: number;
  price: number;
  fee: number;
  feeAsset: "quote";
  liquidity: "taker" | "maker";
  barTime: number;
}

export interface HistoricalOrderStep {
  order: HistoricalOrder;
  status: HistoricalOrderStatus;
  fill?: HistoricalOrderFill;
}

export interface HistoricalOrderCosts {
  commissionPct: number;
  slippagePct: number;
}

/**
 * Deterministic OHLCV order step. There is no invented intrabar path:
 * market orders use open; limits/stops only use whether their trigger lies in
 * the candle range, with gap-aware price improvement/adverse execution.
 */
export function stepHistoricalOrder(
  input: HistoricalOrder,
  candle: Candle,
  costs: HistoricalOrderCosts
): HistoricalOrderStep {
  const order = sanitizeOrder(input);
  const remaining = Math.max(0, order.qty - order.filledQty);
  if (!(remaining > 0)) return { order, status: "filled" };
  const rawPrice = eligiblePrice(order, candle);
  if (rawPrice === undefined) return { order, status: order.filledQty > 0 ? "partially_filled" : "resting" };

  const participation = Math.max(0, Math.min(100, order.participationPct ?? 100)) / 100;
  const volumeCapacity = Number.isFinite(candle.volume) && candle.volume >= 0 ? candle.volume * participation : remaining;
  const qty = Math.min(remaining, volumeCapacity);
  if (!(qty > 0)) return { order, status: order.filledQty > 0 ? "partially_filled" : "resting" };

  const direction = order.side === "buy" ? "long" : "short";
  const liquidity = order.type === "limit" ? "maker" : "taker";
  const price = liquidity === "taker"
    ? applyExecutionSlippage(rawPrice, direction, true, costs.slippagePct)
    : rawPrice;
  const filledQty = order.filledQty + qty;
  const next = { ...order, filledQty };
  return {
    order: next,
    status: filledQty + Number.EPSILON >= order.qty ? "filled" : "partially_filled",
    fill: {
      orderId: order.id,
      qty,
      price,
      fee: qty * price * (Math.max(0, costs.commissionPct) / 100),
      feeAsset: "quote",
      liquidity,
      barTime: candle.time
    }
  };
}

export function runHistoricalOrder(
  order: HistoricalOrder,
  candles: readonly Candle[],
  costs: HistoricalOrderCosts
): HistoricalOrderStep[] {
  const steps: HistoricalOrderStep[] = [];
  let current = order;
  for (const candle of candles) {
    const step = stepHistoricalOrder(current, candle, costs);
    steps.push(step);
    current = step.order;
    if (step.status === "filled") break;
  }
  return steps;
}

function eligiblePrice(order: HistoricalOrder, candle: Candle): number | undefined {
  if (order.type === "market") return candle.open;
  if (!(order.price && order.price > 0)) return undefined;
  if (order.type === "limit") {
    if (order.side === "buy" && candle.low <= order.price) return Math.min(candle.open, order.price);
    if (order.side === "sell" && candle.high >= order.price) return Math.max(candle.open, order.price);
    return undefined;
  }
  if (order.side === "buy" && candle.high >= order.price) return Math.max(candle.open, order.price);
  if (order.side === "sell" && candle.low <= order.price) return Math.min(candle.open, order.price);
  return undefined;
}

function sanitizeOrder(order: HistoricalOrder): HistoricalOrder {
  const qty = Number.isFinite(order.qty) ? Math.max(0, order.qty) : 0;
  return {
    ...order,
    qty,
    filledQty: Number.isFinite(order.filledQty) ? Math.max(0, Math.min(qty, order.filledQty)) : 0
  };
}
