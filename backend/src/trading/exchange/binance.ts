import type { AccountState, ExchangeAdapter, ExchangeOrderSnapshot, ExecOrder, ExecResult, MarketType, OrderType, PendingOrder, PositionState } from "../types.js";
import { assertFreshSymbolFilters, binanceFilters, type SymbolFilters } from "./filters.js";
import { BinanceSignedClient } from "./binanceClient.js";
import { ambiguousAcknowledgement, isAmbiguousExchangeError, requireExchangeObject } from "./errors.js";
import { assertClosePercentage, assertLiveOrderShape, prepareLiveOrder, prepareMarketExit, type PreparedLiveOrder, type PreparedMarketExit } from "./orderRules.js";
import { normalizeBinanceOrderStatus } from "./orderStatus.js";
import { subscribeBinanceOrders } from "./privateOrderStreams.js";

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
  private readonly client: BinanceSignedClient;

  constructor(
    private readonly botId: string,
    private readonly keys: ExchangeKeys,
    market: MarketType,
    readonly accountId = "binance:default"
  ) {
    this.market = market;
    this.client = new BinanceSignedClient(keys, market);
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
      positionSide?: string;
    }>;
    const row = rows.find((item) => item.symbol === symbol && Number(item.positionAmt) !== 0);
    const amt = Number(row?.positionAmt ?? 0);
    if (!row || amt === 0) return null;
    return {
      symbol,
      side: amt > 0 ? "long" : "short",
      qty: Math.abs(amt),
      entryPrice: Number(row.entryPrice),
      leverage: Number(row.leverage),
      hedged: row.positionSide === "LONG" || row.positionSide === "SHORT",
      openedAt: Date.now()
    };
  }

  async positions(): Promise<PositionState[]> {
    if (this.market !== "futures") return [];
    const rows = (await this.signed("GET", "/fapi/v2/positionRisk")) as Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      leverage: string;
      positionSide?: string;
    }>;
    return rows.flatMap((row) => {
      const amt = Number(row.positionAmt);
      if (!Number.isFinite(amt) || amt === 0) return [];
      return [
        {
          symbol: row.symbol,
          side: amt > 0 ? ("long" as const) : ("short" as const),
          qty: Math.abs(amt),
          entryPrice: Number(row.entryPrice),
          leverage: Number(row.leverage),
          hedged: row.positionSide === "LONG" || row.positionSide === "SHORT",
          openedAt: Date.now()
        }
      ];
    });
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
      executedQty?: string;
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
      qty: Math.max(0, Number(row.origQty) - Number(row.executedQty ?? 0)),
      price: Number(row.price) || undefined,
      trgPrice: row.stopPrice ? Number(row.stopPrice) || undefined : undefined,
      reduceOnly: !!row.reduceOnly,
      tif: (row.timeInForce as PendingOrder["tif"]) ?? "GTC",
      createdAt: row.time ?? Date.now()
    }));
  }

  async orderStatus(symbol: string, identity: { orderId?: string; clientId?: string }): Promise<ExchangeOrderSnapshot | null> {
    if (!identity.orderId && !identity.clientId) return null;
    const path = this.market === "futures" ? "/fapi/v1/order" : "/api/v3/order";
    const params: Record<string, string> = { symbol };
    if (identity.orderId) params.orderId = identity.orderId;
    else if (identity.clientId) params.origClientOrderId = identity.clientId;
    const row = (await this.signed("GET", path, params)) as {
      orderId: string | number;
      clientOrderId?: string;
      status: string;
      origQty: string;
      executedQty: string;
      avgPrice?: string;
      price?: string;
      updateTime?: number;
      time?: number;
    };
    return {
      id: String(row.orderId),
      clientId: row.clientOrderId,
      status: normalizeBinanceOrderStatus(row.status),
      qty: Number(row.origQty),
      filledQty: Number(row.executedQty),
      avgFillPrice: Number(row.avgPrice) || Number(row.price) || undefined,
      updatedAt: row.updateTime ?? row.time ?? Date.now()
    };
  }

  async subscribeOrderUpdates(onSnapshot: (snapshot: ExchangeOrderSnapshot) => void, onConnection: (connected: boolean, message: string) => void) {
    if (this.market !== "futures") throw new Error("Binance private order stream is currently enabled for USDⓈ-M futures only");
    return subscribeBinanceOrders(this.keys, { onSnapshot, onConnection });
  }

  async execute(order: ExecOrder): Promise<ExecResult> {
    try {
      switch (order.action) {
        case "close":
        case "flatten": {
          const filters = await binanceFilters(order.symbol, this.market);
          const referencePrice = await this.price(order.symbol);
          assertClosePercentage(order.closePct);
          const pos = order.positionSide ? ((await this.positions()).find((candidate) => candidate.symbol === order.symbol && candidate.side === order.positionSide) ?? null) : await this.position(order.symbol);
          if (!pos) return { ok: false, message: `No position on ${order.symbol}`, fills: [] };
          const closeQty = pos.qty * ((order.closePct ?? 100) / 100);
          const prepared = prepareMarketExit({
            exchange: "binance",
            market: this.market,
            symbol: order.symbol,
            quantity: closeQty,
            referencePrice,
            filters,
            reduceOnly: !pos.hedged
          });
          const placed = (await this.placePreparedMarket(order.symbol, pos.side === "long" ? "SELL" : "BUY", prepared, true, pos.hedged ? pos.side : undefined, order.clientId)) as { orderId?: string | number };
          const exchangeOrderId = placed.orderId === undefined ? undefined : String(placed.orderId);
          return {
            ok: true,
            message: `Close accepted for ${order.symbol}; awaiting authenticated execution accounting`,
            fills: [],
            pendingOrder: exchangeOrderId ? pendingMarketOrder(order, exchangeOrderId, Number(prepared.quantity), true) : undefined,
            ...(await this.acceptedState(order.symbol, pos))
          };
        }
        case "cancelall":
        case "cancel":
        case "cancelorphans":
          await this.cancelAll(order.symbol);
          return { ok: true, message: `Cancelled orders on ${order.symbol}`, fills: [] };
        case "set":
          return await this.applySet(order);
        case "get":
          return await this.getInfo(order);
        case "turnover": {
          const prepared = await this.prepareEntry(order);
          const pos = await this.position(order.symbol);
          if (pos) {
            const exit = prepareMarketExit({ exchange: "binance", market: this.market, symbol: order.symbol, quantity: pos.qty, referencePrice: prepared.referencePrice, filters: prepared.filters, reduceOnly: !pos.hedged });
            await this.placePreparedMarket(order.symbol, pos.side === "long" ? "SELL" : "BUY", exit, true, pos.hedged ? pos.side : undefined);
          }
          return await this.submitPreparedEntry(order, prepared);
        }
        case "neworder":
        case "open":
        case "openorders":
        case "spreadentry":
        case "replace":
          return await this.placeEntry(order);
        case "chporders":
          return { ok: false, message: "CHPORDERS is not supported by the Binance live adapter", fills: [] };
      }
    } catch (error) {
      if (isAmbiguousExchangeError(error)) throw error;
      return { ok: false, message: error instanceof Error ? error.message : "Binance error", fills: [] };
    }
  }

  private async placeEntry(order: ExecOrder): Promise<ExecResult> {
    return this.submitPreparedEntry(order, await this.prepareEntry(order));
  }

  private async prepareEntry(order: ExecOrder): Promise<PreparedLiveOrder> {
    const price = await this.price(order.symbol);
    const filters = await binanceFilters(order.symbol, this.market);
    assertLiveOrderShape(order, "binance", this.market);
    const rawQuantity = await this.resolveQty(order, price);
    return prepareLiveOrder({ exchange: "binance", market: this.market, order, referencePrice: price, rawQuantity, filters });
  }

  private async submitPreparedEntry(order: ExecOrder, prepared: PreparedLiveOrder): Promise<ExecResult> {
    const side = order.side === "sell" ? "SELL" : "BUY";
    assertFreshSymbolFilters(prepared.filters, { exchange: "binance", market: this.market, symbol: order.symbol });
    if (this.market === "futures" && order.leverage) {
      await this.ensureLeverage(order.symbol, Math.round(order.leverage));
    }
    const qty = Number(prepared.quantity);
    order.qty = qty;
    const entryPlaced = (await this.placeOrder(order, side, prepared)) as { orderId?: string | number };
    const entryOrderId = entryPlaced.orderId === undefined ? undefined : String(entryPlaced.orderId);
    // Attached protection (single stop / first TP) for futures.
    if (this.market === "futures" && (order.stop || order.takeProfits?.length)) {
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      const stopOrderIds: string[] = [];
      const takeProfitOrderIds: string[] = [];
      if (order.stop) {
        try {
          const placed = requireOrderAcknowledgement(
            await this.signed("POST", "/fapi/v1/order", {
              symbol: order.symbol,
              side: closeSide,
              type: "STOP_MARKET",
              stopPrice: prepared.stopTriggerPrice!,
              closePosition: "true",
              ...(order.positionSide ? { positionSide: order.positionSide.toUpperCase() } : {}),
              ...(order.protectionClientIds?.stop ? { newClientOrderId: order.protectionClientIds.stop } : {})
            }),
            "Binance stop-loss"
          );
          stopOrderIds.push(String(placed.orderId));
        } catch (error) {
          // Fail loud: an unprotected position is worse than none. Close it and report.
          const safety = await this.attemptSafetyClose(order, closeSide, qty, prepared.filters, Number(prepared.referencePrice));
          const message = error instanceof Error ? error.message : "stop rejected";
          return {
            // The entry acknowledgement is real even though the compound
            // operation failed. Keep the durable entry reservation alive and
            // force the engine into its unprotected-entry pause path.
            ok: true,
            message: protectionFailureMessage("Stop-loss", message, safety),
            fills: [],
            pendingOrder: entryOrderId ? pendingMarketOrder(order, entryOrderId, qty, false) : undefined,
            protection: {
              requested: true,
              confirmed: false,
              message,
              entryOrderId,
              stopOrderIds,
              takeProfitOrderIds,
              safetyCloseAttempted: true,
              safetyCloseConfirmed: safety.confirmed,
              safetyCloseOrderId: safety.orderId,
              safetyCloseClientId: safety.clientId,
              verification: "order_ids"
            },
            ...(await this.acceptedState(order.symbol))
          };
        }
      }
      try {
        for (const [index] of (order.takeProfits ?? []).entries()) {
          const level = prepared.takeProfits[index]!;
          const clientId = order.protectionClientIds?.takeProfits?.[index];
          const placed = requireOrderAcknowledgement(
            await this.signed("POST", "/fapi/v1/order", {
              symbol: order.symbol,
              side: closeSide,
              type: "TAKE_PROFIT_MARKET",
              stopPrice: level.triggerPrice,
              quantity: level.quantity!,
              ...(order.positionSide ? { positionSide: order.positionSide.toUpperCase() } : { reduceOnly: "true" }),
              ...(clientId ? { newClientOrderId: clientId } : {})
            }),
            "Binance take-profit"
          );
          takeProfitOrderIds.push(String(placed.orderId));
        }
      } catch (error) {
        const protectionOrderIds = [...stopOrderIds, ...takeProfitOrderIds];
        const cancellations = await Promise.allSettled(
          protectionOrderIds.map((orderId) =>
            this.signed("DELETE", "/fapi/v1/order", { symbol: order.symbol, orderId }).then((ack: { orderId?: string | number; status?: string }) => {
              if (String(ack.orderId) !== orderId || ack.status !== "CANCELED") {
                throw ambiguousAcknowledgement(`Binance cancellation for ${orderId}`, "its order identity or cancelled status was missing");
              }
            })
          )
        );
        const orphanProtectionOrderIds = protectionOrderIds.filter((_, index) => cancellations[index]?.status === "rejected");
        const safety = await this.attemptSafetyClose(order, closeSide, qty, prepared.filters, Number(prepared.referencePrice));
        const cause = error instanceof Error ? error.message : "take-profit rejected";
        const message = withOrphanProtectionWarning(cause, orphanProtectionOrderIds);
        return {
          ok: true,
          message: protectionFailureMessage("Take-profit", message, safety),
          fills: [],
          pendingOrder: entryOrderId ? pendingMarketOrder(order, entryOrderId, qty, false) : undefined,
          protection: {
            requested: true,
            confirmed: false,
            message,
            entryOrderId,
            stopOrderIds,
            takeProfitOrderIds,
            safetyCloseAttempted: true,
            safetyCloseConfirmed: safety.confirmed,
            safetyCloseOrderId: safety.orderId,
            safetyCloseClientId: safety.clientId,
            orphanProtectionOrderIds,
            verification: "order_ids"
          },
          ...(await this.acceptedState(order.symbol))
        };
      }
      return {
        ok: true,
        message: `Placed ${order.type} ${side} ${qty} ${order.symbol}`,
        fills: [],
        pendingOrder: entryOrderId ? pendingMarketOrder(order, entryOrderId, qty, false) : undefined,
        protection: { requested: true, confirmed: true, entryOrderId, stopOrderIds, takeProfitOrderIds, verification: "order_ids" },
        ...(await this.acceptedState(order.symbol))
      };
    }
    return {
      ok: true,
      message: `Placed ${order.type} ${side} ${qty} ${order.symbol}`,
      fills: [],
      pendingOrder: entryOrderId ? pendingMarketOrder(order, entryOrderId, qty, false) : undefined,
      ...(await this.acceptedState(order.symbol))
    };
  }

  private async attemptSafetyClose(order: ExecOrder, side: "BUY" | "SELL", qty: number, filters: SymbolFilters, referencePrice: number) {
    const clientId = order.protectionClientIds?.safetyClose ?? safetyCloseClientId(order.clientId, this.botId);
    try {
      const prepared = prepareMarketExit({
        exchange: "binance",
        market: this.market,
        symbol: order.symbol,
        quantity: qty,
        referencePrice,
        filters,
        reduceOnly: order.positionSide === undefined
      });
      const placed = (await this.placePreparedMarket(order.symbol, side, prepared, true, order.positionSide, clientId)) as { orderId?: string | number };
      if (placed.orderId === undefined) {
        return { confirmed: false, clientId, error: "emergency close acknowledgement omitted its order ID" };
      }
      return { confirmed: true, clientId, orderId: String(placed.orderId) };
    } catch (error) {
      return {
        confirmed: false,
        clientId,
        error: error instanceof Error ? error.message : "emergency close rejected"
      };
    }
  }

  private async placeOrder(order: ExecOrder, side: "BUY" | "SELL", prepared: PreparedLiveOrder) {
    const path = this.market === "futures" ? "/fapi/v1/order" : "/api/v3/order";
    const params: Record<string, string> = { symbol: order.symbol, side, quantity: prepared.quantity };
    if (order.type === "market") params.type = "MARKET";
    else if (order.type === "limit") {
      params.type = "LIMIT";
      params.price = prepared.limitPrice!;
      params.timeInForce = order.tif ?? "GTC";
    } else {
      params.type = order.type.includes("stop") ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
      params.stopPrice = prepared.entryTriggerPrice!;
    }
    if (this.market === "futures" && order.reduceOnly && !order.positionSide) params.reduceOnly = "true";
    if (this.market === "futures" && order.positionSide) params.positionSide = order.positionSide.toUpperCase();
    if (order.clientId) params.newClientOrderId = order.clientId;
    return requireOrderAcknowledgement(await this.signed("POST", path, params), "Binance order");
  }

  private async cancelAll(symbol: string) {
    if (this.market === "futures") return this.signed("DELETE", "/fapi/v1/allOpenOrders", { symbol });
    const open = (await this.signed("GET", "/api/v3/openOrders", { symbol })) as Array<{ orderId: number }>;
    await Promise.all(open.map((o) => this.signed("DELETE", "/api/v3/order", { symbol, orderId: String(o.orderId) })));
  }

  private async ensureLeverage(symbol: string, leverage: number): Promise<void> {
    let setError: unknown;
    try {
      const result = (await this.signed("POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) })) as { leverage?: number };
      if (Number(result.leverage) === leverage) return;
      setError = new Error(`Binance did not confirm requested leverage ${leverage}x`);
    } catch (error) {
      setError = error;
    }

    try {
      const rows = (await this.signed("GET", "/fapi/v2/positionRisk", { symbol })) as Array<{ symbol?: string; leverage?: string }>;
      const row = rows.find((candidate) => candidate.symbol === symbol);
      if (row && Number(row.leverage) === leverage) return;
    } catch {
      // Preserve the original set failure; reconciliation is read-only evidence,
      // not a reason to replace a more precise mutation error.
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

  private async applySet(order: ExecOrder): Promise<ExecResult> {
    if (this.market !== "futures") return { ok: true, message: "SET ignored on spot", fills: [] };
    await binanceFilters(order.symbol, this.market);
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

  private async resolveQty(order: ExecOrder, price: number): Promise<number> {
    const lev = order.levForQty ? Math.max(1, order.leverage ?? 1) : 1;
    if (order.qty !== undefined) return order.qty;
    if (order.quoteQty !== undefined) return (order.quoteQty * lev) / price;
    if (order.openPct !== undefined || order.depoPct !== undefined) return 0; // needs balance; resolved via quote in practice
    if (order.closePct !== undefined) {
      if (this.market === "spot") return (await this.spotBaseQty(order.symbol)) * (order.closePct / 100);
      return order.closePct / 100 / price;
    }
    return 0;
  }

  private async spotBaseQty(symbol: string): Promise<number> {
    const base = baseAsset(symbol);
    const data = (await this.signed("GET", "/api/v3/account")) as { balances: Array<{ asset: string; free: string; locked: string }> };
    const row = data.balances.find((item) => item.asset === base);
    return Number(row?.free ?? 0);
  }

  private async placePreparedMarket(symbol: string, side: "BUY" | "SELL", prepared: PreparedMarketExit, reduceOnly: boolean, positionSide?: "long" | "short", clientId?: string) {
    const path = this.market === "futures" ? "/fapi/v1/order" : "/api/v3/order";
    const params: Record<string, string> = { symbol, side, type: "MARKET", quantity: prepared.quantity };
    if (this.market === "futures" && positionSide) params.positionSide = positionSide.toUpperCase();
    else if (this.market === "futures" && reduceOnly) params.reduceOnly = "true";
    if (clientId) params.newClientOrderId = clientId;
    return requireOrderAcknowledgement(await this.signed("POST", path, params), "Binance market order");
  }

  private async signed(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}): Promise<any> {
    return this.client.request(method, path, params);
  }
}

function requireOrderAcknowledgement(value: unknown, context: string): { orderId: string | number } {
  const acknowledgement = requireExchangeObject(value, context, true);
  if (typeof acknowledgement.orderId === "string" || typeof acknowledgement.orderId === "number") {
    return { ...acknowledgement, orderId: acknowledgement.orderId } as { orderId: string | number };
  }
  throw ambiguousAcknowledgement(context, "its order ID was missing");
}

/** Map a Binance order type string to our OrderType enum for portfolio display. */
function mapBinanceType(type: string): OrderType {
  switch (type) {
    case "LIMIT":
      return "limit";
    case "STOP":
    case "STOP_LOSS_LIMIT":
      return "stop_limit";
    case "STOP_MARKET":
    case "STOP_LOSS":
      return "stop_market";
    case "TAKE_PROFIT":
    case "TAKE_PROFIT_LIMIT":
      return "tp_limit";
    case "TAKE_PROFIT_MARKET":
      return "tp_market";
    default:
      return "market";
  }
}

function baseAsset(symbol: string): string {
  const quotes = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "USD"];
  const quote = quotes.find((item) => symbol.endsWith(item));
  return quote ? symbol.slice(0, -quote.length) : symbol;
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

function protectionFailureMessage(label: string, cause: string, safety: SafetyCloseOutcome): string {
  if (safety.confirmed) {
    return `${label} rejected (${cause}); entry was accepted and emergency close ${safety.orderId} was accepted. Trading is paused until both executions are accounted.`;
  }
  return `${label} rejected (${cause}); entry was accepted and emergency close failed (${safety.error ?? "unconfirmed acknowledgement"}). An unprotected position may remain; trading is paused.`;
}

function withOrphanProtectionWarning(cause: string, orderIds: string[]): string {
  return orderIds.length === 0 ? cause : `${cause}; cancellation was not confirmed for protection order(s) ${orderIds.join(", ")}; orphan protection may remain`;
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
