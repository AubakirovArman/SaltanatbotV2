import { randomUUID } from "node:crypto";
import type {
  AccountState,
  ExchangeAdapter,
  ExecOrder,
  ExecResult,
  FillRecord,
  MarketType,
  OrderType,
  PendingOrder,
  PositionState,
  Side,
  StopSpec,
  TpLevel
} from "../types.js";

export interface PaperState {
  balance: number;
  position: PositionState | null;
  orders: PendingOrder[];
  leverage: number;
  isolated: boolean;
  dualSide: boolean;
}

interface PaperOptions {
  botId: string;
  market: MarketType;
  startBalance: number;
  feePct: number;
  slipPct: number;
  getPrice: (symbol: string) => number;
}

/**
 * Fully-simulated exchange with a real order book. Supports market, limit and
 * conditional (stop / take-profit, market or limit) orders that rest until they
 * fill on a price tick, plus attached reduce-only protection. Implements the
 * full Antares action set: open / close / flatten / turnover / chporders /
 * openorders / spreadentry / cancel* / replace / set / get.
 */
export class PaperAdapter implements ExchangeAdapter {
  readonly id = "paper" as const;
  readonly market: MarketType;
  private balance: number;
  private pos: PositionState | null = null;
  private book: PendingOrder[] = [];
  private leverage = 1;
  private isolated = false;
  private dualSide = false;

  constructor(private readonly opts: PaperOptions) {
    this.market = opts.market;
    this.balance = opts.startBalance;
  }

  getState(): PaperState {
    return { balance: this.balance, position: this.pos, orders: this.book, leverage: this.leverage, isolated: this.isolated, dualSide: this.dualSide };
  }

  setState(state: PaperState) {
    this.balance = state.balance;
    this.pos = state.position;
    this.book = state.orders ?? [];
    this.leverage = state.leverage ?? 1;
    this.isolated = state.isolated ?? false;
    this.dualSide = state.dualSide ?? false;
  }

  async price(symbol: string): Promise<number> {
    return this.opts.getPrice(symbol);
  }

  async account(): Promise<AccountState> {
    return { balance: round(this.balance), equity: round(this.balance + this.unrealized()), currency: "USDT" };
  }

  async position(symbol: string): Promise<PositionState | null> {
    return this.pos && this.pos.symbol === symbol ? this.pos : null;
  }

  async orders(symbol?: string): Promise<PendingOrder[]> {
    return symbol ? this.book.filter((order) => order.symbol === symbol) : this.book;
  }

  /** Called every tick: fills any resting orders whose trigger/limit is crossed. */
  onPrice(symbol: string, price: number): FillRecord[] {
    if (!Number.isFinite(price) || price <= 0) return [];
    const fills: FillRecord[] = [];
    const remaining: PendingOrder[] = [];
    for (const order of this.book) {
      if (order.symbol !== symbol || !this.triggered(order, price)) {
        remaining.push(order);
        continue;
      }
      const fillPrice = order.type === "limit" || order.type === "stop_limit" || order.type === "tp_limit"
        ? order.price ?? price
        : price;
      const fill = this.applyFill(order.symbol, order.side, order.qty, fillPrice, order.reduceOnly, `trigger:${order.type}`);
      if (fill) fills.push({ ...fill, orderId: order.id, clientId: order.clientId });
      // Reduce-only protection that fully closed the position cancels siblings.
    }
    this.book = this.pos ? remaining : remaining.filter((order) => !order.reduceOnly);
    return fills;
  }

  async execute(order: ExecOrder): Promise<ExecResult> {
    const mark = this.opts.getPrice(order.symbol);
    if (order.action !== "get" && order.action !== "set" && order.action !== "cancel" && order.action !== "cancelall" && order.action !== "cancelorphans" && (!Number.isFinite(mark) || mark <= 0)) {
      return this.fail("No market price available");
    }
    switch (order.action) {
      case "neworder": return this.neworder(order, mark);
      case "open": return this.openPosition(order, mark);
      case "openorders": return this.openOrders(order, mark);
      case "spreadentry": return this.spreadEntry(order, mark);
      case "close": return this.closePosition(order, mark);
      case "flatten": return this.flatten();
      case "turnover": return this.turnover(order, mark);
      case "chporders": return this.chpOrders(order, mark);
      case "cancel": return this.cancel(order);
      case "cancelall": return this.cancelAll(order);
      case "cancelorphans": return this.cancelOrphans(order);
      case "replace": return this.replace(order, mark);
      case "set": return this.set(order);
      case "get": return this.get(order, mark);
      default: return this.ok("No-op", []);
    }
  }

  // ---------- actions ----------

  private neworder(order: ExecOrder, mark: number): ExecResult {
    if (!order.side) return this.fail("Order needs a side");
    if (order.type === "market") {
      if (order.reduceOnly || order.closePct !== undefined) {
        return this.closePosition({ ...order, action: "close" }, mark);
      }
      const fill = this.applyFill(order.symbol, order.side, this.resolveQty(order, mark), this.slip(mark, order.side, true), false, order.reason);
      return fill ? this.ok(fillMsg(fill), [fill]) : this.fail("Computed quantity is zero");
    }
    // Resting order.
    const pending = this.place(order, mark);
    return pending ? { ...this.ok(`Placed ${order.type} ${pending.side} ${round(pending.qty)} ${order.symbol}`, []), pendingOrder: pending } : this.fail("Invalid order parameters");
  }

  private openPosition(order: ExecOrder, mark: number): ExecResult {
    if (this.pos && this.pos.symbol === order.symbol && !order.clearStage) {
      return this.fail(`Already in a ${this.pos.side} position on ${order.symbol}`);
    }
    if (order.stop || order.takeProfits || order.clearStage) this.cancelSymbol(order.symbol);
    if (order.clearStage && this.pos) this.applyFill(this.pos.symbol, this.pos.side === "long" ? "sell" : "buy", this.pos.qty, mark, true, "clearstage");
    const dir: Side = order.side === "sell" ? "sell" : "buy";
    const fill = this.applyFill(order.symbol, dir, this.resolveQty(order, mark), this.slip(mark, dir, true), false, order.reason);
    if (!fill) return this.fail("qty parameter is missing or invalid");
    if (order.leverage) this.leverage = order.leverage;
    this.attachProtection(order, this.pos!);
    return this.ok(`${fillMsg(fill)}${this.book.length ? ` (+${this.book.length} protective)` : ""}`, [fill]);
  }

  private openOrders(order: ExecOrder, mark: number): ExecResult {
    if (order.stop || order.takeProfits || order.clearStage) this.cancelSymbol(order.symbol);
    if (order.clearStage && this.pos) this.applyFill(this.pos.symbol, this.pos.side === "long" ? "sell" : "buy", this.pos.qty, mark, true, "clearstage");
    const entry = this.place({ ...order, type: "limit" }, mark);
    if (!entry) return this.fail("Limit entry parameters invalid");
    // Protective orders rest reduce-only and act once the entry fills.
    const refPrice = order.price ?? mark;
    this.placeProtection(order, order.side === "sell" ? "sell" : "buy", entry.qty, refPrice, refPrice);
    return this.ok(`Limit entry @ ${round(refPrice)} + ${this.book.length - 1} protective`, []);
  }

  private spreadEntry(order: ExecOrder, mark: number): ExecResult {
    const side: Side = order.side === "sell" ? "sell" : "buy";
    const totalQty = this.resolveQty(order, mark);
    const count = Math.max(1, Math.round(order.spreadCount ?? 1));
    const perc = order.spreadPerc ?? 0;
    const base = order.price ?? mark;
    const per = totalQty / count;
    const fills: FillRecord[] = [];
    // First slice as a market order for an immediate position.
    const first = this.applyFill(order.symbol, side, per, this.slip(mark, side, true), false, "spreadentry");
    if (first) fills.push(first);
    // Remaining slices as limit orders across the range.
    for (let i = 1; i < count; i += 1) {
      const frac = i / (count - 1 || 1);
      const price = side === "buy" ? base * (1 - (perc / 100) * frac) : base * (1 + (perc / 100) * frac);
      this.book.push(this.pending(side, per, "limit", price, undefined, false, order));
    }
    this.attachProtection(order, this.pos ?? undefined);
    return this.ok(`Spread ${side} ${round(totalQty)} in ${count} orders`, fills);
  }

  private closePosition(order: ExecOrder, mark: number): ExecResult {
    if (!this.pos || this.pos.symbol !== order.symbol) return this.fail(`No open position on ${order.symbol}`);
    const pct = order.qty !== undefined ? (order.qty / this.pos.qty) * 100 : order.closePct ?? 100;
    const qty = Math.min(this.pos.qty, this.pos.qty * (pct / 100));
    const side: Side = this.pos.side === "long" ? "sell" : "buy";
    const price = order.type === "limit" && order.price ? order.price : this.slip(mark, side, false);
    const fill = this.applyFill(order.symbol, side, qty, price, true, order.reason);
    return fill ? this.ok(fillMsg(fill), [fill]) : this.fail("Nothing to close");
  }

  private flatten(): ExecResult {
    const fills: FillRecord[] = [];
    if (this.pos) {
      const mark = this.opts.getPrice(this.pos.symbol);
      const fill = this.applyFill(this.pos.symbol, this.pos.side === "long" ? "sell" : "buy", this.pos.qty, this.slip(mark, this.pos.side === "long" ? "sell" : "buy", false), true, "flatten");
      if (fill) fills.push(fill);
    }
    this.book = [];
    return this.ok("Closed all positions and orders", fills);
  }

  private turnover(order: ExecOrder, mark: number): ExecResult {
    const wanted: Side = order.side === "sell" ? "sell" : "buy";
    if (this.pos) {
      const same = (this.pos.side === "long" && wanted === "buy") || (this.pos.side === "short" && wanted === "sell");
      if (same && !order.ignoreSide) return this.fail("Already in a position in the same direction");
      this.applyFill(this.pos.symbol, this.pos.side === "long" ? "sell" : "buy", this.pos.qty, mark, true, "turnover:close");
      this.cancelSymbol(order.symbol);
    }
    const fill = this.applyFill(order.symbol, wanted, this.resolveQty(order, mark), this.slip(mark, wanted, true), false, "turnover:open");
    if (!fill) return this.fail("Turnover size is zero");
    if (order.leverage) this.leverage = order.leverage;
    this.attachProtection(order, this.pos!);
    return this.ok(`Reversed to ${wanted === "buy" ? "long" : "short"}`, [fill]);
  }

  private chpOrders(order: ExecOrder, mark: number): ExecResult {
    if (!this.pos || this.pos.symbol !== order.symbol) return this.fail("chporders requires an open position");
    if (order.stop) {
      this.book = this.book.filter((o) => o.symbol !== order.symbol || (o.type !== "stop_market" && o.type !== "stop_limit"));
      // stop % basis is the CURRENT price for chporders.
      this.placeStop(order.stop, this.pos, order, mark);
    }
    if (order.takeProfits) {
      this.book = this.book.filter((o) => o.symbol !== order.symbol || (o.type !== "tp_market" && o.type !== "tp_limit"));
      this.placeTps(order.takeProfits, this.pos, this.pos.entryPrice);
    }
    return this.ok(`Updated protection: ${this.book.length} orders`, []);
  }

  private cancel(order: ExecOrder): ExecResult {
    const before = this.book.length;
    const by = order.by ?? (order.orderId || order.clientId ? "id" : "symbol");
    this.book = this.book.filter((o) => {
      if (o.symbol !== order.symbol && by !== "all") return true;
      switch (by) {
        case "id": return o.id !== order.orderId && o.clientId !== order.clientId;
        case "side": return o.side !== order.side;
        case "type": return o.type !== order.type;
        case "all":
        case "symbol":
        default: return false;
      }
    });
    return this.ok(`Cancelled ${before - this.book.length} order(s)`, []);
  }

  private cancelAll(order: ExecOrder): ExecResult {
    const before = this.book.length;
    this.book = order.symbol ? this.book.filter((o) => o.symbol !== order.symbol) : [];
    return this.ok(`Cancelled ${before - this.book.length} order(s)`, []);
  }

  private cancelOrphans(order: ExecOrder): ExecResult {
    if (this.pos) return this.ok("Position open — nothing orphaned", []);
    const before = this.book.length;
    const protective: OrderType[] = ["stop_market", "stop_limit", "tp_market", "tp_limit"];
    if (order.includeLimit) protective.push("limit");
    this.book = this.book.filter((o) => !protective.includes(o.type));
    return this.ok(`Cancelled ${before - this.book.length} orphan order(s)`, []);
  }

  private replace(order: ExecOrder, mark: number): ExecResult {
    const existing = this.book.find((o) => (order.orderId && o.id === order.orderId) || (order.clientId && o.clientId === order.clientId));
    if (!existing) {
      if (order.upsert) {
        const created = this.place(order, mark);
        return created ? this.ok(`Created ${order.type} (upsert)`, []) : this.fail("Cannot create order");
      }
      return this.fail("Order not found");
    }
    if (order.side) existing.side = order.side;
    if (order.price !== undefined) existing.price = order.price;
    if (order.qty !== undefined) existing.qty = order.qty;
    if (order.trgPrice !== undefined) existing.trgPrice = order.trgPrice;
    return this.ok("Order replaced", []);
  }

  private set(order: ExecOrder): ExecResult {
    switch (order.setValue) {
      case "LEVERAGE": if (order.leverage) this.leverage = order.leverage; return this.ok(`Leverage set to ${this.leverage}x`, []);
      case "DUALSIDE": this.dualSide = !!order.dualSide; return this.ok(`Hedge mode ${this.dualSide ? "on" : "off"}`, []);
      case "ISOLATEDMARGIN": this.isolated = !!order.isolated; return this.ok(`Isolated margin ${this.isolated ? "on" : "off"}`, []);
      default: return this.ok(`Set ${order.setValue ?? "?"} acknowledged`, []);
    }
  }

  private get(order: ExecOrder, mark: number): ExecResult {
    const value = order.getValue ?? "BALANCE";
    let data: unknown;
    let message: string;
    switch (value) {
      case "PRICE": case "SYMPRICE": data = { price: mark }; message = `${order.symbol} = ${mark}`; break;
      case "OPENPOS": case "POSITIONS": data = this.pos; message = this.pos ? `${this.pos.side} ${this.pos.qty} @ ${this.pos.entryPrice}` : "flat"; break;
      case "ORDERS": data = this.book; message = `${this.book.length} open order(s)`; break;
      case "DUALSIDE": case "POSITIONMODE": data = { dualside: this.dualSide }; message = `hedge ${this.dualSide}`; break;
      default: {
        const acc = { balance: round(this.balance), equity: round(this.balance + this.unrealized()) };
        data = acc; message = `balance ${acc.balance} · equity ${acc.equity}`;
      }
    }
    return { ok: true, message, fills: [], data, orders: this.book, position: this.pos, account: { balance: round(this.balance), equity: round(this.balance + this.unrealized()), currency: "USDT" } };
  }

  // ---------- protection helpers ----------

  private attachProtection(order: ExecOrder, pos?: PositionState) {
    if (!pos) return;
    if (order.stop) this.placeStop(order.stop, pos, order, pos.entryPrice);
    if (order.takeProfits) this.placeTps(order.takeProfits, pos, pos.entryPrice);
  }

  private placeProtection(order: ExecOrder, entrySide: Side, qty: number, refPrice: number, entryPrice: number) {
    const closeSide: Side = entrySide === "buy" ? "sell" : "buy";
    const posLike: PositionState = { symbol: order.symbol, side: entrySide === "buy" ? "long" : "short", qty, entryPrice, leverage: order.leverage ?? 1, openedAt: Date.now() };
    if (order.stop) this.placeStop(order.stop, posLike, order, refPrice);
    if (order.takeProfits) this.placeTps(order.takeProfits, posLike, entryPrice);
    void closeSide;
  }

  private placeStop(stop: StopSpec, pos: PositionState, order: ExecOrder, basisPrice: number) {
    const trg = stop.basis === "price" ? stop.value : pos.side === "long" ? basisPrice * (1 - stop.value / 100) : basisPrice * (1 + stop.value / 100);
    const side: Side = pos.side === "long" ? "sell" : "buy";
    this.book.push(this.pending(side, pos.qty, "stop_market", undefined, trg, true, order));
    if (this.pos) this.pos.stopPrice = trg;
  }

  private placeTps(levels: TpLevel[], pos: PositionState, entryPrice: number) {
    const side: Side = pos.side === "long" ? "sell" : "buy";
    for (const level of levels) {
      const trg = level.priceBasis === "price" ? level.price : pos.side === "long" ? entryPrice * (1 + level.price / 100) : entryPrice * (1 - level.price / 100);
      const qty = level.qtyBasis === "abs" ? level.qty : pos.qty * (level.qty / 100);
      const type: OrderType = level.limitPrice !== undefined ? "tp_limit" : "tp_market";
      const pending: PendingOrder = { id: randomUUID(), symbol: pos.symbol, side, type, qty, trgPrice: trg, price: level.limitPrice, reduceOnly: true, tif: "GTC", createdAt: Date.now() };
      this.book.push(pending);
    }
    if (this.pos && levels[0]) this.pos.targetPrice = this.book.find((o) => o.type.startsWith("tp"))?.trgPrice;
  }

  // ---------- primitives ----------

  private place(order: ExecOrder, mark: number): PendingOrder | undefined {
    if (!order.side) return undefined;
    const qty = this.resolveQty(order, mark);
    if (!qty || qty <= 0) return undefined;
    const trg = order.trgPrice ?? (order.trgPricePro !== undefined ? mark * (1 + order.trgPricePro / 100) : undefined);
    const price = order.price ?? (order.pricePro !== undefined ? mark * (1 + order.pricePro / 100) : undefined);
    const pending = this.pending(order.side, qty, order.type, price, trg, order.reduceOnly ?? false, order);
    this.book.push(pending);
    return pending;
  }

  private pending(side: Side, qty: number, type: OrderType, price: number | undefined, trg: number | undefined, reduceOnly: boolean, order: ExecOrder): PendingOrder {
    return { id: randomUUID(), clientId: order.clientId, symbol: order.symbol, side, type, qty, price, trgPrice: trg, reduceOnly, tif: order.tif ?? "GTC", createdAt: Date.now() };
  }

  private triggered(order: PendingOrder, price: number): boolean {
    switch (order.type) {
      case "limit": return order.side === "buy" ? price <= (order.price ?? 0) : price >= (order.price ?? Infinity);
      case "stop_market": case "stop_limit": return order.side === "sell" ? price <= (order.trgPrice ?? 0) : price >= (order.trgPrice ?? Infinity);
      case "tp_market": case "tp_limit": return order.side === "sell" ? price >= (order.trgPrice ?? Infinity) : price <= (order.trgPrice ?? 0);
      default: return false;
    }
  }

  /** Apply a fill to the position, returning the fill record (or null if no-op). */
  private applyFill(symbol: string, side: Side, qty: number, price: number, reduceOnly: boolean, reason: string): FillRecord | null {
    if (!qty || qty <= 0) return null;
    // Reduce / close.
    if (this.pos && ((side === "sell" && this.pos.side === "long") || (side === "buy" && this.pos.side === "short"))) {
      const closeQty = Math.min(this.pos.qty, qty);
      const gross = this.pos.side === "long" ? closeQty * (price - this.pos.entryPrice) : closeQty * (this.pos.entryPrice - price);
      const fee = closeQty * price * (this.opts.feePct / 100);
      const pnl = gross - fee;
      this.balance += pnl;
      this.pos.qty -= closeQty;
      const sym = this.pos.symbol;
      if (this.pos.qty <= 1e-9) this.pos = null;
      return this.record(sym, side, closeQty, price, fee, pnl, "close", reason);
    }
    if (reduceOnly) return null;
    // Open (single one-way position per symbol).
    if (this.pos) return null;
    const fee = qty * price * (this.opts.feePct / 100);
    this.balance -= fee;
    this.pos = { symbol, side: side === "buy" ? "long" : "short", qty, entryPrice: price, leverage: this.leverage, openedAt: Date.now() };
    return this.record(symbol, side, qty, price, fee, 0, "open", reason);
  }

  private resolveQty(order: ExecOrder, price: number): number {
    const lev = order.levForQty ? Math.max(1, order.leverage ?? this.leverage) : 1;
    if (order.qty !== undefined) return order.qty;
    if (order.quoteQty !== undefined) return (order.quoteQty * lev) / price;
    if (order.openPct !== undefined) return (this.balance * (order.openPct / 100) * (order.leverage ?? 1)) / price;
    if (order.depoPct !== undefined) return (this.balance * (order.depoPct / 100) * (order.leverage ?? 1)) / price;
    if (order.closePct !== undefined && this.pos) return this.pos.qty * (order.closePct / 100);
    return 0;
  }

  private slip(price: number, side: Side, entering: boolean): number {
    void entering;
    const worseUp = side === "buy";
    return price * (1 + (worseUp ? this.opts.slipPct : -this.opts.slipPct) / 100);
  }

  private cancelSymbol(symbol: string) {
    this.book = this.book.filter((order) => order.symbol !== symbol);
  }

  private unrealized(): number {
    if (!this.pos) return 0;
    const price = this.opts.getPrice(this.pos.symbol);
    if (!Number.isFinite(price)) return 0;
    return this.pos.side === "long" ? this.pos.qty * (price - this.pos.entryPrice) : this.pos.qty * (this.pos.entryPrice - price);
  }

  private record(symbol: string, side: Side, qty: number, price: number, fee: number, pnl: number, kind: "open" | "close", reason: string): FillRecord {
    return { id: randomUUID(), botId: this.opts.botId, symbol, side, qty: round(qty), price: round(price), fee: round(fee), realizedPnl: round(pnl), kind, reason, ts: Date.now() };
  }

  private ok(message: string, fills: FillRecord[]): ExecResult {
    return { ok: true, message, fills, orders: this.book, position: this.pos, account: { balance: round(this.balance), equity: round(this.balance + this.unrealized()), currency: "USDT" } };
  }

  private fail(message: string): ExecResult {
    return { ok: false, message, fills: [] };
  }
}

function fillMsg(fill: FillRecord): string {
  return `${fill.kind === "open" ? "Opened" : "Closed"} ${fill.qty} ${fill.symbol} @ ${fill.price}${fill.kind === "close" ? ` · PnL ${fill.realizedPnl}` : ""}`;
}


function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
