import type { Timeframe } from "../types.js";
import type { StrategyIR } from "./strategy/ir.js";

export type ExchangeId = "paper" | "binance" | "bybit";
export type MarketType = "spot" | "futures";
export type Side = "buy" | "sell";
export type BotStatus = "stopped" | "running" | "error";
export type OrderType = "market" | "limit" | "stop_market" | "stop_limit" | "tp_market" | "tp_limit";
export type Tif = "GTC" | "IOC" | "FOK";
export type PositionSide = "long" | "short";

export type ExecAction =
  | "neworder"
  | "open"
  | "close"
  | "flatten"
  | "turnover"
  | "chporders"
  | "openorders"
  | "spreadentry"
  | "cancel"
  | "cancelall"
  | "cancelorphans"
  | "replace"
  | "get"
  | "set";

/** A stop level: percent (of a basis price) or an absolute price. */
export interface StopSpec {
  basis: "percent" | "price";
  value: number;
}

/** One take-profit level. A `limitPrice` makes it a TP_LIMIT, otherwise TP_MARKET. */
export interface TpLevel {
  priceBasis: "percent" | "price";
  price: number;
  qtyBasis: "percent" | "abs";
  qty: number;
  limitPrice?: number;
}

/** A resting order held by the (paper) exchange until it fills or is cancelled. */
export interface PendingOrder {
  id: string;
  clientId?: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price?: number;
  trgPrice?: number;
  reduceOnly: boolean;
  tif: Tif;
  createdAt: number;
}

export interface BotConfig {
  id: string;
  name: string;
  strategyName: string;
  ir: StrategyIR;
  symbol: string;
  timeframe: Timeframe;
  exchange: ExchangeId;
  market: MarketType;
  /** Position sizing when the strategy itself doesn't set a size. */
  sizeMode: "quote" | "base" | "equity_pct" | "risk_pct";
  sizeValue: number;
  leverage: number;
  /** Notify on signals that don't open trades (marker blocks). */
  notifyMarkers: boolean;
  status: BotStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PositionState {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  leverage: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: number;
}

export interface OrderRecord {
  id: string;
  botId: string;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  qty: number;
  price: number;
  reduceOnly: boolean;
  status: "filled" | "rejected" | "new";
  reason: string;
  ts: number;
}

export interface FillRecord {
  id: string;
  botId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  realizedPnl: number;
  kind: "open" | "close";
  reason: string;
  ts: number;
}

export interface AccountState {
  balance: number;
  equity: number;
  currency: string;
}

/** A structured, exchange-agnostic instruction produced from a command string
 *  or from strategy signals. Adapters interpret this. */
export interface ExecOrder {
  action: ExecAction;
  market: MarketType;
  symbol: string;
  side?: Side;
  type: OrderType;
  /** Absolute base quantity (already resolved from %/quote). */
  qty?: number;
  /** Quantity forms resolved lazily by the adapter against balance/position. */
  quoteQty?: number;
  openPct?: number;
  closePct?: number;
  depoPct?: number;
  leverage?: number;
  levForQty?: boolean;
  reduceOnly?: boolean;
  price?: number;
  trgPrice?: number;
  pricePro?: number;
  trgPricePro?: number;
  tif?: Tif;
  clientId?: string;
  orderId?: string;
  by?: "symbol" | "side" | "type" | "id" | "all";
  positionSide?: PositionSide;
  dualSide?: boolean;
  isolated?: boolean;
  ignoreSide?: boolean;
  upsert?: boolean;
  forceReplace?: boolean;
  includeLimit?: boolean;
  clearStage?: boolean;
  stop?: StopSpec;
  takeProfits?: TpLevel[];
  spreadPerc?: number;
  spreadCount?: number;
  getValue?: string;
  setValue?: string;
  reason: string;
}

export interface ExecResult {
  ok: boolean;
  message: string;
  fills: FillRecord[];
  order?: OrderRecord;
  orders?: PendingOrder[];
  position?: PositionState | null;
  account?: AccountState;
  /** Free-form data for GET responses. */
  data?: unknown;
}

export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly market: MarketType;
  price(symbol: string): Promise<number>;
  account(): Promise<AccountState>;
  position(symbol: string): Promise<PositionState | null>;
  execute(order: ExecOrder): Promise<ExecResult>;
  /** Resting orders (paper/futures). */
  orders?(symbol?: string): Promise<PendingOrder[]>;
  /** Feed a live price so resting orders can trigger (paper). */
  onPrice?(symbol: string, price: number): FillRecord[];
}
