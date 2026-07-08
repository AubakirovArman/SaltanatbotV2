import { createHmac } from "node:crypto";
import type {
  AccountState,
  ExchangeAdapter,
  ExecOrder,
  ExecResult,
  MarketType,
  OrderType,
  PendingOrder,
  PositionState
} from "../types.js";
import { binanceFilters, checkMinimums, roundToStep, roundToTick, type SymbolFilters } from "./filters.js";

export interface ExchangeKeys {
  apiKey: string;
  apiSecret: string;
}

/**
 * Binance adapter (Spot + USDT-M Futures). Uses signed REST with HMAC-SHA256.
 * Public price reads need no keys; account / position / order calls require the
 * user's API keys (stored encrypted). Order type is MARKET.
 */
export class BinanceAdapter implements ExchangeAdapter {
  readonly id = "binance" as const;
  readonly market: MarketType;

  constructor(
    private readonly botId: string,
    private readonly keys: ExchangeKeys,
    market: MarketType
  ) {
    this.market = market;
  }

  private get base() {
    return this.market === "futures" ? "https://fapi.binance.com" : "https://api.binance.com";
  }

  async price(symbol: string): Promise<number> {
    const path = this.market === "futures" ? "/fapi/v1/ticker/price" : "/api/v3/ticker/price";
    const res = await fetch(`${this.base}${path}?symbol=${symbol}`);
    if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
    const data = (await res.json()) as { price: string };
    return Number(data.price);
  }

  async account(): Promise<AccountState> {
    if (this.market === "futures") {
      const rows = (await this.signed("GET", "/fapi/v2/balance")) as Array<{ asset: string; balance: string; availableBalance: string }>;
      const usdt = rows.find((row) => row.asset === "USDT");
      const balance = Number(usdt?.balance ?? 0);
      return { balance, equity: balance, currency: "USDT" };
    }
    const data = (await this.signed("GET", "/api/v3/account")) as { balances: Array<{ asset: string; free: string; locked: string }> };
    const usdt = data.balances.find((row) => row.asset === "USDT");
    const balance = Number(usdt?.free ?? 0) + Number(usdt?.locked ?? 0);
    return { balance, equity: balance, currency: "USDT" };
  }

  async position(symbol: string): Promise<PositionState | null> {
    if (this.market !== "futures") return null;
    const rows = (await this.signed("GET", "/fapi/v2/positionRisk", { symbol })) as Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      leverage: string;
    }>;
    const row = rows.find((item) => item.symbol === symbol);
    const amt = Number(row?.positionAmt ?? 0);
    if (!row || amt === 0) return null;
    return {
      symbol,
      side: amt > 0 ? "long" : "short",
      qty: Math.abs(amt),
      entryPrice: Number(row.entryPrice),
      leverage: Number(row.leverage),
      openedAt: Date.now()
    };
  }

  async orders(symbol?: string): Promise<PendingOrder[]> {
    const path = this.market === "futures" ? "/fapi/v1/openOrders" : "/api/v3/openOrders";
    const rows = (await this.signed("GET", path, symbol ? { symbol } : {})) as Array<{
      symbol: string;
      clientOrderId?: string;
      orderId: number;
      side: string;
      type: string;
      origQty: string;
      price: string;
      stopPrice?: string;
      reduceOnly?: boolean;
      timeInForce?: string;
      time?: number;
    }>;
    return rows.map((row) => ({
      id: String(row.orderId),
      clientId: row.clientOrderId,
      symbol: row.symbol,
      side: row.side === "SELL" ? "sell" : "buy",
      type: mapBinanceType(row.type),
      qty: Number(row.origQty),
      price: Number(row.price) || undefined,
      trgPrice: row.stopPrice ? Number(row.stopPrice) || undefined : undefined,
      reduceOnly: !!row.reduceOnly,
      tif: (row.timeInForce as PendingOrder["tif"]) ?? "GTC",
      createdAt: row.time ?? Date.now()
    }));
  }

  async execute(order: ExecOrder): Promise<ExecResult> {
    try {
      switch (order.action) {
        case "close":
        case "flatten": {
          const pos = await this.position(order.symbol);
          if (!pos) return { ok: false, message: `No position on ${order.symbol}`, fills: [] };
          const closeQty = pos.qty * ((order.closePct ?? 100) / 100);
          await this.placeMarket(order.symbol, pos.side === "long" ? "SELL" : "BUY", closeQty, true);
          return { ok: true, message: `Closed ${order.symbol}`, fills: [], position: null, account: await this.account() };
        }
        case "cancelall":
        case "cancel":
        case "cancelorphans":
          await this.cancelAll(order.symbol);
          return { ok: true, message: `Cancelled orders on ${order.symbol}`, fills: [] };
        case "set":
          return this.applySet(order);
        case "get":
          return this.getInfo(order);
        case "turnover": {
          const pos = await this.position(order.symbol);
          if (pos) await this.placeMarket(order.symbol, pos.side === "long" ? "SELL" : "BUY", pos.qty, true);
          return this.placeEntry(order);
        }
        default:
          return this.placeEntry(order);
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Binance error", fills: [] };
    }
  }

  private async placeEntry(order: ExecOrder): Promise<ExecResult> {
    const side = order.side === "sell" ? "SELL" : "BUY";
    if (this.market === "futures" && order.leverage) {
      await this.signed("POST", "/fapi/v1/leverage", { symbol: order.symbol, leverage: String(Math.round(order.leverage)) }).catch(() => undefined);
    }
    const price = await this.price(order.symbol);
    const filters = await binanceFilters(order.symbol, this.market).catch(() => undefined);
    const rawQty = this.resolveQty(order, price);
    const qty = roundToStep(rawQty, filters?.stepSize);
    // Reject exchange-filter violations up front with a clear reason.
    const violation = checkMinimums(qty, order.type === "limit" ? order.price ?? price : price, filters);
    if (violation) return { ok: false, message: `Order rejected on ${order.symbol}: ${violation}`, fills: [] };
    await this.placeOrder(order, side, qty, price, filters);
    // Attached protection (single stop / first TP) for futures.
    if (this.market === "futures" && (order.stop || order.takeProfits?.length)) {
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      if (order.stop) {
        const trg = order.stop.basis === "price" ? order.stop.value : side === "BUY" ? price * (1 - order.stop.value / 100) : price * (1 + order.stop.value / 100);
        try {
          await this.signed("POST", "/fapi/v1/order", { symbol: order.symbol, side: closeSide, type: "STOP_MARKET", stopPrice: fmtPrice(trg, filters), closePosition: "true" });
        } catch (error) {
          // Fail loud: an unprotected position is worse than none. Close it and report.
          await this.placeMarket(order.symbol, closeSide, qty, true).catch(() => undefined);
          const message = error instanceof Error ? error.message : "stop rejected";
          return { ok: false, message: `Stop-loss rejected (${message}) — entry closed for safety`, fills: [], position: await this.position(order.symbol).catch(() => null), account: await this.account().catch(() => undefined) };
        }
      }
      for (const tp of order.takeProfits ?? []) {
        const trg = tp.priceBasis === "price" ? tp.price : side === "BUY" ? price * (1 + tp.price / 100) : price * (1 - tp.price / 100);
        const tpQty = roundToStep(qty * (tp.qtyBasis === "abs" ? 1 : tp.qty / 100), filters?.stepSize);
        await this.signed("POST", "/fapi/v1/order", { symbol: order.symbol, side: closeSide, type: "TAKE_PROFIT_MARKET", stopPrice: fmtPrice(trg, filters), quantity: fmtQty(tpQty, filters), reduceOnly: "true" }).catch(() => undefined);
      }
    }
    return { ok: true, message: `Placed ${order.type} ${side} ${qty} ${order.symbol}`, fills: [], position: await this.position(order.symbol), account: await this.account() };
  }

  private async placeOrder(order: ExecOrder, side: "BUY" | "SELL", qty: number, price: number, filters?: SymbolFilters) {
    const path = this.market === "futures" ? "/fapi/v1/order" : "/api/v3/order";
    const params: Record<string, string> = { symbol: order.symbol, side, quantity: fmtQty(qty, filters) };
    if (order.type === "market") params.type = "MARKET";
    else if (order.type === "limit") { params.type = "LIMIT"; params.price = fmtPrice(order.price ?? price, filters); params.timeInForce = order.tif ?? "GTC"; }
    else { params.type = order.type.includes("stop") ? "STOP_MARKET" : "TAKE_PROFIT_MARKET"; params.stopPrice = fmtPrice(order.trgPrice ?? price, filters); }
    if (this.market === "futures" && order.reduceOnly) params.reduceOnly = "true";
    if (order.clientId) params.newClientOrderId = order.clientId;
    return this.signed("POST", path, params);
  }

  private async cancelAll(symbol: string) {
    if (this.market === "futures") return this.signed("DELETE", "/fapi/v1/allOpenOrders", { symbol });
    const open = (await this.signed("GET", "/api/v3/openOrders", { symbol })) as Array<{ orderId: number }>;
    await Promise.allSettled(open.map((o) => this.signed("DELETE", "/api/v3/order", { symbol, orderId: String(o.orderId) })));
  }

  private async applySet(order: ExecOrder): Promise<ExecResult> {
    if (this.market !== "futures") return { ok: true, message: "SET ignored on spot", fills: [] };
    if (order.setValue === "LEVERAGE" && order.leverage) {
      await this.signed("POST", "/fapi/v1/leverage", { symbol: order.symbol, leverage: String(Math.round(order.leverage)) });
    } else if (order.setValue === "ISOLATEDMARGIN") {
      await this.signed("POST", "/fapi/v1/marginType", { symbol: order.symbol, marginType: order.isolated ? "ISOLATED" : "CROSSED" }).catch(() => undefined);
    } else if (order.setValue === "DUALSIDE") {
      await this.signed("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: order.dualSide ? "true" : "false" }).catch(() => undefined);
    }
    return { ok: true, message: `SET ${order.setValue} applied`, fills: [] };
  }

  private async getInfo(order: ExecOrder): Promise<ExecResult> {
    if (order.getValue === "PRICE" || order.getValue === "SYMPRICE") {
      const price = await this.price(order.symbol);
      return { ok: true, message: `${order.symbol} = ${price}`, fills: [], data: { price } };
    }
    if (order.getValue === "POSITIONS" || order.getValue === "OPENPOS") {
      const pos = await this.position(order.symbol);
      return { ok: true, message: pos ? `${pos.side} ${pos.qty}` : "flat", fills: [], data: pos, position: pos };
    }
    const account = await this.account();
    return { ok: true, message: `balance ${account.balance}`, fills: [], data: account, account };
  }

  private resolveQty(order: ExecOrder, price: number): number {
    const lev = order.levForQty ? Math.max(1, order.leverage ?? 1) : 1;
    if (order.qty !== undefined) return order.qty;
    if (order.quoteQty !== undefined) return (order.quoteQty * lev) / price;
    if (order.openPct !== undefined || order.depoPct !== undefined) return 0; // needs balance; resolved via quote in practice
    if (order.closePct !== undefined) return (order.closePct / 100) / price;
    return 0;
  }

  private async placeMarket(symbol: string, side: "BUY" | "SELL", qty: number, reduceOnly: boolean) {
    const path = this.market === "futures" ? "/fapi/v1/order" : "/api/v3/order";
    const filters = await binanceFilters(symbol, this.market).catch(() => undefined);
    const rounded = roundToStep(qty, filters?.stepSize);
    const params: Record<string, string> = { symbol, side, type: "MARKET", quantity: fmtQty(rounded, filters) };
    if (this.market === "futures" && reduceOnly) params.reduceOnly = "true";
    return this.signed("POST", path, params);
  }

  private async signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}): Promise<any> {
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Binance API keys are not set");
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" });
    const signature = createHmac("sha256", this.keys.apiSecret).update(query.toString()).digest("hex");
    query.append("signature", signature);
    const url = `${this.base}${path}?${query.toString()}`;
    const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": this.keys.apiKey } });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

/** Format qty for the wire: snap to stepSize when known, else the legacy 6-dp trim. */
function fmtQty(qty: number, filters?: SymbolFilters): string {
  const snapped = roundToStep(qty, filters?.stepSize);
  return trimQty(snapped);
}

/** Format a price for the wire: snap to tickSize when known, else legacy 2-dp. */
function fmtPrice(price: number, filters?: SymbolFilters): string {
  if (filters?.tickSize) return trimQty(roundToTick(price, filters.tickSize));
  return price.toFixed(2);
}

function trimQty(qty: number): string {
  return qty.toFixed(8).replace(/\.?0+$/, "");
}

/** Map a Binance order type string to our OrderType enum for portfolio display. */
function mapBinanceType(type: string): OrderType {
  switch (type) {
    case "LIMIT": return "limit";
    case "STOP": case "STOP_LOSS_LIMIT": return "stop_limit";
    case "STOP_MARKET": case "STOP_LOSS": return "stop_market";
    case "TAKE_PROFIT": case "TAKE_PROFIT_LIMIT": return "tp_limit";
    case "TAKE_PROFIT_MARKET": return "tp_market";
    default: return "market";
  }
}
