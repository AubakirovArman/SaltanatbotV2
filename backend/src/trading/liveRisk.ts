import { buildLiveRiskReservations, pendingMatchesReservation, requestedOpenOrderSlots, riskIncreasingActions } from "./liveRiskReservations.js";
import type { BotConfig, ExchangeAdapter, ExecOrder, OrderJournalRecord, PendingOrder } from "./types.js";

export type LiveRiskConfig = Pick<
  BotConfig,
  "exchange" | "market" | "symbol" | "leverage" | "maxPositionQuote" | "maxOrderQuote" | "maxDailyLossQuote" | "maxOpenOrders"
>;

const supportedNonEntryActions = new Set<ExecOrder["action"]>([
  "close",
  "flatten",
  "cancel",
  "cancelall",
  "cancelorphans",
  "get",
  "set"
]);

const disabledCompoundOrMisleadingLiveActions = new Set<ExecOrder["action"]>([
  "replace",
  "turnover",
  "openorders",
  "spreadentry",
  "cancel",
  "cancelorphans",
  "flatten",
  "set"
]);

export interface LiveRiskContext {
  /** Quantity already committed to this bot's attributed spot inventory. */
  verifiedSpotQuantity?: number;
  /** Gross futures quantity committed by deduplicated fills, even if REST positions lag. */
  accountedFuturesQuantity?: number;
  /** Durable orders that still may become exposure or consume spot inventory. */
  journalOrders?: readonly OrderJournalRecord[];
}

/** Return every live-readiness error so the API can explain all missing caps. */
export function liveRiskValidationErrors(config: LiveRiskConfig): string[] {
  if (config.exchange === "paper") return [];
  const errors: string[] = [];
  requirePositiveFinite(errors, "maxPositionQuote", config.maxPositionQuote);
  requirePositiveFinite(errors, "maxOrderQuote", config.maxOrderQuote);
  requirePositiveFinite(errors, "maxDailyLossQuote", config.maxDailyLossQuote);
  if (!Number.isSafeInteger(config.maxOpenOrders) || (config.maxOpenOrders ?? 0) <= 0) {
    errors.push("maxOpenOrders must be a positive integer");
  }
  if (!Number.isSafeInteger(config.leverage) || config.leverage <= 0) {
    errors.push("leverage must be a positive integer");
  }
  if (config.market === "spot" && config.leverage !== 1) {
    errors.push("spot bots must use leverage 1 because margin spot is not supported");
  }
  if (config.exchange === "binance" && config.market === "spot") {
    errors.push("Binance live spot is disabled until authenticated spot execution accounting is available");
  }
  if (
    Number.isFinite(config.maxOrderQuote)
    && Number.isFinite(config.maxPositionQuote)
    && (config.maxOrderQuote ?? 0) > (config.maxPositionQuote ?? 0)
  ) {
    errors.push("maxOrderQuote cannot exceed maxPositionQuote");
  }
  return errors;
}

export function assertLiveRiskReady(config: LiveRiskConfig): void {
  const errors = liveRiskValidationErrors(config);
  if (errors.length) throw new Error(`Live risk limits are incomplete: ${errors.join("; ")}`);
}

/**
 * Final server-side gate immediately before an order reaches a live adapter.
 * Only commands whose venue semantics and durable lifecycle are exact may
 * pass. Compound entries, broad/misleading mutations, and account-wide flatten
 * fail closed until each child action is independently reconciled.
 */
export async function preflightLiveOrder(
  config: LiveRiskConfig,
  order: ExecOrder,
  adapter: ExchangeAdapter,
  _cachedBotPrice: number,
  realizedPnlToday: number,
  context: LiveRiskContext = {}
): Promise<void> {
  if (config.exchange === "paper") return;
  assertLiveRiskReady(config);

  if (adapter.id !== config.exchange || adapter.market !== config.market) {
    throw new Error(`Live adapter ${adapter.id}/${adapter.market} does not match bot ${config.exchange}/${config.market}`);
  }

  if (order.symbol !== config.symbol) {
    throw new Error(`Live order symbol ${order.symbol} does not match bot symbol ${config.symbol}`);
  }
  if (order.market !== config.market) {
    throw new Error(`Live order market ${order.market} does not match bot market ${config.market}`);
  }
  if (!riskIncreasingActions.has(order.action) && !supportedNonEntryActions.has(order.action)) {
    throw new Error(`Live order action ${order.action} is not supported`);
  }
  if (disabledCompoundOrMisleadingLiveActions.has(order.action)) {
    throw new Error(`Live ${order.action} is disabled until every mutation has an independent durable lifecycle and exact venue semantics`);
  }
  if (config.market === "spot" && (order.action === "close" || order.action === "flatten")) {
    throw new Error("Live spot exits must be normalized to an attributed sell order before preflight");
  }

  if (order.leverage !== undefined && (!Number.isSafeInteger(order.leverage) || order.leverage <= 0)) {
    throw new Error("Order leverage must be a positive integer");
  }
  if (order.leverage !== undefined && order.leverage > config.leverage) {
    throw new Error(`Order leverage ${order.leverage}x exceeds the bot limit ${config.leverage}x`);
  }

  if (!riskIncreasingActions.has(order.action)) return;
  // Binance/Bybit futures carry reduceOnly on the actual order. Spot adapters
  // do not, so a user-supplied spot flag must never bypass exposure limits.
  if (config.market === "futures" && order.reduceOnly) return;
  if (order.side !== "buy" && order.side !== "sell") {
    throw new Error("Live risk-increasing order requires an explicit side");
  }
  if (!finitePositive(order.qty)) {
    throw new Error("Live risk-increasing order requires an explicit positive base quantity for durable reservation");
  }
  if (!context.journalOrders) {
    throw new Error("Live risk cannot be measured without the durable order journal");
  }
  const reservations = buildLiveRiskReservations(config, context.journalOrders);

  if (config.market === "spot") {
    if (!finiteNonNegative(context.verifiedSpotQuantity)) throw new Error("Live spot risk cannot be measured without verified bot inventory");
  }

  if (!adapter.orders) throw new Error("Exchange adapter cannot verify live order and position limits");
  const existing = await adapter.orders(order.symbol);
  const venueCoverage = reconcileVenueOrders(existing, reservations, order.symbol, config.market);
  const unmatchedVenueOrders = venueCoverage.unmatched;

  if (config.market === "spot") {
    if (order.side === "sell") {
      const pendingSellQty = venueCoverage.covered.reduce(
        (total, item) => item.reservation.side === "sell" ? total + coveredQuantity(item) : total,
        0
      ) + unmatchedVenueOrders.reduce(
        (total, pending) => pending.side === "sell" ? total + requiredPendingQuantity(pending) : total,
        0
      );
      if (order.qty + pendingSellQty > (context.verifiedSpotQuantity as number) + Number.EPSILON) {
        throw new Error("Spot sell exceeds this bot's verified attributed inventory");
      }
      return;
    }
  }
  if (!Number.isFinite(realizedPnlToday)) throw new Error("Live daily PnL cannot be measured");
  if (realizedPnlToday <= -(config.maxDailyLossQuote as number)) {
    throw new Error(`Daily loss limit ${config.maxDailyLossQuote} has been reached`);
  }
  if (order.market === "futures" && order.leverage === undefined) order.leverage = config.leverage;

  // Always read the exact requested venue instrument immediately before the
  // risk decision. A cached candle or client-supplied market price is not an
  // execution quote and cannot be allowed to shrink measured exposure.
  const venuePrice = await adapter.price(order.symbol);
  if (!finitePositive(venuePrice)) throw new Error("Live order risk cannot be measured without a current positive venue price");
  const orderPrice = conservativeOrderPrice(order, venuePrice);
  const notional = order.qty * orderPrice;
  if (!finitePositive(notional)) throw new Error("Live order risk cannot be measured from the supplied quantity");
  if (notional > (config.maxOrderQuote as number)) {
    throw new Error(`Order notional ${round(notional)} exceeds maxOrderQuote ${config.maxOrderQuote}`);
  }

  let currentExposure: number;
  if (config.market === "spot") {
    currentExposure = (context.verifiedSpotQuantity as number) * venuePrice
      + reservationExposure(venueCoverage.covered.filter((item) => item.reservation.side === "buy"), venuePrice);
  } else {
    if (!adapter.positions) throw new Error("Exchange adapter cannot verify every futures position");
    const positions = await adapter.positions();
    const exactPositions = positions.filter((position) => position.symbol === order.symbol);
    if (order.positionSide !== undefined) {
      const expected = order.side === "buy" ? "long" : "short";
      if (order.positionSide !== expected) throw new Error("Futures entry side conflicts with the requested hedge position side");
    } else if (exactPositions.some((position) => (
      (position.side === "long" && order.side === "sell") || (position.side === "short" && order.side === "buy")
    ))) {
      throw new Error("Opposing futures entries require an explicit reduce-only close or hedge position side");
    }
    const venuePositionQty = exactPositions.reduce((total, position) => {
      if (position.symbol !== order.symbol) return total;
      if (!finitePositive(position.qty)) throw new Error("Live futures risk cannot be measured from a position quantity");
      return total + Math.abs(position.qty);
    }, 0);
    if (!finiteNonNegative(context.accountedFuturesQuantity)) {
      throw new Error("Live futures risk cannot be measured without the durable futures exposure ledger");
    }
    currentExposure = Math.max(venuePositionQty, context.accountedFuturesQuantity) * venuePrice;
    currentExposure += reservationExposure(venueCoverage.covered, venuePrice);
  }

  const unmatchedVenueExposure = unmatchedVenueOrders.reduce((total, pending) => {
    if (config.market === "futures" && pending.reduceOnly) return total;
    if (config.market === "spot" && pending.side === "sell") return total;
    const qty = requiredPendingQuantity(pending);
    const pendingPrice = Math.max(
      venuePrice,
      finitePositive(pending.price) ? pending.price : 0,
      finitePositive(pending.trgPrice) ? pending.trgPrice : 0
    );
    return total + qty * pendingPrice;
  }, 0);
  const projectedExposure = currentExposure + unmatchedVenueExposure + notional;
  if (projectedExposure > (config.maxPositionQuote as number)) {
    throw new Error(`Projected position ${round(projectedExposure)} exceeds maxPositionQuote ${config.maxPositionQuote}`);
  }

  const journalOpenOrders = venueCoverage.covered.reduce(
    (total, item) => total + Math.max(item.reservation.openOrderSlots, item.pending ? 1 : 0),
    0
  );
  const existingOpenOrders = journalOpenOrders + unmatchedVenueOrders.length;
  const proposedOrders = requestedOpenOrderSlots(order);
  if (existingOpenOrders + proposedOrders > (config.maxOpenOrders as number)) {
    throw new Error(`Open-order limit ${config.maxOpenOrders} would be exceeded (${existingOpenOrders} existing/reserved + ${proposedOrders} proposed)`);
  }
}

function conservativeOrderPrice(order: ExecOrder, venuePrice: number): number {
  if (order.type === "market") return venuePrice;
  return Math.max(
    venuePrice,
    finitePositive(order.price) ? order.price : 0,
    finitePositive(order.trgPrice) ? order.trgPrice : 0
  );
}

function reservationExposure(
  covered: CoveredReservation[],
  venuePrice: number
): number {
  return covered.reduce((total, item) => {
    const { reservation, pending } = item;
    const price = Math.max(
      venuePrice,
      finitePositive(reservation.price) ? reservation.price : 0,
      finitePositive(reservation.trgPrice) ? reservation.trgPrice : 0,
      finitePositive(pending?.price) ? pending.price : 0,
      finitePositive(pending?.trgPrice) ? pending.trgPrice : 0
    );
    return total + coveredQuantity(item) * price;
  }, 0);
}

interface CoveredReservation {
  reservation: ReturnType<typeof buildLiveRiskReservations>[number];
  pending?: PendingOrder;
}

function reconcileVenueOrders(
  existing: readonly PendingOrder[],
  reservations: ReturnType<typeof buildLiveRiskReservations>,
  symbol: string,
  market: BotConfig["market"]
): { covered: CoveredReservation[]; unmatched: PendingOrder[] } {
  const matchedReservations = new Set<number>();
  const matchedOrders = new Map<number, PendingOrder>();
  const unmatched: PendingOrder[] = [];
  for (const pending of existing) {
    if (pending.symbol !== symbol) throw new Error("Exchange adapter returned an order for the wrong symbol");
    requiredPendingQuantity(pending);
    validatePendingPrice(pending.price);
    validatePendingPrice(pending.trgPrice);
    const candidates = reservations.flatMap((reservation, index) => pendingMatchesReservation(pending, reservation) ? [index] : []);
    if (candidates.length > 1) throw new Error(`Venue order ${pending.id} matches multiple durable reservations`);
    const match = candidates[0];
    if (match === undefined) {
      unmatched.push(pending);
      continue;
    }
    if (matchedReservations.has(match)) throw new Error(`Multiple venue orders match durable reservation ${reservations[match]?.id}`);
    const reservation = reservations[match];
    if (!reservation || reservation.side !== pending.side) {
      throw new Error(`Venue order ${pending.id} conflicts with its durable reservation side`);
    }
    if (market === "futures" && pending.reduceOnly) {
      throw new Error(`Venue order ${pending.id} conflicts with a risk-increasing durable reservation`);
    }
    matchedReservations.add(match);
    matchedOrders.set(match, pending);
  }
  return {
    covered: reservations.map((reservation, index) => ({ reservation, pending: matchedOrders.get(index) })),
    unmatched
  };
}

function coveredQuantity(item: CoveredReservation): number {
  return Math.max(item.reservation.remainingQty, item.pending ? requiredPendingQuantity(item.pending) : 0);
}

function requiredPendingQuantity(pending: PendingOrder): number {
  if (!finitePositive(pending.qty)) {
    throw new Error("Live position risk cannot be measured from an existing order quantity");
  }
  return pending.qty;
}

function validatePendingPrice(value: number | undefined): void {
  if (value !== undefined && !finitePositive(value)) {
    throw new Error("Live position risk cannot be measured from an existing order price");
  }
}

function requirePositiveFinite(errors: string[], field: string, value: number | undefined): void {
  if (!finitePositive(value)) errors.push(`${field} must be greater than zero`);
}

function finitePositive(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

function finiteNonNegative(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? -1) >= 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
