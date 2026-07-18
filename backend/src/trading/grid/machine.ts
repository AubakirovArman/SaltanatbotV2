import { gridLevelPrices, type GridParamsV1 } from "@saltanatbotv2/contracts";
import type { Candle } from "../../types.js";
import type { Side } from "../types.js";
import {
  GRID_STATE_SCHEMA_V1,
  gridTransitionKey,
  type GridFillObservationV1,
  type GridIntentV1,
  type GridLevelSideV1,
  type GridLevelV1,
  type GridStateV1,
  type GridStepContextV1,
  type GridStepInputV1,
  type GridStepResultV1,
  type GridStopReasonV1
} from "./types.js";

/**
 * Pure "grid-state-v1" transition function. One step consumes the fills
 * observed since the previous step — the whole batch of a gap bar at once,
 * deterministically ordered by (price, side, key) — then (on the first step of
 * a closed bar) applies the bar-driven rules: anchoring, stop-loss,
 * outside-range and cooldown re-arm. Every emitted intent consumes one
 * deterministic transition key `grid:<botId>:<epochCycle>:<ordinal>`, which
 * doubles as the durable order clientId, so replays of the same inputs are
 * byte-identical and consolidated replacement orders are placed exactly once
 * per step (a gap never cascades intermediate re-places).
 *
 * Placement rule at anchor time (documented exactly): levels strictly below
 * the anchoring bar close arm BUY limits, levels strictly above arm SELL
 * limits (neutral); long arms only the buy ladder, short only the sell ladder;
 * a level exactly at the anchor close never arms. A filled ladder order places
 * one paired close limit at the adjacent level price (upper neighbour for
 * buys, lower for sells; the range bound when there is no neighbour). The
 * completed pair realizes (sell - buy) * qty minus the fee model on both legs,
 * counts one cycle, and re-arms the ladder order after cooldownSeconds.
 *
 * Phase graph: idle -> active -> paused (outside range, resume on re-entry)
 * -> stopped (stop-loss flatten, outside-range stop, or maxCycles).
 */
export function stepGridMachine(
  state: GridStateV1,
  input: GridStepInputV1,
  params: GridParamsV1,
  ctx: GridStepContextV1
): GridStepResultV1 {
  validateContext(ctx);
  if (state.schemaVersion !== GRID_STATE_SCHEMA_V1) throw new Error("Grid machine received an unsupported state version");
  const next = structuredClone(state);
  const intents: GridIntentV1[] = [];
  const outcome = consumeFills(next, input.fills, input.bar, params, ctx);
  settleFillOutcome(next, outcome, params, ctx, intents);
  if (input.barChecks) applyBarRules(next, input.bar, params, ctx, intents);
  return { state: next, intents };
}

/** Remainder below this is the paper adapter's own flat threshold. */
const QTY_EPSILON = 1e-9;
/** All order quantities and limit prices are exact six-decimal values so the
 * machine's arithmetic mirrors the recorded paper fills bit-for-bit. */
const MONEY_SCALE = 1e6;

interface FillOutcome {
  /** Set when the pending stop-loss flatten was observed filled. */
  stopReason?: GridStopReasonV1;
}

function consumeFills(
  next: GridStateV1,
  fills: readonly GridFillObservationV1[],
  bar: Candle,
  params: GridParamsV1,
  ctx: GridStepContextV1
): FillOutcome {
  const outcome: FillOutcome = {};
  for (const fill of orderedFills(next, fills)) {
    if (!(fill.qty > 0) || !Number.isFinite(fill.qty) || !(fill.price > 0) || !Number.isFinite(fill.price)) {
      throw new Error(`Grid machine observed an invalid fill for ${fill.key}`);
    }
    if (next.pendingStop?.key === fill.key) {
      applyInventoryFill(next, next.inventoryBaseQty >= 0 ? "sell" : "buy", fill.qty, fill.price);
      outcome.stopReason = next.pendingStop.reason;
      next.pendingStop = undefined;
      continue;
    }
    const ladder = next.levels.find((level) => level.order?.key === fill.key);
    if (ladder) {
      ladder.order = undefined;
      ladder.status = "filled";
      ladder.openQty = fill.qty;
      ladder.openPrice = fill.price;
      applyInventoryFill(next, ladder.side, fill.qty, fill.price);
      continue;
    }
    const paired = next.levels.find((level) => level.pair?.key === fill.key);
    if (paired) {
      completePair(next, paired, fill, bar, params, ctx);
      continue;
    }
    throw new Error(`Grid machine observed a fill for an unknown transition ${fill.key}`);
  }
  return outcome;
}

/** Gap batches settle in one pass: ascending price, buys before sells, key last. */
function orderedFills(next: GridStateV1, fills: readonly GridFillObservationV1[]): GridFillObservationV1[] {
  const sides = new Map<string, Side>();
  for (const level of next.levels) {
    if (level.order) sides.set(level.order.key, level.side);
    if (level.pair) sides.set(level.pair.key, oppositeSide(level.side));
  }
  return [...fills].sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    const bySide = (sides.get(a.key) ?? "sell").localeCompare(sides.get(b.key) ?? "sell");
    if (bySide !== 0) return bySide;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** A paired close fill realizes the round trip and starts the re-arm cooldown. */
function completePair(
  next: GridStateV1,
  level: GridLevelV1,
  fill: GridFillObservationV1,
  bar: Candle,
  params: GridParamsV1,
  ctx: GridStepContextV1
): void {
  const openQty = level.openQty ?? 0;
  const openPrice = level.openPrice ?? 0;
  if (!(openQty > 0) || !(openPrice > 0)) throw new Error(`Grid pair fill ${fill.key} has no open leg to close`);
  const gross = level.side === "buy" ? (fill.price - openPrice) * fill.qty : (openPrice - fill.price) * fill.qty;
  const fees = (ctx.feePct / 100) * ((fill.price + openPrice) * fill.qty);
  next.realizedGridPnl = roundMoney(next.realizedGridPnl + gross - fees);
  next.cyclesCompleted += 1;
  applyInventoryFill(next, oppositeSide(level.side), fill.qty, fill.price);
  level.pair = undefined;
  level.openQty = undefined;
  level.openPrice = undefined;
  level.status = "cooldown";
  level.cooldownUntil = bar.time + params.cooldownSeconds * 1_000;
}

function settleFillOutcome(
  next: GridStateV1,
  outcome: FillOutcome,
  params: GridParamsV1,
  ctx: GridStepContextV1,
  intents: GridIntentV1[]
): void {
  if (outcome.stopReason) {
    if (Math.abs(next.inventoryBaseQty) <= QTY_EPSILON) {
      next.inventoryBaseQty = 0;
      next.inventoryAvgCost = 0;
    }
    terminalStop(next, stopReasonText(outcome.stopReason, next, params));
    return;
  }
  if (next.phase === "stopped" || next.pendingStop) return;
  if (params.maxCycles !== undefined && next.cyclesCompleted >= params.maxCycles) {
    cancelOpenOrders(next, ctx, intents);
    terminalStop(next, stopReasonText("max-cycles", next, params));
    return;
  }
  if (next.phase !== "active") return;
  // One consolidated replacement round per step: every filled level that lost
  // (or never had) its paired close gets exactly one pair placement.
  for (const level of next.levels) {
    if (level.status === "filled" && !level.pair) placePairOrder(next, level, params, ctx, intents);
  }
}

function applyBarRules(next: GridStateV1, bar: Candle, params: GridParamsV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  if (next.phase === "stopped" || next.pendingStop) return;
  if (next.phase === "idle") {
    anchorGrid(next, bar, params, ctx, intents);
    return;
  }
  if (params.stopLossPrice !== undefined && (params.mode === "short" ? bar.high >= params.stopLossPrice : bar.low <= params.stopLossPrice)) {
    beginStopLoss(next, params, ctx, intents);
    return;
  }
  const outside = bar.close < params.lowerBound || bar.close > params.upperBound;
  if (outside) {
    // Exactly once: pause is idempotent, stop is guarded by the terminal phase.
    if (params.outsideRangeAction === "stop") {
      cancelOpenOrders(next, ctx, intents);
      terminalStop(next, stopReasonText("outside-range", next, params));
    } else {
      next.phase = "paused";
    }
    return;
  }
  if (next.phase === "paused") next.phase = "active";
  for (const level of next.levels) {
    if (level.status === "cooldown" && bar.time >= (level.cooldownUntil ?? 0)) {
      level.cooldownUntil = undefined;
      placeLadderOrder(next, level, params, ctx, intents);
    } else if (level.status === "filled" && !level.pair) {
      // Pair placements deferred while the grid was paused resume here.
      placePairOrder(next, level, params, ctx, intents);
    }
  }
}

/**
 * Anchor the ladder on the first closed bar whose close sits inside the range;
 * a close outside [lowerBound, upperBound] keeps the grid idle and waiting.
 */
function anchorGrid(next: GridStateV1, bar: Candle, params: GridParamsV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  if (!(bar.close > 0) || !Number.isFinite(bar.close)) return;
  if (bar.close < params.lowerBound || bar.close > params.upperBound) return;
  next.epochCycle += 1;
  next.cursorOrdinal = 1;
  next.phase = "active";
  next.levels = gridLevelPrices(params).map((price, at): GridLevelV1 => ({
    index: at + 1,
    price,
    side: price < bar.close ? "buy" : "sell",
    status: "disabled"
  }));
  for (const level of next.levels) {
    if (ladderArms(level.price, bar.close, params)) placeLadderOrder(next, level, params, ctx, intents);
  }
}

/** Documented gap rule: strictly below the anchor arms buys, strictly above
 * arms sells; a level exactly at the anchor close never arms. */
function ladderArms(price: number, anchor: number, params: GridParamsV1): boolean {
  if (price === anchor) return false;
  if (params.mode === "long") return price < anchor;
  if (params.mode === "short") return price > anchor;
  return true;
}

function placeLadderOrder(next: GridStateV1, level: GridLevelV1, params: GridParamsV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  const qty = roundMoney(params.orderQuote / level.price);
  if (!(qty > 0)) {
    // orderQuote too small for a six-decimal quantity at this price: the level
    // honestly disables instead of resting an unfillable zero order.
    level.status = "disabled";
    level.order = undefined;
    return;
  }
  const ordinal = next.cursorOrdinal;
  const key = nextKey(next, ctx);
  level.status = "resting";
  level.order = { key, qty, price: level.price };
  level.orderOrdinal = ordinal;
  intents.push({ kind: "placeLevelLimit", key, side: level.side, index: level.index, qty, price: level.price });
}

/** Paired close at the adjacent level price; the outermost levels pair against
 * the range bound itself, keeping every order inside [lowerBound, upperBound]. */
function placePairOrder(next: GridStateV1, level: GridLevelV1, params: GridParamsV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  const qty = level.openQty ?? 0;
  if (!(qty > 0)) return;
  const price = roundMoney(level.side === "buy"
    ? next.levels[level.index]?.price ?? params.upperBound
    : next.levels[level.index - 2]?.price ?? params.lowerBound);
  const ordinal = next.cursorOrdinal;
  const key = nextKey(next, ctx);
  level.pair = { key, qty, price };
  level.orderOrdinal = ordinal;
  intents.push({ kind: "placePairLimit", key, side: oppositeSide(level.side), index: level.index, qty, price });
}

function beginStopLoss(next: GridStateV1, params: GridParamsV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  cancelOpenOrders(next, ctx, intents);
  if (Math.abs(next.inventoryBaseQty) > QTY_EPSILON) {
    const key = nextKey(next, ctx);
    next.pendingStop = { key, reason: "stop-loss" };
    intents.push({ kind: "closeMarket", key, side: next.inventoryBaseQty > 0 ? "sell" : "buy", reason: "stop-loss" });
    return;
  }
  next.inventoryBaseQty = 0;
  next.inventoryAvgCost = 0;
  terminalStop(next, stopReasonText("stop-loss", next, params));
}

/** One cancel-all transition plus the matching in-machine bookkeeping. */
function cancelOpenOrders(next: GridStateV1, ctx: GridStepContextV1, intents: GridIntentV1[]): void {
  intents.push({ kind: "cancelAll", key: nextKey(next, ctx) });
  for (const level of next.levels) {
    if (level.status === "resting") {
      level.status = "disabled";
      level.order = undefined;
    } else if (level.status === "cooldown") {
      level.status = "disabled";
      level.cooldownUntil = undefined;
    }
    // A cancelled pair leaves the level honestly "filled": inventory is kept.
    level.pair = undefined;
  }
}

function terminalStop(next: GridStateV1, reason: string): void {
  next.phase = "stopped";
  next.stopReason = reason;
  next.pendingStop = undefined;
}

function stopReasonText(reason: GridStopReasonV1, next: GridStateV1, params: GridParamsV1): string {
  switch (reason) {
    case "stop-loss":
      return `Grid stop-loss ${params.stopLossPrice} crossed; orders cancelled, inventory flattened at market, and the grid stopped.`;
    case "outside-range":
      return `Price left the grid range [${params.lowerBound}, ${params.upperBound}] with outsideRangeAction=stop; orders cancelled and the grid stopped with inventory kept.`;
    case "max-cycles":
      return `Grid completed ${next.cyclesCompleted} round trips (maxCycles=${params.maxCycles}); orders cancelled and the grid stopped with inventory kept.`;
    default:
      return "Grid reached a terminal stop.";
  }
}

/**
 * Signed inventory mirror of observed fills: same-direction adds merge into the
 * VWAP, reductions keep it, crossing through zero re-opens the residual leg at
 * the fill price, and a flat remainder below the paper epsilon snaps to zero.
 */
function applyInventoryFill(next: GridStateV1, side: Side, qty: number, price: number): void {
  const signed = side === "buy" ? qty : -qty;
  const current = next.inventoryBaseQty;
  const merged = current + signed;
  if (Math.abs(merged) <= QTY_EPSILON) {
    next.inventoryBaseQty = 0;
    next.inventoryAvgCost = 0;
    return;
  }
  if (current === 0 || (current > 0) === (signed > 0)) {
    next.inventoryAvgCost = (next.inventoryAvgCost * Math.abs(current) + price * qty) / Math.abs(merged);
  } else if ((current > 0) !== (merged > 0)) {
    next.inventoryAvgCost = price;
  }
  next.inventoryBaseQty = merged;
}

function nextKey(next: GridStateV1, ctx: GridStepContextV1): string {
  const key = gridTransitionKey(ctx.botId, next.epochCycle, next.cursorOrdinal);
  next.cursorOrdinal += 1;
  return key;
}

export function oppositeSide(side: GridLevelSideV1): Side {
  return side === "buy" ? "sell" : "buy";
}

function roundMoney(value: number): number {
  return Math.round(value * MONEY_SCALE) / MONEY_SCALE;
}

function validateContext(ctx: GridStepContextV1): void {
  if (
    !ctx.botId.trim()
    || !Number.isFinite(ctx.feePct) || ctx.feePct < 0 || ctx.feePct > 100
    || !Number.isFinite(ctx.slipPct) || ctx.slipPct < 0 || ctx.slipPct > 100
  ) {
    throw new Error("Grid machine context violates the paper fill-model envelope");
  }
}
