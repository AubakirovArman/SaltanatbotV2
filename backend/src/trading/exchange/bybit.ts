import { createHmac } from "node:crypto";
import type {
  AccountState,
  ExchangeAdapter,
  ExecOrder,
  ExecResult,
  MarketType,
  PendingOrder,
  PositionState
} from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import { bybitFilters, checkMinimums, roundToStep, roundToTick, type SymbolFilters } from "./filters.js";

/**
 * Bybit adapter (v5 unified API). `linear` category for USDT futures, `spot`
 * for spot. Signed with HMAC-SHA256 over timestamp+key+recvWindow+payload.
 */
export class BybitAdapter implements ExchangeAdapter {
  readonly id = "bybit" as const;
  readonly market: MarketType;
  private readonly base = "https://api.bybit.com";
  private readonly recvWindow = "5000";

  constructor(
    private readonly botId: string,
    private readonly keys: ExchangeKeys,
    market: MarketType
  ) {
    this.market = market;
  }

  private get category() {
    return this.market === "futures" ? "linear" : "spot";
  }

  async price(symbol: string): Promise<number> {
    const res = await fetch(`${this.base}/v5/market/tickers?category=${this.category}&symbol=${symbol}`);
    if (!res.ok) throw new Error(`Bybit price HTTP ${res.status}`);
    const data = (await res.json()) as { result: { list: Array<{ lastPrice: string }> } };
    return Number(data.result.list[0]?.lastPrice);
  }

  async account(): Promise<AccountState> {
    const data = (await this.signed("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })) as {
      result: { list: Array<{ totalEquity: string; totalAvailableBalance: string }> };
    };
    const row = data.result.list[0];
    const equity = Number(row?.totalEquity ?? 0);
    return { balance: Number(row?.totalAvailableBalance ?? equity), equity, currency: "USDT" };
  }

  async position(symbol: string): Promise<PositionState | null> {
    if (this.market !== "futures") return null;
    const data = (await this.signed("GET", "/v5/position/list", { category: this.category, symbol })) as {
      result: { list: Array<{ side: string; size: string; avgPrice: string; leverage: string }> };
    };
    const row = data.result.list.find((item) => Number(item.size) > 0);
    if (!row) return null;
    return {
      symbol,
      side: row.side === "Buy" ? "long" : "short",
      qty: Number(row.size),
      entryPrice: Number(row.avgPrice),
      leverage: Number(row.leverage),
      openedAt: Date.now()
    };
  }

  async orders(symbol?: string): Promise<PendingOrder[]> {
    const params: Record<string, unknown> = { category: this.category };
    if (symbol) params.symbol = symbol;
    else if (this.category === "linear") params.settleCoin = "USDT"; // Bybit requires symbol OR settleCoin for linear.
    const data = (await this.signed("GET", "/v5/order/realtime", params)) as {
      result: { list: Array<{ symbol: string; orderId: string; orderLinkId?: string; side: string; orderType: string; qty: string; price?: string; triggerPrice?: string; reduceOnly?: boolean; timeInForce?: string; createdTime?: string }> };
    };
    return (data.result.list ?? []).map((row) => ({
      id: row.orderId,
      clientId: row.orderLinkId || undefined,
      symbol: row.symbol,
      side: row.side === "Sell" ? "sell" : "buy",
      type: row.triggerPrice && Number(row.triggerPrice) > 0 ? (row.orderType === "Limit" ? "stop_limit" : "stop_market") : row.orderType === "Limit" ? "limit" : "market",
      qty: Number(row.qty),
      price: row.price ? Number(row.price) || undefined : undefined,
      trgPrice: row.triggerPrice ? Number(row.triggerPrice) || undefined : undefined,
      reduceOnly: !!row.reduceOnly,
      tif: (row.timeInForce as PendingOrder["tif"]) ?? "GTC",
      createdAt: row.createdTime ? Number(row.createdTime) : Date.now()
    }));
  }

  async execute(order: ExecOrder): Promise<ExecResult> {
    try {
      switch (order.action) {
        case "close":
        case "flatten": {
          const pos = await this.position(order.symbol);
          if (!pos) return { ok: false, message: `No position on ${order.symbol}`, fills: [] };
          const qty = pos.qty * ((order.closePct ?? 100) / 100);
          await this.createOrder(order, pos.side === "long" ? "Sell" : "Buy", qty, await this.price(order.symbol), true);
          return { ok: true, message: `Closed ${order.symbol}`, fills: [], position: null, account: await this.account() };
        }
        case "cancel":
        case "cancelall":
        case "cancelorphans":
          await this.signed("POST", "/v5/order/cancel-all", { category: this.category, symbol: order.symbol });
          return { ok: true, message: `Cancelled orders on ${order.symbol}`, fills: [] };
        case "set":
          return this.applySet(order);
        case "get":
          return this.getInfo(order);
        case "turnover": {
          const pos = await this.position(order.symbol);
          if (pos) await this.createOrder(order, pos.side === "long" ? "Sell" : "Buy", pos.qty, await this.price(order.symbol), true);
          return this.placeEntry(order);
        }
        default:
          return this.placeEntry(order);
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Bybit error", fills: [] };
    }
  }

  private async placeEntry(order: ExecOrder): Promise<ExecResult> {
    if (this.market === "futures" && order.leverage) {
      await this.signed("POST", "/v5/position/set-leverage", { category: this.category, symbol: order.symbol, buyLeverage: String(order.leverage), sellLeverage: String(order.leverage) }).catch(() => undefined);
    }
    const price = await this.price(order.symbol);
    const filters = await bybitFilters(order.symbol, this.market).catch(() => undefined);
    const qty = roundToStep(this.resolveQty(order, price), filters?.stepSize);
    const violation = checkMinimums(qty, order.type === "limit" ? order.price ?? price : price, filters);
    if (violation) return { ok: false, message: `Order rejected on ${order.symbol}: ${violation}`, fills: [] };
    await this.createOrder(order, order.side === "sell" ? "Sell" : "Buy", qty, price, order.reduceOnly ?? false, filters);
    return { ok: true, message: `Placed ${order.type} ${order.side} ${qty} ${order.symbol}`, fills: [], position: await this.position(order.symbol), account: await this.account() };
  }

  private async applySet(order: ExecOrder): Promise<ExecResult> {
    if (this.market !== "futures") return { ok: true, message: "SET ignored on spot", fills: [] };
    if (order.setValue === "LEVERAGE" && order.leverage) {
      await this.signed("POST", "/v5/position/set-leverage", { category: this.category, symbol: order.symbol, buyLeverage: String(order.leverage), sellLeverage: String(order.leverage) });
    } else if (order.setValue === "ISOLATEDMARGIN") {
      await this.signed("POST", "/v5/position/switch-isolated", { category: this.category, symbol: order.symbol, tradeMode: order.isolated ? 1 : 0, buyLeverage: String(order.leverage ?? 1), sellLeverage: String(order.leverage ?? 1) }).catch(() => undefined);
    } else if (order.setValue === "DUALSIDE") {
      await this.signed("POST", "/v5/position/switch-mode", { category: this.category, symbol: order.symbol, mode: order.dualSide ? 3 : 0 }).catch(() => undefined);
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
    return { ok: true, message: `equity ${account.equity}`, fills: [], data: account, account };
  }

  private resolveQty(order: ExecOrder, price: number): number {
    const lev = order.levForQty ? Math.max(1, order.leverage ?? 1) : 1;
    if (order.qty !== undefined) return order.qty;
    if (order.quoteQty !== undefined) return (order.quoteQty * lev) / price;
    if (order.closePct !== undefined) return (order.closePct / 100) / price;
    return 0;
  }

  private async createOrder(order: ExecOrder, side: "Buy" | "Sell", qty: number, price: number, reduceOnly: boolean, filters?: SymbolFilters) {
    // Close/turnover paths call directly without filters — fetch on demand.
    const flt = filters ?? (await bybitFilters(order.symbol, this.market).catch(() => undefined));
    const params: Record<string, unknown> = {
      category: this.category,
      symbol: order.symbol,
      side,
      qty: fmtNum(roundToStep(qty, flt?.stepSize)),
      orderType: order.type === "limit" ? "Limit" : "Market"
    };
    if (order.type === "limit" && order.price) { params.price = fmtNum(roundToTick(order.price, flt?.tickSize)); params.timeInForce = order.tif ?? "GTC"; }
    if (order.type.includes("stop") || order.type.includes("tp")) {
      params.triggerPrice = fmtNum(roundToTick(order.trgPrice ?? price, flt?.tickSize));
      params.triggerDirection = side === "Sell" ? 2 : 1;
      params.orderType = "Market";
    }
    if (reduceOnly) params.reduceOnly = true;
    if (order.clientId) params.orderLinkId = order.clientId;
    return this.signed("POST", "/v5/order/create", params);
  }

  private async signed(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<any> {
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Bybit API keys are not set");
    const timestamp = String(Date.now());
    let url = `${this.base}${path}`;
    let body = "";
    let payload = "";
    if (method === "GET") {
      const qs = new URLSearchParams(params as Record<string, string>).toString();
      payload = qs;
      url += `?${qs}`;
    } else {
      body = JSON.stringify(params);
      payload = body;
    }
    const sign = createHmac("sha256", this.keys.apiSecret)
      .update(timestamp + this.keys.apiKey + this.recvWindow + payload)
      .digest("hex");
    const res = await fetch(url, {
      method,
      headers: {
        "X-BAPI-API-KEY": this.keys.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": this.recvWindow,
        "X-BAPI-SIGN": sign,
        "Content-Type": "application/json"
      },
      body: method === "POST" ? body : undefined
    });
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { retCode: number; retMsg: string };
    if (json.retCode !== 0) throw new Error(`Bybit: ${json.retMsg}`);
    return json;
  }
}

/** Trim trailing zeros; Bybit rejects e.g. "1.500000" for a whole-number step. */
function fmtNum(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}
