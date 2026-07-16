import type { AccountState, ExchangeAdapter, ExchangeOrderSnapshot, ExecOrder, ExecResult, MarketType, PendingOrder, PositionState } from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import { BybitV5Client } from "./bybitClient.js";
import { assertFreshSymbolFilters, bybitFilters } from "./filters.js";
import { ambiguousAcknowledgement, isAmbiguousExchangeError } from "./errors.js";
import { assertClosePercentage, assertLiveOrderShape, prepareLiveOrder, prepareMarketExit, type PreparedLiveOrder, type PreparedMarketExit } from "./orderRules.js";
import { normalizeBybitOrderStatus } from "./orderStatus.js";
import { subscribeBybitOrders } from "./privateOrderStreams.js";

/**
 * Bybit adapter (v5 unified API). `linear` category for USDT futures, `spot`
 * for spot. Signed with HMAC-SHA256 over timestamp+key+recvWindow+payload.
 */
export class BybitAdapter implements ExchangeAdapter {
  readonly id = "bybit" as const;
  readonly market: MarketType;
  private readonly base = "https://api.bybit.com";
  private readonly client: BybitV5Client;

  constructor(
    private readonly botId: string,
    private readonly keys: ExchangeKeys,
    market: MarketType,
    readonly accountId = "bybit:default"
  ) {
    this.market = market;
    this.client = new BybitV5Client(keys);
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
    const data = await this.signed<{ list: Array<{ totalEquity: string; totalAvailableBalance: string }> }>("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
    const row = data.result.list[0];
    const equity = Number(row?.totalEquity ?? 0);
    return { balance: Number(row?.totalAvailableBalance ?? equity), equity, currency: "USDT" };
  }

  async position(symbol: string): Promise<PositionState | null> {
    if (this.market !== "futures") return null;
    const data = (await this.signed("GET", "/v5/position/list", { category: this.category, symbol })) as {
      result: { list: Array<{ side: string; size: string; avgPrice: string; leverage: string; positionIdx?: number }> };
    };
    const row = data.result.list.find((item) => Number(item.size) > 0);
    if (!row) return null;
    return {
      symbol,
      side: row.side === "Buy" ? "long" : "short",
      qty: Number(row.size),
      entryPrice: Number(row.avgPrice),
      leverage: Number(row.leverage),
      hedged: row.positionIdx === 1 || row.positionIdx === 2,
      positionIndex: row.positionIdx,
      openedAt: Date.now()
    };
  }

  async positions(): Promise<PositionState[]> {
    if (this.market !== "futures") return [];
    const rows: Array<{ symbol: string; side: string; size: string; avgPrice: string; leverage: string; positionIdx?: number }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = (await this.signed("GET", "/v5/position/list", { category: this.category, settleCoin: "USDT", limit: 200, ...(cursor ? { cursor } : {}) })) as {
        result: { list: typeof rows; nextPageCursor?: string };
      };
      rows.push(...(data.result.list ?? []));
      const next = data.result.nextPageCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return rows.flatMap((row) => {
      const qty = Number(row.size);
      if (!Number.isFinite(qty) || qty <= 0) return [];
      return [
        {
          symbol: row.symbol,
          side: row.side === "Buy" ? ("long" as const) : ("short" as const),
          qty,
          entryPrice: Number(row.avgPrice),
          leverage: Number(row.leverage),
          hedged: row.positionIdx === 1 || row.positionIdx === 2,
          positionIndex: row.positionIdx,
          openedAt: Date.now()
        }
      ];
    });
  }

  async orders(symbol?: string): Promise<PendingOrder[]> {
    const params: Record<string, unknown> = { category: this.category, limit: 50 };
    if (symbol) params.symbol = symbol;
    else if (this.category === "linear") params.settleCoin = "USDT"; // Bybit requires symbol OR settleCoin for linear.
    const rows: Array<{ symbol: string; orderId: string; orderLinkId?: string; side: string; orderType: string; qty: string; leavesQty?: string; cumExecQty?: string; price?: string; triggerPrice?: string; reduceOnly?: boolean; timeInForce?: string; createdTime?: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = (await this.signed("GET", "/v5/order/realtime", { ...params, ...(cursor ? { cursor } : {}) })) as {
        result: { list: typeof rows; nextPageCursor?: string };
      };
      rows.push(...(data.result.list ?? []));
      const next = data.result.nextPageCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return rows.map((row) => ({
      id: row.orderId,
      clientId: row.orderLinkId || undefined,
      symbol: row.symbol,
      side: row.side === "Sell" ? "sell" : "buy",
      type: row.triggerPrice && Number(row.triggerPrice) > 0 ? (row.orderType === "Limit" ? "stop_limit" : "stop_market") : row.orderType === "Limit" ? "limit" : "market",
      qty: Math.max(0, row.leavesQty !== undefined ? Number(row.leavesQty) : Number(row.qty) - Number(row.cumExecQty ?? 0)),
      price: row.price ? Number(row.price) || undefined : undefined,
      trgPrice: row.triggerPrice ? Number(row.triggerPrice) || undefined : undefined,
      reduceOnly: !!row.reduceOnly,
      tif: (row.timeInForce as PendingOrder["tif"]) ?? "GTC",
      createdAt: row.createdTime ? Number(row.createdTime) : Date.now()
    }));
  }

  async orderStatus(symbol: string, identity: { orderId?: string; clientId?: string }): Promise<ExchangeOrderSnapshot | null> {
    if (!identity.orderId && !identity.clientId) return null;
    const params: Record<string, unknown> = { category: this.category, symbol, limit: 1 };
    if (identity.orderId) params.orderId = identity.orderId;
    else if (identity.clientId) params.orderLinkId = identity.clientId;
    const data = (await this.signed("GET", "/v5/order/history", params)) as {
      result: { list: Array<{ orderId: string; orderLinkId?: string; orderStatus: string; qty: string; cumExecQty: string; avgPrice?: string; updatedTime?: string; createdTime?: string }> };
    };
    const row = data.result.list[0];
    if (!row) return null;
    return {
      id: row.orderId,
      clientId: row.orderLinkId || undefined,
      status: normalizeBybitOrderStatus(row.orderStatus),
      qty: Number(row.qty),
      filledQty: Number(row.cumExecQty),
      avgFillPrice: Number(row.avgPrice) || undefined,
      updatedAt: Number(row.updatedTime ?? row.createdTime) || Date.now()
    };
  }

  async subscribeOrderUpdates(onSnapshot: (snapshot: ExchangeOrderSnapshot) => void, onConnection: (connected: boolean, message: string) => void) {
    return subscribeBybitOrders(this.keys, { onSnapshot, onConnection });
  }

  async execute(order: ExecOrder): Promise<ExecResult> {
    try {
      switch (order.action) {
        case "close":
        case "flatten": {
          const filters = await bybitFilters(order.symbol, this.market);
          const referencePrice = await this.price(order.symbol);
          assertClosePercentage(order.closePct);
          const pos = order.positionIndex !== undefined ? ((await this.positions()).find((candidate) => candidate.symbol === order.symbol && candidate.positionIndex === order.positionIndex) ?? null) : await this.position(order.symbol);
          if (!pos) return { ok: false, message: `No position on ${order.symbol}`, fills: [] };
          const qty = pos.qty * ((order.closePct ?? 100) / 100);
          const side = pos.side === "long" ? "Sell" : "Buy";
          const submitted = { ...order, side: side === "Sell" ? ("sell" as const) : ("buy" as const), positionIndex: order.positionIndex ?? pos.positionIndex };
          const prepared = prepareMarketExit({ exchange: "bybit", market: this.market, symbol: order.symbol, quantity: qty, referencePrice, filters, reduceOnly: true });
          const placed = (await this.createOrder(submitted, side, prepared, true)) as { result?: { orderId?: string } };
          const exchangeOrderId = placed.result?.orderId;
          return {
            ok: true,
            message: `Close accepted for ${order.symbol}; awaiting authenticated execution accounting`,
            fills: [],
            pendingOrder: exchangeOrderId ? pendingMarketOrder(submitted, exchangeOrderId, Number(prepared.quantity), true) : undefined,
            ...(await this.acceptedState(order.symbol, pos))
          };
        }
        case "cancel":
        case "cancelall":
        case "cancelorphans":
          await this.signed("POST", "/v5/order/cancel-all", { category: this.category, symbol: order.symbol });
          return { ok: true, message: `Cancelled orders on ${order.symbol}`, fills: [] };
        case "set":
          return await this.applySet(order);
        case "get":
          return await this.getInfo(order);
        case "turnover": {
          const preparedEntry = await this.prepareEntry(order);
          const pos = await this.position(order.symbol);
          if (pos) {
            const preparedExit = prepareMarketExit({
              exchange: "bybit",
              market: this.market,
              symbol: order.symbol,
              quantity: pos.qty,
              referencePrice: Number(preparedEntry.referencePrice),
              filters: preparedEntry.filters,
              reduceOnly: true
            });
            await this.createOrder({ ...order, type: "market", positionIndex: pos.positionIndex }, pos.side === "long" ? "Sell" : "Buy", preparedExit, true);
          }
          return await this.submitPreparedEntry(order, preparedEntry);
        }
        case "neworder":
        case "open":
        case "openorders":
        case "spreadentry":
        case "replace":
          return await this.placeEntry(order);
        case "chporders":
          return { ok: false, message: "CHPORDERS is not supported by the Bybit live adapter", fills: [] };
      }
    } catch (error) {
      if (isAmbiguousExchangeError(error)) throw error;
      return { ok: false, message: error instanceof Error ? error.message : "Bybit error", fills: [] };
    }
  }

  private async placeEntry(order: ExecOrder): Promise<ExecResult> {
    return this.submitPreparedEntry(order, await this.prepareEntry(order));
  }

  private async prepareEntry(order: ExecOrder): Promise<PreparedLiveOrder> {
    const price = await this.price(order.symbol);
    const filters = await bybitFilters(order.symbol, this.market);
    assertLiveOrderShape(order, "bybit", this.market);
    const rawQuantity = await this.resolveQty(order, price);
    return prepareLiveOrder({ exchange: "bybit", market: this.market, order, referencePrice: price, rawQuantity, filters });
  }

  private async submitPreparedEntry(order: ExecOrder, prepared: PreparedLiveOrder): Promise<ExecResult> {
    assertFreshSymbolFilters(prepared.filters, { exchange: "bybit", market: this.market, symbol: order.symbol });
    if (this.market === "futures" && order.leverage) {
      await this.ensureLeverage(order.symbol, order.leverage);
    }
    const qty = Number(prepared.quantity);
    order.qty = qty;
    const entryResponse = (await this.createOrder(order, order.side === "sell" ? "Sell" : "Buy", prepared, order.reduceOnly ?? false)) as { result?: { orderId?: string } };
    const entryOrderId = entryResponse.result?.orderId;
    if (this.market === "futures" && (order.stop || order.takeProfits?.length)) {
      if (!entryOrderId) {
        const closeSide = order.side === "sell" ? "Buy" : "Sell";
        const safety = await this.attemptSafetyClose(order, closeSide, qty, prepared);
        return {
          ok: true,
          message: protectionFailureMessage("Entry acknowledgement omitted its order ID", safety),
          fills: [],
          protection: {
            requested: true,
            confirmed: false,
            message: "missing entry order ID",
            safetyCloseAttempted: true,
            safetyCloseConfirmed: safety.confirmed,
            safetyCloseOrderId: safety.orderId,
            safetyCloseClientId: safety.clientId,
            verification: "exchange_ack"
          }
        };
      }
      try {
        await this.applyTradingStop(order, prepared);
      } catch (error) {
        const closeSide = order.side === "sell" ? "Buy" : "Sell";
        const safety = await this.attemptSafetyClose(order, closeSide, qty, prepared);
        const message = error instanceof Error ? error.message : "protection rejected";
        return {
          ok: true,
          message: protectionFailureMessage(`Protection rejected (${message})`, safety),
          fills: [],
          pendingOrder: pendingMarketOrder(order, entryOrderId, qty, false),
          protection: {
            requested: true,
            confirmed: false,
            message,
            entryOrderId,
            safetyCloseAttempted: true,
            safetyCloseConfirmed: safety.confirmed,
            safetyCloseOrderId: safety.orderId,
            safetyCloseClientId: safety.clientId,
            verification: "exchange_ack"
          },
          ...(await this.acceptedState(order.symbol))
        };
      }
      return {
        ok: true,
        message: `Placed ${order.type} ${order.side} ${qty} ${order.symbol}`,
        fills: [],
        pendingOrder: pendingMarketOrder(order, entryOrderId, qty, false),
        protection: { requested: true, confirmed: true, entryOrderId, verification: "exchange_ack" },
        ...(await this.acceptedState(order.symbol))
      };
    }
    return {
      ok: true,
      message: `Placed ${order.type} ${order.side} ${qty} ${order.symbol}`,
      fills: [],
      pendingOrder: entryOrderId ? pendingMarketOrder(order, entryOrderId, qty, false) : undefined,
      ...(await this.acceptedState(order.symbol))
    };
  }

  private async attemptSafetyClose(order: ExecOrder, side: "Buy" | "Sell", qty: number, preparedEntry: PreparedLiveOrder) {
    const clientId = order.protectionClientIds?.safetyClose ?? safetyCloseClientId(order.clientId, this.botId);
    try {
      const prepared = prepareMarketExit({
        exchange: "bybit",
        market: this.market,
        symbol: order.symbol,
        quantity: qty,
        referencePrice: Number(preparedEntry.referencePrice),
        filters: preparedEntry.filters,
        reduceOnly: true
      });
      const placed = (await this.createOrder(
        {
          ...order,
          clientId,
          side: side === "Sell" ? "sell" : "buy",
          type: "market",
          stop: undefined,
          takeProfits: undefined
        },
        side,
        prepared,
        true
      )) as { result?: { orderId?: string } };
      const orderId = placed.result?.orderId;
      if (!orderId) return { confirmed: false, clientId, error: "emergency close acknowledgement omitted its order ID" };
      return { confirmed: true, clientId, orderId };
    } catch (error) {
      return {
        confirmed: false,
        clientId,
        error: error instanceof Error ? error.message : "emergency close rejected"
      };
    }
  }

  private async applySet(order: ExecOrder): Promise<ExecResult> {
    if (this.market !== "futures") return { ok: true, message: "SET ignored on spot", fills: [] };
    await bybitFilters(order.symbol, this.market);
    if (order.setValue === "LEVERAGE" && order.leverage) {
      await this.signed("POST", "/v5/position/set-leverage", { category: this.category, symbol: order.symbol, buyLeverage: String(order.leverage), sellLeverage: String(order.leverage) });
    } else if (order.setValue === "ISOLATEDMARGIN") {
      await this.signed("POST", "/v5/position/switch-isolated", { category: this.category, symbol: order.symbol, tradeMode: order.isolated ? 1 : 0, buyLeverage: String(order.leverage ?? 1), sellLeverage: String(order.leverage ?? 1) });
    } else if (order.setValue === "DUALSIDE") {
      await this.signed("POST", "/v5/position/switch-mode", { category: this.category, symbol: order.symbol, mode: order.dualSide ? 3 : 0 });
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

  private async resolveQty(order: ExecOrder, price: number): Promise<number> {
    const lev = order.levForQty ? Math.max(1, order.leverage ?? 1) : 1;
    if (order.qty !== undefined) return order.qty;
    if (order.quoteQty !== undefined) return (order.quoteQty * lev) / price;
    if (order.closePct !== undefined) {
      if (this.market === "spot") return (await this.spotBaseQty(order.symbol)) * (order.closePct / 100);
      return order.closePct / 100 / price;
    }
    return 0;
  }

  private async spotBaseQty(symbol: string): Promise<number> {
    const base = baseAsset(symbol);
    const data = (await this.signed("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED", coin: base })) as {
      result: { list: Array<{ coin?: Array<{ coin: string; walletBalance?: string; availableToWithdraw?: string }> }> };
    };
    const row = data.result.list[0]?.coin?.find((item) => item.coin === base);
    return Number(row?.availableToWithdraw ?? row?.walletBalance ?? 0);
  }

  private async createOrder(order: ExecOrder, side: "Buy" | "Sell", prepared: PreparedLiveOrder | PreparedMarketExit, reduceOnly: boolean) {
    const params: Record<string, unknown> = {
      category: this.category,
      symbol: order.symbol,
      side,
      qty: prepared.quantity,
      orderType: order.type === "limit" ? "Limit" : "Market"
    };
    if (this.market === "spot" && order.type !== "limit") params.marketUnit = "baseCoin";
    if (order.type === "limit" && "limitPrice" in prepared) {
      params.price = prepared.limitPrice;
      params.timeInForce = order.tif ?? "GTC";
    }
    if (order.type.includes("stop") || order.type.includes("tp")) {
      if (!("entryTriggerPrice" in prepared)) throw new Error("Prepared trigger price is missing");
      params.triggerPrice = prepared.entryTriggerPrice;
      params.triggerDirection = prepared.entryTriggerDirection;
      params.orderType = "Market";
    }
    if (reduceOnly && this.market === "futures") params.reduceOnly = true;
    if (this.market === "futures") params.positionIdx = bybitPositionIndex(order);
    if (order.clientId) params.orderLinkId = order.clientId;
    const response = await this.signed<{ orderId?: unknown }>("POST", "/v5/order/create", params);
    const orderId = response.result?.orderId;
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw ambiguousAcknowledgement("Bybit order", "its order ID was missing");
    }
    return { ...response, result: { ...response.result, orderId } };
  }

  private async applyTradingStop(order: ExecOrder, prepared: PreparedLiveOrder) {
    const params: Record<string, unknown> = {
      category: this.category,
      symbol: order.symbol,
      tpslMode: "Full",
      positionIdx: bybitPositionIndex(order),
      slOrderType: "Market",
      tpOrderType: "Market"
    };
    if (order.stop) {
      params.stopLoss = prepared.stopTriggerPrice;
      params.slTriggerBy = "LastPrice";
    }
    if (order.takeProfits?.[0]) {
      params.takeProfit = prepared.takeProfits[0]!.triggerPrice;
      params.tpTriggerBy = "LastPrice";
    }
    return this.signed("POST", "/v5/position/trading-stop", params);
  }

  private async ensureLeverage(symbol: string, leverage: number): Promise<void> {
    let setError: unknown;
    try {
      await this.signed("POST", "/v5/position/set-leverage", {
        category: this.category,
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage)
      });
      return;
    } catch (error) {
      setError = error;
    }

    try {
      const data = (await this.signed("GET", "/v5/position/list", { category: this.category, symbol })) as {
        result: { list?: Array<{ leverage?: string }> };
      };
      const rows = data.result.list ?? [];
      if (rows.length > 0 && rows.every((row) => Number(row.leverage) === leverage)) return;
    } catch {
      // Preserve the original set failure when exact leverage cannot be read.
    }
    throw setError;
  }

  private async acceptedState(symbol: string, fallback?: PositionState | null) {
    const [position, account] = await Promise.allSettled([this.position(symbol), this.account()]);
    return {
      position: position.status === "fulfilled" ? position.value : fallback,
      account: account.status === "fulfilled" ? account.value : undefined
    };
  }

  private signed<T = any>(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<{ result: T }> {
    return this.client.request<T>(method, path, params);
  }
}

function baseAsset(symbol: string): string {
  const quotes = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "USD"];
  const quote = quotes.find((item) => symbol.endsWith(item));
  return quote ? symbol.slice(0, -quote.length) : symbol;
}

function bybitPositionIndex(order: ExecOrder): 0 | 1 | 2 {
  const value = order.positionIndex ?? (order.positionSide === "long" ? 1 : order.positionSide === "short" ? 2 : 0);
  if (value !== 0 && value !== 1 && value !== 2) throw new Error("Bybit positionIndex must be 0, 1 or 2");
  return value;
}

interface SafetyCloseOutcome {
  confirmed: boolean;
  clientId: string;
  orderId?: string;
  error?: string;
}

function safetyCloseClientId(entryClientId: string | undefined, botId: string): string {
  const root = entryClientId ?? `${botId.slice(0, 12)}-${Date.now()}`;
  return `${root.slice(0, 27)}-safety`;
}

function protectionFailureMessage(cause: string, safety: SafetyCloseOutcome): string {
  if (safety.confirmed) {
    return `${cause}; entry was accepted and emergency close ${safety.orderId} was accepted. Trading is paused until both executions are accounted.`;
  }
  return `${cause}; entry was accepted and emergency close failed (${safety.error ?? "unconfirmed acknowledgement"}). An unprotected position may remain; trading is paused.`;
}

function pendingMarketOrder(order: ExecOrder, id: string, qty: number, reduceOnly: boolean): PendingOrder {
  return {
    id,
    clientId: order.clientId,
    symbol: order.symbol,
    side: order.side ?? "buy",
    type: "market",
    qty,
    reduceOnly,
    tif: order.tif ?? "GTC",
    createdAt: Date.now()
  };
}
