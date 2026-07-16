import type { ExecOrder, MarketType, TpLevel } from "../types.js";
import { addExactDecimals, adjustByPercentToIncrement, assertFreshSymbolFilters, checkMinimums, checkPriceBounds, compareExactDecimals, floorPercentToIncrement, floorToIncrement, InstrumentRulesError, quantityIncrement, requirePositiveDecimal, type SymbolFilters } from "./filters.js";

export interface PreparedProtectionLevel {
  triggerPrice: string;
  quantity?: string;
}

export interface PreparedLiveOrder {
  filters: SymbolFilters;
  quantity: string;
  referencePrice: string;
  /** Present only for a resting LIMIT entry. */
  limitPrice?: string;
  /** Present for stop/take-profit entry order types. */
  entryTriggerPrice?: string;
  entryTriggerDirection?: 1 | 2;
  stopTriggerPrice?: string;
  takeProfits: PreparedProtectionLevel[];
}

export interface PreparedMarketExit {
  filters: SymbolFilters;
  quantity: string;
  referencePrice: string;
}

/**
 * Validate and quantize the entry plus every requested protection child before
 * the adapter is allowed to make its first signed mutation.
 */
export function prepareLiveOrder(input: {
  exchange: "binance" | "bybit";
  market: MarketType;
  order: ExecOrder;
  referencePrice: number;
  rawQuantity: number;
  filters: SymbolFilters;
}): PreparedLiveOrder {
  const { exchange, market, order, filters } = input;
  assertFreshSymbolFilters(filters, { exchange, market, symbol: order.symbol });
  assertLiveOrderShape(order, exchange, market);
  const referencePrice = requirePositiveDecimal(input.referencePrice, `${order.symbol} reference price`);
  const marketOrder = order.type !== "limit";
  const quantity = floorToIncrement(input.rawQuantity, quantityIncrement(filters, marketOrder));
  requireNonZero(quantity, `${order.symbol} quantity quantizes to zero`);

  let limitPrice: string | undefined;
  let entryTriggerPrice: string | undefined;
  let entryTriggerDirection: 1 | 2 | undefined;
  let minimumPrice = referencePrice;
  if (order.type === "limit") {
    if (order.price === undefined) throw new InstrumentRulesError(`Limit order price is required for ${order.symbol}`);
    limitPrice = floorToIncrement(order.price, filters.tickSize);
    requireNonZero(limitPrice, `${order.symbol} limit price quantizes to zero`);
    minimumPrice = limitPrice;
  } else if (order.type.includes("stop") || order.type.includes("tp")) {
    if (order.trgPrice === undefined) throw new InstrumentRulesError(`Trigger price is required for ${order.symbol}`);
    entryTriggerPrice = floorToIncrement(order.trgPrice, filters.tickSize);
    requireNonZero(entryTriggerPrice, `${order.symbol} trigger price quantizes to zero`);
    const relation = compareExactDecimals(entryTriggerPrice, referencePrice);
    if (relation === 0) throw new InstrumentRulesError(`${order.symbol} trigger price equals the current reference price`);
    entryTriggerDirection = relation > 0 ? 1 : 2;
    minimumPrice = entryTriggerPrice;
  }
  rejectMinimumViolation(quantity, minimumPrice, filters, marketOrder, order.type !== "market", `${order.symbol} entry`);

  const buy = order.side !== "sell";
  const stopTriggerPrice = order.stop ? protectionTrigger(referencePrice, order.stop.basis, order.stop.value, buy ? "below" : "above", filters, "stop-loss") : undefined;
  const takeProfits = (order.takeProfits ?? []).map((level) => prepareTakeProfit(level, referencePrice, quantity, buy, filters, exchange === "binance", exchange === "binance" && order.positionSide === undefined));
  if (exchange === "binance" && compareExactDecimals(addExactDecimals(takeProfits.map((level) => level.quantity!)), quantity) > 0) {
    throw new InstrumentRulesError("Aggregate take-profit quantity exceeds the prepared entry quantity");
  }
  return { filters, quantity, referencePrice, limitPrice, entryTriggerPrice, entryTriggerDirection, stopTriggerPrice, takeProfits };
}

/** Shape-only checks run before private balance sizing as well as in final preparation. */
export function assertLiveOrderShape(order: ExecOrder, exchange: "binance" | "bybit", market: MarketType): void {
  if (order.side !== "buy" && order.side !== "sell") throw new InstrumentRulesError(`Entry side is required for ${order.symbol}`);
  if (order.type === "stop_limit" || order.type === "tp_limit") throw new InstrumentRulesError("Live conditional limit entries are not supported");
  if (order.type === "limit" && order.price === undefined) throw new InstrumentRulesError(`Limit order price is required for ${order.symbol}`);
  if ((order.type.includes("stop") || order.type.includes("tp")) && order.trgPrice === undefined) {
    throw new InstrumentRulesError(`Trigger price is required for ${order.symbol}`);
  }
  if (market === "spot" && (order.stop || order.takeProfits?.length)) {
    throw new InstrumentRulesError("Attached live spot protection is not supported");
  }
  if (order.leverage !== undefined && (!Number.isSafeInteger(order.leverage) || order.leverage <= 0)) {
    throw new InstrumentRulesError("Live leverage must be a positive integer");
  }
  if (exchange === "bybit" && (order.takeProfits?.length ?? 0) > 1) {
    throw new InstrumentRulesError("Bybit full-position protection supports one take-profit level");
  }
  if (exchange === "bybit") {
    const index = order.positionIndex;
    if (index !== undefined && index !== 0 && index !== 1 && index !== 2) throw new InstrumentRulesError("Bybit positionIndex must be 0, 1 or 2");
    const sideIndex = order.positionSide === "long" ? 1 : order.positionSide === "short" ? 2 : undefined;
    if (index !== undefined && sideIndex !== undefined && index !== sideIndex) throw new InstrumentRulesError("Bybit positionIndex conflicts with positionSide");
  }
  for (const level of order.takeProfits ?? []) {
    requirePositiveDecimal(level.price, "take-profit price");
    requirePositiveDecimal(level.qty, "take-profit quantity");
    if (level.limitPrice !== undefined) throw new InstrumentRulesError("Live limit take-profit protection is not supported");
  }
  if (order.stop) requirePositiveDecimal(order.stop.value, "stop-loss value");
}

export function assertClosePercentage(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new InstrumentRulesError("closePct must be greater than 0 and no more than 100");
}

export function prepareMarketExit(input: {
  exchange: "binance" | "bybit";
  market: MarketType;
  symbol: string;
  quantity: number;
  referencePrice: string | number;
  filters: SymbolFilters;
  reduceOnly: boolean;
}): PreparedMarketExit {
  const { exchange, market, symbol, filters } = input;
  assertFreshSymbolFilters(filters, { exchange, market, symbol });
  const quantity = floorToIncrement(input.quantity, quantityIncrement(filters, true));
  requireNonZero(quantity, `${symbol} exit quantity quantizes to zero`);
  const referencePrice = requirePositiveDecimal(input.referencePrice, `${symbol} reference price`);
  const skipMinNotional = input.reduceOnly && exchange === "binance" && market === "futures";
  rejectMinimumViolation(quantity, referencePrice, filters, true, false, `${symbol} exit`, {
    skipMinNotional,
    durableChunkRequired: input.reduceOnly && market === "futures"
  });
  return { filters, quantity, referencePrice };
}

function prepareTakeProfit(level: TpLevel, referencePrice: string, entryQuantity: string, buy: boolean, filters: SymbolFilters, requiresQuantity: boolean, skipMinNotional: boolean): PreparedProtectionLevel {
  const triggerPrice = protectionTrigger(referencePrice, level.priceBasis, level.price, buy ? "above" : "below", filters, "take-profit");
  if (!requiresQuantity) {
    const requested = level.qtyBasis === "percent" ? requirePositiveDecimal(level.qty, "Bybit full-position take-profit percent") : requirePositiveDecimal(level.qty, "Bybit full-position take-profit quantity");
    const expected = level.qtyBasis === "percent" ? "100" : entryQuantity;
    if (compareExactDecimals(requested, expected) !== 0) {
      throw new InstrumentRulesError("Bybit full-position take-profit requires exactly 100% of the prepared entry quantity");
    }
    return { triggerPrice };
  }
  const quantity = level.qtyBasis === "abs" ? floorToIncrement(level.qty, quantityIncrement(filters, true)) : floorPercentToIncrement(entryQuantity, level.qty, quantityIncrement(filters, true));
  requireNonZero(quantity, "take-profit quantity quantizes to zero");
  rejectMinimumViolation(quantity, triggerPrice, filters, true, true, "take-profit child", { skipMinNotional });
  return { triggerPrice, quantity };
}

function protectionTrigger(referencePrice: string, basis: "percent" | "price", value: number, direction: "above" | "below", filters: SymbolFilters, label: string): string {
  requirePositiveDecimal(value, `${label} value`);
  const raw = basis === "price" ? floorToIncrement(value, filters.tickSize) : adjustByPercentToIncrement(referencePrice, value, direction, filters.tickSize);
  const trigger = raw;
  requireNonZero(trigger, `${label} price quantizes to zero`);
  const relation = compareExactDecimals(trigger, referencePrice);
  if ((direction === "above" && relation <= 0) || (direction === "below" && relation >= 0)) {
    throw new InstrumentRulesError(`${label} must remain ${direction} the reference price after tick quantization`);
  }
  const violation = checkPriceBounds(trigger, filters);
  if (violation) throw new InstrumentRulesError(`${label} rejected: ${violation}`);
  return trigger;
}

function rejectMinimumViolation(quantity: string, price: string, filters: SymbolFilters, marketOrder: boolean, validatePriceBounds: boolean, label: string, options: { skipMinNotional?: boolean; durableChunkRequired?: boolean } = {}): void {
  const { durableChunkRequired, ...ruleOptions } = options;
  const violation = checkMinimums(quantity, price, filters, { marketOrder, validatePriceBounds, ...ruleOptions });
  if (violation?.includes("above maxQty") && durableChunkRequired) {
    throw new InstrumentRulesError(`${label} rejected: ${violation}; multi-order close requires durable chunk intents`);
  }
  if (violation) throw new InstrumentRulesError(`${label} rejected: ${violation}`);
}

function requireNonZero(value: string, message: string): void {
  if (value === "0") throw new InstrumentRulesError(message);
}
