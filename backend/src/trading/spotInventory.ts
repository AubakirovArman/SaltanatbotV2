import { getRuntimeConfig } from "../config/runtimeConfig.js";
import { getSetting, insertFill, setSetting } from "./store.js";
import { recordFuturesExposure } from "./futuresExposure.js";
import type { ExecOrder, FillRecord, MarketType } from "./types.js";

export const SPOT_INVENTORY_MODEL_VERSION = 1;

export function liveSpotInventoryEnabled(): boolean {
  const armed = getRuntimeConfig().trading.enableLiveSpot || getSetting<boolean>("liveSpotEnabled") === true;
  return armed && SPOT_INVENTORY_MODEL_VERSION === 1;
}

export interface SpotInventory {
  version: typeof SPOT_INVENTORY_MODEL_VERSION;
  botId: string;
  symbol: string;
  baseAsset: string;
  remainingQty: number;
  avgPrice: number;
  fees: Record<string, number>;
  lastFillId: string;
  updatedAt: number;
}

export function inventoryKey(botId: string, symbol: string) {
  return `inventory:${botId}:${symbol}`;
}

export function getSpotInventory(botId: string, symbol: string): SpotInventory | undefined {
  const inventory = getSetting<SpotInventory>(inventoryKey(botId, symbol));
  return inventory?.version === SPOT_INVENTORY_MODEL_VERSION ? inventory : undefined;
}

/** Persist a deduplicated confirmed fill and advance bot-attributed spot inventory. */
export function recordConfirmedFill(fill: FillRecord, market: MarketType): boolean {
  const inserted = insertFill(fill);
  if (!inserted) return false;
  if (market === "spot") {
    const next = applySpotFill(getSpotInventory(fill.botId, fill.symbol), fill);
    setSetting(inventoryKey(fill.botId, fill.symbol), next);
  } else {
    recordFuturesExposure(fill);
  }
  return true;
}

export function applySpotFill(current: SpotInventory | undefined, fill: FillRecord): SpotInventory {
  const baseAsset = spotBaseAsset(fill.symbol);
  const fees = { ...(current?.fees ?? {}) };
  if (fill.feeAsset && fill.fee > 0) fees[fill.feeAsset] = (fees[fill.feeAsset] ?? 0) + fill.fee;
  const priorQty = current?.remainingQty ?? 0;
  const priorCost = priorQty * (current?.avgPrice ?? 0);
  let remainingQty = priorQty;
  let avgPrice = current?.avgPrice ?? 0;
  if (fill.side === "buy") {
    const acquired = Math.max(0, fill.qty - (fill.feeAsset === baseAsset ? fill.fee : 0));
    const quoteFee = fill.feeAsset && fill.feeAsset !== baseAsset ? fill.fee : 0;
    remainingQty = priorQty + acquired;
    avgPrice = remainingQty > 0 ? (priorCost + fill.qty * fill.price + quoteFee) / remainingQty : 0;
  } else {
    const removed = fill.qty + (fill.feeAsset === baseAsset ? fill.fee : 0);
    remainingQty = Math.max(0, priorQty - removed);
    if (remainingQty === 0) avgPrice = 0;
  }
  return {
    version: SPOT_INVENTORY_MODEL_VERSION,
    botId: fill.botId,
    symbol: fill.symbol,
    baseAsset,
    remainingQty,
    avgPrice,
    fees,
    lastFillId: fill.id,
    updatedAt: fill.ts
  };
}

export function resolveSpotCloseQuantity(inventory: SpotInventory | undefined, percent = 100): number {
  if (!inventory || inventory.remainingQty <= 0 || !Number.isFinite(percent) || percent <= 0) return 0;
  return (inventory.remainingQty * Math.min(100, percent)) / 100;
}

/** Replace account-wide closePct with this bot's confirmed attributed quantity. */
export function constrainSpotInventoryOrder(botId: string, configuredMarket: MarketType, order: ExecOrder): ExecOrder {
  if (configuredMarket !== "spot") return order;
  const isPositionExit = order.action === "close" || order.action === "flatten";
  if (!isPositionExit && order.closePct === undefined) return order;
  const qty = resolveSpotCloseQuantity(getSpotInventory(botId, order.symbol), order.closePct ?? 100);
  if (qty <= 0) throw new Error("Spot close refused: this bot has no confirmed attributed inventory.");
  return { ...order, action: "neworder", market: "spot", side: "sell", qty, closePct: undefined, reduceOnly: true };
}

function spotBaseAsset(symbol: string): string {
  for (const quote of ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "EUR", "USD"]) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) return symbol.slice(0, -quote.length);
  }
  return symbol;
}
