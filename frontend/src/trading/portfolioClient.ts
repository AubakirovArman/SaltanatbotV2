import { tradeApiRequest, type ExchangeId, type MarketType } from "./tradeClient";

export interface PortfolioPosition {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  leverage: number;
  hedged?: boolean;
  positionIndex?: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: number;
}

export interface PortfolioOrder {
  id: string;
  clientId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market" | "stop_limit" | "tp_market" | "tp_limit";
  qty: number;
  price?: number;
  trgPrice?: number;
  reduceOnly: boolean;
  tif: string;
  createdAt: number;
}

export type PortfolioResourceCoverage = "account-wide" | "bot-symbols-only" | "unavailable";

export interface PortfolioExchangeAccount {
  id: string;
  accountId: string;
  exchange: ExchangeId;
  market: MarketType;
  equity: number;
  balance: number;
  currency: string;
  positions: PortfolioPosition[];
  positionsCoverage: PortfolioResourceCoverage;
  openOrders: PortfolioOrder[];
  openOrdersCoverage: PortfolioResourceCoverage;
  error?: string;
}

export interface PortfolioPaperBot {
  botId: string;
  name: string;
  symbol: string;
  equity: number;
  balance: number;
  position: PortfolioPosition | null;
  openOrders: PortfolioOrder[];
}

export interface PortfolioSummary {
  exchanges: PortfolioExchangeAccount[];
  realizedTodayByBot: Record<string, number>;
  totalRealizedToday: number;
  paper: PortfolioPaperBot[];
}

const exchanges = new Set<ExchangeId>(["paper", "binance", "bybit"]);
const markets = new Set<MarketType>(["spot", "futures"]);
const positionSides = new Set(["long", "short"] as const);
const orderSides = new Set(["buy", "sell"] as const);
const orderTypes = new Set(["market", "limit", "stop_market", "stop_limit", "tp_market", "tp_limit"] as const);
const resourceCoverages = new Set<PortfolioResourceCoverage>(["account-wide", "bot-symbols-only", "unavailable"]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${path} must be a string`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : number(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path, true);
}

function array<T>(value: unknown, path: string, parse: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => parse(item, `${path}[${index}]`));
}

function parsePosition(value: unknown, path: string): PortfolioPosition {
  const item = record(value, path);
  const side = string(item.side, `${path}.side`);
  if (!positionSides.has(side as "long" | "short")) throw new Error(`${path}.side is invalid`);
  return {
    symbol: string(item.symbol, `${path}.symbol`),
    side: side as PortfolioPosition["side"],
    qty: number(item.qty, `${path}.qty`),
    entryPrice: number(item.entryPrice, `${path}.entryPrice`),
    leverage: number(item.leverage, `${path}.leverage`),
    hedged: item.hedged === undefined ? undefined : boolean(item.hedged, `${path}.hedged`),
    positionIndex: optionalNumber(item.positionIndex, `${path}.positionIndex`),
    stopPrice: optionalNumber(item.stopPrice, `${path}.stopPrice`),
    targetPrice: optionalNumber(item.targetPrice, `${path}.targetPrice`),
    openedAt: number(item.openedAt, `${path}.openedAt`)
  };
}

function parseOrder(value: unknown, path: string): PortfolioOrder {
  const item = record(value, path);
  const side = string(item.side, `${path}.side`);
  const type = string(item.type, `${path}.type`);
  if (!orderSides.has(side as "buy" | "sell")) throw new Error(`${path}.side is invalid`);
  if (!orderTypes.has(type as PortfolioOrder["type"])) throw new Error(`${path}.type is invalid`);
  return {
    id: string(item.id, `${path}.id`),
    clientId: optionalString(item.clientId, `${path}.clientId`),
    symbol: string(item.symbol, `${path}.symbol`),
    side: side as PortfolioOrder["side"],
    type: type as PortfolioOrder["type"],
    qty: number(item.qty, `${path}.qty`),
    price: optionalNumber(item.price, `${path}.price`),
    trgPrice: optionalNumber(item.trgPrice, `${path}.trgPrice`),
    reduceOnly: boolean(item.reduceOnly, `${path}.reduceOnly`),
    tif: string(item.tif, `${path}.tif`),
    createdAt: number(item.createdAt, `${path}.createdAt`)
  };
}

function parseExchange(value: unknown, path: string): PortfolioExchangeAccount {
  const item = record(value, path);
  const exchange = string(item.exchange, `${path}.exchange`);
  const market = string(item.market, `${path}.market`);
  if (!exchanges.has(exchange as ExchangeId) || exchange === "paper") throw new Error(`${path}.exchange is invalid`);
  if (!markets.has(market as MarketType)) throw new Error(`${path}.market is invalid`);
  const positionsCoverage = string(item.positionsCoverage, `${path}.positionsCoverage`);
  const openOrdersCoverage = string(item.openOrdersCoverage, `${path}.openOrdersCoverage`);
  if (!resourceCoverages.has(positionsCoverage as PortfolioResourceCoverage)) throw new Error(`${path}.positionsCoverage is invalid`);
  if (!resourceCoverages.has(openOrdersCoverage as PortfolioResourceCoverage)) throw new Error(`${path}.openOrdersCoverage is invalid`);
  return {
    id: string(item.id, `${path}.id`),
    accountId: string(item.accountId, `${path}.accountId`),
    exchange: exchange as ExchangeId,
    market: market as MarketType,
    equity: number(item.equity, `${path}.equity`),
    balance: number(item.balance, `${path}.balance`),
    currency: string(item.currency, `${path}.currency`),
    positions: array(item.positions, `${path}.positions`, parsePosition),
    positionsCoverage: positionsCoverage as PortfolioResourceCoverage,
    openOrders: array(item.openOrders, `${path}.openOrders`, parseOrder),
    openOrdersCoverage: openOrdersCoverage as PortfolioResourceCoverage,
    error: optionalString(item.error, `${path}.error`)
  };
}

function parsePaperBot(value: unknown, path: string): PortfolioPaperBot {
  const item = record(value, path);
  return {
    botId: string(item.botId, `${path}.botId`),
    name: string(item.name, `${path}.name`),
    symbol: string(item.symbol, `${path}.symbol`),
    equity: number(item.equity, `${path}.equity`),
    balance: number(item.balance, `${path}.balance`),
    position: item.position === null ? null : parsePosition(item.position, `${path}.position`),
    openOrders: array(item.openOrders, `${path}.openOrders`, parseOrder)
  };
}

/** Runtime boundary for the authenticated portfolio endpoint. */
export function parsePortfolioSummary(value: unknown): PortfolioSummary {
  try {
    const item = record(value, "portfolio");
    const rawRealized = record(item.realizedTodayByBot, "portfolio.realizedTodayByBot");
    const realizedTodayByBot = Object.fromEntries(
      Object.entries(rawRealized).map(([botId, realized]) => [botId, number(realized, `portfolio.realizedTodayByBot.${botId}`)])
    );
    return {
      exchanges: array(item.exchanges, "portfolio.exchanges", parseExchange),
      realizedTodayByBot,
      totalRealizedToday: number(item.totalRealizedToday, "portfolio.totalRealizedToday"),
      paper: array(item.paper, "portfolio.paper", parsePaperBot)
    };
  } catch (cause) {
    throw new Error(`Invalid portfolio response: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export const getPortfolio = (): Promise<PortfolioSummary> =>
  tradeApiRequest<unknown>("/portfolio").then(parsePortfolioSummary);
