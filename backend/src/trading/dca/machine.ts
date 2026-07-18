import type { DcaParamsV1 } from "@saltanatbotv2/contracts";
import type { Candle } from "../../types.js";
import type { Side } from "../types.js";
import {
  DCA_STATE_SCHEMA_V1,
  dcaTransitionKey,
  type DcaExitReasonV1,
  type DcaFillObservationV1,
  type DcaIntentV1,
  type DcaStateV1,
  type DcaStepContextV1,
  type DcaStepInputV1,
  type DcaStepResultV1
} from "./types.js";

/**
 * Pure "dca-state-v1" transition function. One step consumes the fills
 * observed since the previous step, then (on the first step of a closed bar)
 * applies the bar-driven rules: cycle start, stop-loss, trailing take-profit
 * and cycle-duration limits. Every emitted intent consumes one deterministic
 * transition key `dca:<botId>:<cycle>:<ordinal>`, which doubles as the durable
 * order clientId, so replays of the same inputs are byte-identical.
 *
 * Phase graph: idle -> entering -> position(soFilled=k) -> exiting(reason)
 * -> cooldown(until) -> idle, with exiting("duration") terminating in
 * "stopped" instead of cooldown. Shorts are fully mirrored.
 */
export function stepDcaMachine(
  state: DcaStateV1,
  input: DcaStepInputV1,
  params: DcaParamsV1,
  ctx: DcaStepContextV1
): DcaStepResultV1 {
  validateContext(ctx);
  if (state.schemaVersion !== DCA_STATE_SCHEMA_V1) throw new Error("DCA machine received an unsupported state version");
  const next = structuredClone(state);
  const intents: DcaIntentV1[] = [];
  const outcome = consumeFills(next, input.fills);
  settleFillOutcome(next, outcome, input.bar, params, ctx, intents);
  if (input.barChecks) applyBarRules(next, input.bar, params, ctx, intents);
  return { state: next, intents };
}

/** Remainder below this is the paper adapter's own flat threshold. */
const QTY_EPSILON = 1e-9;
/** All order quantities and limit prices are exact six-decimal values so the
 * machine's arithmetic mirrors the recorded paper fills bit-for-bit. */
const MONEY_SCALE = 1e6;

interface FillOutcome {
  baseFilled: boolean;
  safetyFilled: boolean;
  takeProfitFilled: boolean;
  closeReason?: DcaExitReasonV1;
  /** Limit price of the safety order that just filled — the ladder anchor. */
  lastSafetyPrice?: number;
}

function consumeFills(next: DcaStateV1, fills: readonly DcaFillObservationV1[]): FillOutcome {
  const outcome: FillOutcome = { baseFilled: false, safetyFilled: false, takeProfitFilled: false };
  for (const fill of fills) {
    if (!(fill.qty > 0) || !Number.isFinite(fill.qty) || !(fill.price > 0) || !Number.isFinite(fill.price)) {
      throw new Error(`DCA machine observed an invalid fill for ${fill.key}`);
    }
    if (next.pendingBase?.key === fill.key) {
      next.qty = fill.qty;
      next.avgEntry = fill.price;
      next.soFilled = 0;
      next.pendingBase = undefined;
      next.phase = "position";
      outcome.baseFilled = true;
    } else if (next.pendingSafety?.key === fill.key) {
      const merged = next.qty + fill.qty;
      next.avgEntry = (next.avgEntry * next.qty + fill.price * fill.qty) / merged;
      next.qty = merged;
      next.soFilled = next.pendingSafety.index;
      outcome.lastSafetyPrice = next.pendingSafety.price;
      next.pendingSafety = undefined;
      outcome.safetyFilled = true;
    } else if (next.pendingTakeProfit?.key === fill.key) {
      next.qty = Math.max(0, next.qty - fill.qty);
      next.pendingTakeProfit = undefined;
      outcome.takeProfitFilled = true;
    } else if (next.pendingClose?.key === fill.key) {
      next.qty = Math.max(0, next.qty - fill.qty);
      outcome.closeReason = next.pendingClose.reason;
      next.pendingClose = undefined;
    } else {
      throw new Error(`DCA machine observed a fill for an unknown transition ${fill.key}`);
    }
  }
  return outcome;
}

function settleFillOutcome(
  next: DcaStateV1,
  outcome: FillOutcome,
  bar: Candle,
  params: DcaParamsV1,
  ctx: DcaStepContextV1,
  intents: DcaIntentV1[]
): void {
  if (outcome.closeReason) {
    finishCycle(next, outcome.closeReason, bar, params);
    return;
  }
  if (outcome.takeProfitFilled) {
    intents.push({ kind: "cancelAll", key: nextKey(next, ctx) });
    // An old take-profit can fill right after a safety add inside one bar's
    // ticks; the un-covered remainder is flattened explicitly, never dropped.
    if (next.qty > QTY_EPSILON) beginClose(next, "tp-remainder", params, ctx, intents);
    else finishCycle(next, "tp", bar, params);
    return;
  }
  if (outcome.safetyFilled) {
    if (next.qty <= QTY_EPSILON) throw new Error("DCA safety fill left no position to manage");
    intents.push({ kind: "cancelAll", key: nextKey(next, ctx) });
    placeTakeProfit(next, params, ctx, intents);
    placeNextSafety(next, outcome.lastSafetyPrice ?? next.avgEntry, params, ctx, intents);
    return;
  }
  if (outcome.baseFilled) {
    placeTakeProfit(next, params, ctx, intents);
    placeNextSafety(next, next.avgEntry, params, ctx, intents);
  }
}

function applyBarRules(next: DcaStateV1, bar: Candle, params: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  if (next.phase === "cooldown" && bar.time >= (next.cooldownUntil ?? 0)) {
    next.phase = "idle";
    next.cooldownUntil = undefined;
  }
  if (next.phase === "idle") {
    startCycle(next, bar, params, ctx, intents);
    return;
  }
  if (next.phase !== "position") return;
  const long = params.direction === "long";
  if (
    params.maxCycleDurationHours !== undefined
    && next.cycleStartedAt !== undefined
    && bar.time - next.cycleStartedAt >= params.maxCycleDurationHours * 3_600_000
  ) {
    beginExit(next, "duration", params, ctx, intents);
    return;
  }
  if (params.stopLossPct !== undefined) {
    const stop = levelPrice(next.avgEntry, params.stopLossPct, long ? -1 : 1);
    if (long ? bar.low <= stop : bar.high >= stop) {
      beginExit(next, "sl", params, ctx, intents);
      return;
    }
  }
  if (params.trailingTakeProfitPct === undefined) return;
  const threshold = levelPrice(next.avgEntry, params.takeProfitPct, long ? 1 : -1);
  const armedThisBar = !next.trailArmed && (long ? bar.high >= threshold : bar.low <= threshold);
  if (armedThisBar) next.trailArmed = true;
  if (!next.trailArmed) return;
  // Ratchet like the existing managed trail: the exit level only tightens.
  const candidate = long
    ? bar.high * (1 - params.trailingTakeProfitPct / 100)
    : bar.low * (1 + params.trailingTakeProfitPct / 100);
  next.trailStop = next.trailStop === undefined
    ? candidate
    : long ? Math.max(next.trailStop, candidate) : Math.min(next.trailStop, candidate);
  // On the arming bar only the close is provably after the trigger; later bars
  // exit on the adverse extreme, mirroring the intrabar managed-stop check.
  const crossed = armedThisBar
    ? (long ? bar.close <= next.trailStop : bar.close >= next.trailStop)
    : (long ? bar.low <= next.trailStop : bar.high >= next.trailStop);
  if (crossed) beginExit(next, "trail", params, ctx, intents);
}

function startCycle(next: DcaStateV1, bar: Candle, params: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  if (!(bar.close > 0) || !Number.isFinite(bar.close)) return;
  const qty = roundMoney(params.baseOrderQuote / bar.close);
  if (!(qty > 0)) return;
  next.cycle += 1;
  next.ordinal = 1;
  next.cycleStartedAt = bar.time;
  next.soFilled = 0;
  next.qty = 0;
  next.avgEntry = 0;
  next.trailArmed = undefined;
  next.trailStop = undefined;
  next.cooldownUntil = undefined;
  const key = nextKey(next, ctx);
  next.pendingBase = { key, qty };
  next.phase = "entering";
  intents.push({ kind: "placeBase", key, side: entrySide(params), qty });
}

function beginExit(next: DcaStateV1, reason: DcaExitReasonV1, dca: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  intents.push({ kind: "cancelAll", key: nextKey(next, ctx) });
  next.pendingSafety = undefined;
  next.pendingTakeProfit = undefined;
  beginClose(next, reason, dca, ctx, intents);
}

function beginClose(next: DcaStateV1, reason: DcaExitReasonV1, dca: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  const key = nextKey(next, ctx);
  next.pendingClose = { key, reason };
  next.phase = "exiting";
  intents.push({ kind: "closeMarket", key, side: exitSide(dca), reason });
}

function finishCycle(next: DcaStateV1, reason: DcaExitReasonV1, bar: Candle, dca: DcaParamsV1): void {
  next.qty = 0;
  next.avgEntry = 0;
  next.soFilled = 0;
  next.pendingBase = undefined;
  next.pendingSafety = undefined;
  next.pendingTakeProfit = undefined;
  next.pendingClose = undefined;
  next.trailArmed = undefined;
  next.trailStop = undefined;
  next.cycleStartedAt = undefined;
  if (reason === "duration") {
    next.phase = "stopped";
    next.stopReason = `Cycle ${next.cycle} exceeded maxCycleDurationHours=${dca.maxCycleDurationHours}; closed at market and stopped.`;
    return;
  }
  next.phase = "cooldown";
  next.cooldownUntil = bar.time + dca.cooldownSeconds * 1_000;
}

function placeTakeProfit(next: DcaStateV1, dca: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  // With trailing enabled the machine manages the exit itself; a resting TP
  // limit would fill at the threshold before the trail could ratchet.
  if (dca.trailingTakeProfitPct !== undefined) return;
  const long = dca.direction === "long";
  const price = roundMoney(levelPrice(next.avgEntry, dca.takeProfitPct, long ? 1 : -1));
  if (!(price > 0) || !(next.qty > 0)) return;
  const key = nextKey(next, ctx);
  next.pendingTakeProfit = { key, qty: next.qty, price };
  intents.push({ kind: "takeProfitLimit", key, side: exitSide(dca), qty: next.qty, price });
}

function placeNextSafety(next: DcaStateV1, anchorPrice: number, dca: DcaParamsV1, ctx: DcaStepContextV1, intents: DcaIntentV1[]): void {
  if (next.soFilled >= dca.maxSafetyOrders) return;
  const index = next.soFilled + 1;
  const long = dca.direction === "long";
  const deviationPct = dca.priceDeviationPct * dca.stepScale ** next.soFilled;
  const price = roundMoney(anchorPrice * (1 + (long ? -1 : 1) * (deviationPct / 100)));
  if (!(price > 0) || !Number.isFinite(price)) return;
  const qty = roundMoney(dca.safetyOrderQuote * dca.volumeScale ** (index - 1) / price);
  if (!(qty > 0)) return;
  const key = nextKey(next, ctx);
  next.pendingSafety = { key, index, qty, price };
  intents.push({ kind: "placeSafetyLimit", key, side: entrySide(dca), index, qty, price });
}

function nextKey(next: DcaStateV1, ctx: DcaStepContextV1): string {
  const key = dcaTransitionKey(ctx.botId, next.cycle, next.ordinal);
  next.ordinal += 1;
  return key;
}

function levelPrice(entry: number, pct: number, direction: 1 | -1): number {
  return entry * (1 + direction * (pct / 100));
}

export function entrySide(dca: Pick<DcaParamsV1, "direction">): Side {
  return dca.direction === "long" ? "buy" : "sell";
}

export function exitSide(dca: Pick<DcaParamsV1, "direction">): Side {
  return dca.direction === "long" ? "sell" : "buy";
}

function roundMoney(value: number): number {
  return Math.round(value * MONEY_SCALE) / MONEY_SCALE;
}

function validateContext(ctx: DcaStepContextV1): void {
  if (
    !ctx.botId.trim()
    || !Number.isFinite(ctx.feePct) || ctx.feePct < 0 || ctx.feePct > 100
    || !Number.isFinite(ctx.slipPct) || ctx.slipPct < 0 || ctx.slipPct > 100
  ) {
    throw new Error("DCA machine context violates the paper fill-model envelope");
  }
}
