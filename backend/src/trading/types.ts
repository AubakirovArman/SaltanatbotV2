import type { Timeframe } from "../types.js";
import type { StrategyIR } from "./strategy/ir.js";

export type ExchangeId = "paper" | "binance" | "bybit";
export type TradingAccountExchange = Exclude<ExchangeId, "paper">;
export type TradingAccountOwnership = "own" | "managed";
export type TradingAccountRuntimeStatus = "ready" | "credentials_missing" | "disabled";
export type TradingAccountCredentialStatus = "configured" | "missing";
export type MarketType = "spot" | "futures";
export type Side = "buy" | "sell";
export type BotStatus = "stopped" | "running" | "error";
export type AuthRole = "read-only" | "paper-trade" | "live-trade" | "admin";
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
  /** Monotonic server revision used by owner-scoped lifecycle CAS. */
  revision?: number;
  /** Server-side tenant owner. It is injected from the authenticated store row,
   * never trusted from a client request. Optional only for legacy/test callers. */
  ownerUserId?: string;
  /** Durable account binding. Legacy configs resolve to the venue default. */
  accountId?: string;
  /** Canonical paper portfolio binding. Present only for paper robots after R4 migration. */
  paperPortfolioId?: string;
  /** Capital reserved from the portfolio, stored as fixed USDT micros. */
  paperAllocationMicros?: number;
  /** Versioned append-only paper ledger epoch. */
  paperLedgerEpoch?: number;
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
  /** Explicit opt-in to using non-settlement assets as Bybit UTA cross collateral. */
  bybitCrossCollateral?: boolean;
  /** Notify on signals that don't open trades (marker blocks). */
  notifyMarkers: boolean;
  /** Live risk caps (quote currency). Mandatory and >0 for non-paper bots. */
  maxPositionQuote?: number;
  maxOrderQuote?: number;
  maxDailyLossQuote?: number;
  maxOpenOrders?: number;
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
  /** Exchange reports a distinct long/short leg instead of one-way mode. */
  hedged?: boolean;
  /** Bybit positionIdx (1 = long leg, 2 = short leg; 0/undefined = one-way). */
  positionIndex?: number;
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

export type OrderJournalStatus =
  | "intent"
  | "accepted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "replaced"
  | "expired"
  | "rejected"
  | "unknown";

export type ExecutionLifecycleStatus =
  | "entry_submitted"
  | "entry_confirmed"
  | "protection_submitted"
  | "protection_confirmed"
  | "open_protected"
  | "open_unprotected"
  | "exiting"
  | "error";

export interface OrderJournalRecord {
  id: string;
  botId: string;
  /** SHA-256 of the canonical JSON-safe submitted intent. New rows always
   * carry it so a crash between row/event writes cannot weaken replay checks. */
  intentHash?: string;
  /** Account identity at submission time; absent only on legacy journal rows. */
  accountId?: string;
  exchange: ExchangeId;
  market: MarketType;
  symbol: string;
  action: ExecAction;
  side?: Side;
  type: OrderType;
  qty?: number;
  price?: number;
  trgPrice?: number;
  reduceOnly?: boolean;
  reason: string;
  clientId?: string;
  exchangeOrderId?: string;
  status: OrderJournalStatus;
  executionStatus?: ExecutionLifecycleStatus;
  message?: string;
  filledQty?: number;
  /** Fill quantity already committed to the local inventory/position accounting boundary. */
  accountedFilledQty?: number;
  avgFillPrice?: number;
  /** Maximum exchange order slots reserved until the entry outcome is observable. */
  reservedOpenOrderCount?: number;
  barTime?: number;
  ts: number;
  updatedAt: number;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  botId: string;
  type: "intent" | "result" | "fill" | "reconcile" | "update";
  data: unknown;
  ts: number;
}

export interface AuditLogRecord {
  id: string;
  /** Tenant whose trading resources the request targeted. */
  ownerUserId?: string;
  /** Authenticated database user. Legacy token sessions may omit it. */
  actorUserId?: string;
  actor: string;
  role: AuthRole;
  action: string;
  target?: string;
  statusCode: number;
  ip?: string;
  data?: unknown;
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
  /** Actual venue commission asset when reported (paper uses account currency). */
  feeAsset?: string;
  realizedPnl: number;
  kind: "open" | "close";
  reason: string;
  /** Venue order identity when the fill came from a resting/asynchronous order. */
  orderId?: string;
  clientId?: string;
  ts: number;
}

export interface ExchangeExecutionFill {
  id: string;
  qty: number;
  price: number;
  fee: number;
  feeAsset?: string;
  realizedPnl: number;
  side?: Side;
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
  positionIndex?: number;
  dualSide?: boolean;
  isolated?: boolean;
  ignoreSide?: boolean;
  upsert?: boolean;
  forceReplace?: boolean;
  includeLimit?: boolean;
  clearStage?: boolean;
  stop?: StopSpec;
  takeProfits?: TpLevel[];
  /** Internal deterministic identities assigned before live protection I/O. */
  protectionClientIds?: {
    stop?: string;
    takeProfits?: string[];
    safetyClose?: string;
  };
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
  /** Exchange-side SL/TP acknowledgement for an entry that requested protection. */
  protection?: {
    requested: boolean;
    confirmed: boolean;
    message?: string;
    entryOrderId?: string;
    stopOrderIds?: string[];
    takeProfitOrderIds?: string[];
    /** Emergency reduce-only close submitted after protection setup failed. */
    safetyCloseAttempted?: boolean;
    safetyCloseConfirmed?: boolean;
    safetyCloseOrderId?: string;
    safetyCloseClientId?: string;
    /** Protection orders whose cancellation could not be proven. */
    orphanProtectionOrderIds?: string[];
    verification?: "order_ids" | "exchange_ack";
  };
  /** Resting order accepted by an adapter; used to correlate later fills. */
  pendingOrder?: PendingOrder;
  order?: OrderRecord;
  orders?: PendingOrder[];
  position?: PositionState | null;
  account?: AccountState;
  /** Free-form data for GET responses. */
  data?: unknown;
}

export interface ExchangeOrderSnapshot {
  id: string;
  clientId?: string;
  status: Exclude<OrderJournalStatus, "intent" | "replaced">;
  qty: number;
  filledQty: number;
  avgFillPrice?: number;
  updatedAt: number;
  /** One deduplicatable private-stream execution attached to this aggregate update. */
  execution?: ExchangeExecutionFill;
}

export interface PrivateOrderSubscription {
  close(): void;
  connected(): boolean;
}

/** One exchange account's aggregated live state (deduped across bots). */
export type PortfolioResourceCoverage = "account-wide" | "bot-symbols-only" | "unavailable";

export interface PortfolioExchange {
  /** Account id + market. Also the dedupe key. */
  id: string;
  accountId: string;
  exchange: ExchangeId;
  market: MarketType;
  equity: number;
  balance: number;
  currency: string;
  positions: PositionState[];
  /** Whether positions cover the whole account or only the running bots' symbols. */
  positionsCoverage: PortfolioResourceCoverage;
  openOrders: PendingOrder[];
  /** Whether open orders cover the whole account or only the running bots' symbols. */
  openOrdersCoverage: PortfolioResourceCoverage;
  /** Present when the account balance/equity read failed for this exchange. */
  error?: string;
}

/** Cross-bot portfolio summary returned by GET /api/trade/portfolio. */
export interface PortfolioSummary {
  exchanges: PortfolioExchange[];
  /** Realized PnL booked today, keyed by botId (running bots only). */
  realizedTodayByBot: Record<string, number>;
  totalRealizedToday: number;
  /** Paper bots' isolated sim state (never aggregated with live accounts). */
  paper: Array<{ botId: string; name: string; symbol: string; equity: number; balance: number; position: PositionState | null; openOrders: PendingOrder[] }>;
}

export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly market: MarketType;
  /** Durable account identity when the adapter is account-backed. */
  readonly accountId?: string;
  price(symbol: string): Promise<number>;
  account(): Promise<AccountState>;
  position(symbol: string): Promise<PositionState | null>;
  /** Every currently open derivative position on this account/market. */
  positions?(): Promise<PositionState[]>;
  execute(order: ExecOrder): Promise<ExecResult>;
  /** Resting orders (paper/futures). */
  orders?(symbol?: string): Promise<PendingOrder[]>;
  /** Signed fallback query used when a private order stream is unavailable. */
  orderStatus?(symbol: string, identity: { orderId?: string; clientId?: string }): Promise<ExchangeOrderSnapshot | null>;
  /** Authenticated order updates; REST status polling remains the disconnect fallback. */
  subscribeOrderUpdates?(
    onSnapshot: (snapshot: ExchangeOrderSnapshot) => void,
    onConnection: (connected: boolean, message: string) => void,
    signal: AbortSignal
  ): Promise<PrivateOrderSubscription>;
  /** Feed a live price so resting orders can trigger (paper). */
  onPrice?(symbol: string, price: number): FillRecord[];
}

/** Durable, non-secret metadata for a connected or planned live account. */
export interface TradingAccount {
  id: string;
  /** Server-side tenant owner; injected by the store. */
  ownerUserId?: string;
  label: string;
  exchange: TradingAccountExchange;
  ownership: TradingAccountOwnership;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Public API projection for an owner-isolated exchange account. */
export interface TradingAccountCapabilityView extends TradingAccount {
  status: TradingAccountRuntimeStatus;
  credential: {
    mode: "account_isolated";
    status: TradingAccountCredentialStatus;
    isolated: true;
  };
  capabilities: {
    liveExecution: boolean;
    credentialIsolation: true;
    multipleCredentialAccounts: true;
  };
  botIds: string[];
}
