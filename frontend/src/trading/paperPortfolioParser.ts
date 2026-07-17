import {
  PAPER_METRICS_FORMULA_VERSION,
  PAPER_PORTFOLIO_LIST_SCHEMA_VERSION,
  PAPER_PORTFOLIO_SCHEMA_VERSION,
  type EvidenceValue,
  type PaperCashConservation,
  type PaperMoney,
  type PaperOpenOrderProjection,
  type PaperPortfolioAggregates,
  type PaperPortfolioDetail,
  type PaperPortfolioListResponse,
  type PaperPortfolioMetadata,
  type PaperPortfolioMutationResult,
  type PaperPortfolioProjection,
  type PaperPositionProjection,
  type PaperRobotMetrics,
  type PaperRobotProjection,
  type PaperRobotRuntimeMetadata,
  type PaperTradeStatistics
} from "./paperPortfolioTypes";
import { parsePaperRobotJournal, validatePaperRuntimeJournals } from "./paperRobotJournalParser";

type JsonRecord = Record<string, unknown>;

export function parsePaperPortfolioList(value: unknown, expectedOwnerUserId?: string): PaperPortfolioListResponse {
  return boundary("paper portfolio list", () => {
    const item = object(value, "list");
    literal(item.schemaVersion, PAPER_PORTFOLIO_LIST_SCHEMA_VERSION, "list.schemaVersion");
    const portfolios = array(item.portfolios, "list.portfolios", parseMetadata);
    if (expectedOwnerUserId) portfolios.forEach((portfolio, index) => owner(portfolio.ownerUserId, expectedOwnerUserId, `list.portfolios[${index}]`));
    return { schemaVersion: PAPER_PORTFOLIO_LIST_SCHEMA_VERSION, asOf: timestamp(item.asOf, "list.asOf"), portfolios };
  });
}

export function parsePaperPortfolioDetail(value: unknown, expectedOwnerUserId?: string, expectedPortfolioId?: string): PaperPortfolioDetail {
  return boundary("paper portfolio detail", () => {
    const item = object(value, "detail");
    const portfolio = parseMetadata(item.portfolio, "detail.portfolio");
    const snapshot = parseProjection(item.snapshot, "detail.snapshot");
    if (expectedOwnerUserId) owner(portfolio.ownerUserId, expectedOwnerUserId, "detail.portfolio");
    if (expectedPortfolioId && portfolio.id !== expectedPortfolioId) fail("detail.portfolio.id does not match the requested portfolio");
    if (snapshot.ownerUserId !== portfolio.ownerUserId || snapshot.portfolioId !== portfolio.id || snapshot.ledgerEpoch !== portfolio.currentEpoch) {
      fail("detail snapshot identity does not match portfolio metadata");
    }
    const robots = item.robots === undefined ? [] : array(item.robots, "detail.robots", parseRuntimeMetadata);
    validatePaperRuntimeJournals(snapshot, robots, "detail.robots");
    return {
      portfolio,
      snapshot,
      robots,
      lastError: optionalText(item.lastError, "detail.lastError")
    };
  });
}

export function parsePaperPortfolioMutation(value: unknown, expectedOwnerUserId?: string): PaperPortfolioMutationResult {
  return boundary("paper portfolio mutation", () => {
    const item = object(value, "mutation");
    const portfolio = parseMetadata(item.portfolio, "mutation.portfolio");
    if (expectedOwnerUserId) owner(portfolio.ownerUserId, expectedOwnerUserId, "mutation.portfolio");
    const snapshot = parseProjection(item.snapshot, "mutation.snapshot");
    if (snapshot.ownerUserId !== portfolio.ownerUserId || snapshot.portfolioId !== portfolio.id || snapshot.ledgerEpoch !== portfolio.currentEpoch) {
      fail("mutation snapshot identity does not match portfolio metadata");
    }
    const robots = array(item.robots, "mutation.robots", parseRuntimeMetadata);
    validatePaperRuntimeJournals(snapshot, robots, "mutation.robots");
    return {
      portfolio,
      snapshot,
      robots,
      lastError: optionalText(item.lastError, "mutation.lastError"),
      replayed: optionalBoolean(item.replayed, "mutation.replayed")
    };
  });
}

export function parsePaperPortfolioProjection(value: unknown): PaperPortfolioProjection {
  return boundary("paper portfolio projection", () => parseProjection(value, "snapshot"));
}

function parseProjection(value: unknown, path: string): PaperPortfolioProjection {
  const item = object(value, path);
  literal(item.schemaVersion, PAPER_PORTFOLIO_SCHEMA_VERSION, `${path}.schemaVersion`);
  literal(item.formulaVersion, PAPER_METRICS_FORMULA_VERSION, `${path}.formulaVersion`);
  const result: PaperPortfolioProjection = {
    schemaVersion: PAPER_PORTFOLIO_SCHEMA_VERSION,
    formulaVersion: PAPER_METRICS_FORMULA_VERSION,
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    portfolioId: text(item.portfolioId, `${path}.portfolioId`),
    ledgerEpoch: positiveInteger(item.ledgerEpoch, `${path}.ledgerEpoch`),
    epochStartedAt: timestamp(item.epochStartedAt, `${path}.epochStartedAt`),
    asOf: timestamp(item.asOf, `${path}.asOf`),
    robots: array(item.robots, `${path}.robots`, parseRobot),
    positions: array(item.positions, `${path}.positions`, parsePosition),
    openOrders: array(item.openOrders, `${path}.openOrders`, parseOpenOrder),
    aggregates: parseAggregates(item.aggregates, `${path}.aggregates`),
    cashConservation: parseCashConservation(item.cashConservation, `${path}.cashConservation`)
  };
  if (result.epochStartedAt > result.asOf) fail(`${path}.epochStartedAt cannot be later than asOf`);
  result.robots.forEach((robot, index) => projectionIdentity(result, robot, `${path}.robots[${index}]`));
  result.positions.forEach((position, index) => childIdentity(result, position, `${path}.positions[${index}]`));
  result.openOrders.forEach((order, index) => childIdentity(result, order, `${path}.openOrders[${index}]`));
  return result;
}

function parseMetadata(value: unknown, path: string): PaperPortfolioMetadata {
  const item = object(value, path);
  const status = oneOf(item.status, ["active", "archived"] as const, `${path}.status`);
  literal(item.currency, "USDT", `${path}.currency`);
  const archivedAt = optionalTimestamp(item.archivedAt, `${path}.archivedAt`);
  if (status === "archived" && archivedAt === undefined) fail(`${path}.archivedAt is required for an archived portfolio`);
  return {
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    id: text(item.id, `${path}.id`),
    name: text(item.name, `${path}.name`),
    status,
    currency: "USDT",
    revision: positiveInteger(item.revision, `${path}.revision`),
    currentEpoch: positiveInteger(item.currentEpoch, `${path}.currentEpoch`),
    isDefault: boolean(item.isDefault, `${path}.isDefault`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    archivedAt
  };
}

function parseRobot(value: unknown, path: string): PaperRobotProjection {
  const item = object(value, path);
  return {
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    portfolioId: text(item.portfolioId, `${path}.portfolioId`),
    ledgerEpoch: positiveInteger(item.ledgerEpoch, `${path}.ledgerEpoch`),
    botId: text(item.botId, `${path}.botId`),
    botRevision: positiveInteger(item.botRevision, `${path}.botRevision`),
    market: oneOf(item.market, ["spot", "futures"] as const, `${path}.market`),
    allocation: money(item.allocation, `${path}.allocation`),
    allocationStatus: oneOf(item.allocationStatus, ["active", "released", "closed"] as const, `${path}.allocationStatus`),
    runtimeState: oneOf(item.runtimeState, ["idle", "orders_open", "position_open", "position_and_orders_open"] as const, `${path}.runtimeState`),
    ledger: parseLedger(item.ledger, `${path}.ledger`),
    metrics: parseRobotMetrics(item.metrics, `${path}.metrics`),
    positions: array(item.positions, `${path}.positions`, parsePosition),
    openOrders: array(item.openOrders, `${path}.openOrders`, parseOpenOrder),
    cashConservation: parseCashConservation(item.cashConservation, `${path}.cashConservation`)
  };
}

function parsePosition(value: unknown, path: string): PaperPositionProjection {
  const item = object(value, path);
  return {
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    portfolioId: text(item.portfolioId, `${path}.portfolioId`),
    ledgerEpoch: positiveInteger(item.ledgerEpoch, `${path}.ledgerEpoch`),
    botId: text(item.botId, `${path}.botId`),
    botRevision: positiveInteger(item.botRevision, `${path}.botRevision`),
    symbol: text(item.symbol, `${path}.symbol`),
    side: oneOf(item.side, ["long", "short"] as const, `${path}.side`),
    qty: finite(item.qty, `${path}.qty`),
    entryPrice: money(item.entryPrice, `${path}.entryPrice`),
    leverage: finite(item.leverage, `${path}.leverage`),
    openedAt: timestamp(item.openedAt, `${path}.openedAt`),
    markPrice: evidence(item.markPrice, `${path}.markPrice`, money),
    unrealizedPnl: evidence(item.unrealizedPnl, `${path}.unrealizedPnl`, money),
    grossExposure: evidence(item.grossExposure, `${path}.grossExposure`, money),
    netExposure: evidence(item.netExposure, `${path}.netExposure`, money),
    committedCapital: evidence(item.committedCapital, `${path}.committedCapital`, money),
    positionMargin: evidence(item.positionMargin, `${path}.positionMargin`, money)
  };
}

function parseOpenOrder(value: unknown, path: string): PaperOpenOrderProjection {
  const item = object(value, path);
  return {
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    portfolioId: text(item.portfolioId, `${path}.portfolioId`),
    ledgerEpoch: positiveInteger(item.ledgerEpoch, `${path}.ledgerEpoch`),
    botId: text(item.botId, `${path}.botId`),
    botRevision: positiveInteger(item.botRevision, `${path}.botRevision`),
    id: text(item.id, `${path}.id`),
    symbol: text(item.symbol, `${path}.symbol`),
    side: oneOf(item.side, ["buy", "sell"] as const, `${path}.side`),
    type: oneOf(item.type, ["market", "limit", "stop_market", "stop_limit", "tp_market", "tp_limit"] as const, `${path}.type`),
    qty: finite(item.qty, `${path}.qty`),
    reduceOnly: boolean(item.reduceOnly, `${path}.reduceOnly`),
    tif: oneOf(item.tif, ["GTC", "IOC", "FOK"] as const, `${path}.tif`),
    createdAt: timestamp(item.createdAt, `${path}.createdAt`),
    referencePrice: evidence(item.referencePrice, `${path}.referencePrice`, money),
    committedCapital: evidence(item.committedCapital, `${path}.committedCapital`, money),
    clientId: optionalText(item.clientId, `${path}.clientId`),
    price: optionalMoney(item.price, `${path}.price`),
    triggerPrice: optionalMoney(item.triggerPrice, `${path}.triggerPrice`)
  };
}

function parseAggregates(value: unknown, path: string): PaperPortfolioAggregates {
  const item = object(value, path);
  return {
    allocatedCapital: money(item.allocatedCapital, `${path}.allocatedCapital`),
    unallocatedCash: money(item.unallocatedCash, `${path}.unallocatedCash`),
    initialCapital: money(item.initialCapital, `${path}.initialCapital`),
    cashBalance: money(item.cashBalance, `${path}.cashBalance`),
    feesPaid: money(item.feesPaid, `${path}.feesPaid`),
    fundingNet: money(item.fundingNet, `${path}.fundingNet`),
    realizedNetCashPnl: money(item.realizedNetCashPnl, `${path}.realizedNetCashPnl`),
    legacyCashAdjustments: money(item.legacyCashAdjustments, `${path}.legacyCashAdjustments`),
    cashEventMaxDrawdown: money(item.cashEventMaxDrawdown, `${path}.cashEventMaxDrawdown`),
    unrealizedPnl: evidence(item.unrealizedPnl, `${path}.unrealizedPnl`, money),
    grossExposure: evidence(item.grossExposure, `${path}.grossExposure`, money),
    netExposure: evidence(item.netExposure, `${path}.netExposure`, money),
    equity: evidence(item.equity, `${path}.equity`, money),
    reservedCapital: money(item.reservedCapital, `${path}.reservedCapital`),
    availableCapital: money(item.availableCapital, `${path}.availableCapital`),
    committedCapital: evidence(item.committedCapital, `${path}.committedCapital`, money),
    margin: evidence(item.margin, `${path}.margin`, money),
    borrowing: evidence(item.borrowing, `${path}.borrowing`, money),
    tradeStatistics: parseTradeStatistics(item.tradeStatistics, `${path}.tradeStatistics`)
  };
}

function parseRobotMetrics(value: unknown, path: string): PaperRobotMetrics {
  const item = object(value, path);
  return {
    cashBalance: money(item.cashBalance, `${path}.cashBalance`),
    feesPaid: money(item.feesPaid, `${path}.feesPaid`),
    fundingNet: money(item.fundingNet, `${path}.fundingNet`),
    realizedNetCashPnl: money(item.realizedNetCashPnl, `${path}.realizedNetCashPnl`),
    legacyCashAdjustments: money(item.legacyCashAdjustments, `${path}.legacyCashAdjustments`),
    cashEventMaxDrawdown: money(item.cashEventMaxDrawdown, `${path}.cashEventMaxDrawdown`),
    unrealizedPnl: evidence(item.unrealizedPnl, `${path}.unrealizedPnl`, money),
    grossExposure: evidence(item.grossExposure, `${path}.grossExposure`, money),
    netExposure: evidence(item.netExposure, `${path}.netExposure`, money),
    equity: evidence(item.equity, `${path}.equity`, money),
    reservedCapital: money(item.reservedCapital, `${path}.reservedCapital`),
    committedCapital: evidence(item.committedCapital, `${path}.committedCapital`, money),
    margin: evidence(item.margin, `${path}.margin`, money),
    borrowing: evidence(item.borrowing, `${path}.borrowing`, money),
    tradeStatistics: parseTradeStatistics(item.tradeStatistics, `${path}.tradeStatistics`)
  };
}

function parseTradeStatistics(value: unknown, path: string): PaperTradeStatistics {
  const item = object(value, path);
  return {
    closedTrades: nonNegativeInteger(item.closedTrades, `${path}.closedTrades`),
    winningTrades: nonNegativeInteger(item.winningTrades, `${path}.winningTrades`),
    losingTrades: nonNegativeInteger(item.losingTrades, `${path}.losingTrades`),
    breakevenTrades: nonNegativeInteger(item.breakevenTrades, `${path}.breakevenTrades`),
    grossProfit: money(item.grossProfit, `${path}.grossProfit`),
    grossLoss: money(item.grossLoss, `${path}.grossLoss`),
    winRate: evidence(item.winRate, `${path}.winRate`, finite),
    profitFactor: evidence(item.profitFactor, `${path}.profitFactor`, finite),
    expectancy: evidence(item.expectancy, `${path}.expectancy`, money)
  };
}

function parseCashConservation(value: unknown, path: string): PaperCashConservation {
  const item = object(value, path);
  literal(item.balanced, true, `${path}.balanced`);
  return {
    expectedCashBalance: money(item.expectedCashBalance, `${path}.expectedCashBalance`),
    actualCashBalance: money(item.actualCashBalance, `${path}.actualCashBalance`),
    difference: money(item.difference, `${path}.difference`),
    balanced: true
  };
}

function parseLedger(value: unknown, path: string): PaperRobotProjection["ledger"] {
  const item = object(value, path);
  return {
    eventCount: nonNegativeInteger(item.eventCount, `${path}.eventCount`),
    lastSequence: nonNegativeInteger(item.lastSequence, `${path}.lastSequence`),
    observedAt: timestamp(item.observedAt, `${path}.observedAt`)
  };
}

function parseRuntimeMetadata(value: unknown, path: string): PaperRobotRuntimeMetadata {
  const item = object(value, path);
  return {
    botId: text(item.botId, `${path}.botId`),
    botRevision: optionalPositiveInteger(item.botRevision, `${path}.botRevision`),
    name: optionalText(item.name, `${path}.name`),
    strategyName: optionalText(item.strategyName, `${path}.strategyName`),
    symbol: optionalText(item.symbol, `${path}.symbol`),
    status: item.status === undefined ? undefined : oneOf(item.status, ["idle", "stopped", "running", "paused", "error"] as const, `${path}.status`),
    lastError: optionalText(item.lastError, `${path}.lastError`),
    journal: parsePaperRobotJournal(item.journal, `${path}.journal`)
  };
}

function evidence<T>(value: unknown, path: string, parseValue: (value: unknown, path: string) => T): EvidenceValue<T> {
  const item = object(value, path);
  const status = oneOf(item.status, ["available", "stale", "unavailable"] as const, `${path}.status`);
  if (status === "unavailable") return { status, reason: text(item.reason, `${path}.reason`) };
  const common = {
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    source: text(item.source, `${path}.source`)
  };
  if (status === "available") return { status, value: parseValue(item.value, `${path}.value`), ...common };
  return {
    status,
    lastValue: parseValue(item.lastValue, `${path}.lastValue`),
    ...common,
    staleByMs: nonNegativeInteger(item.staleByMs, `${path}.staleByMs`),
    reason: text(item.reason, `${path}.reason`)
  };
}

function projectionIdentity(parent: PaperPortfolioProjection, robot: PaperRobotProjection, path: string): void {
  childIdentity(parent, robot, path);
  robot.positions.forEach((position, index) => childIdentity(parent, position, `${path}.positions[${index}]`, robot));
  robot.openOrders.forEach((order, index) => childIdentity(parent, order, `${path}.openOrders[${index}]`, robot));
}

function childIdentity(
  parent: PaperPortfolioProjection,
  child: { ownerUserId: string; portfolioId: string; ledgerEpoch: number; botId: string; botRevision: number },
  path: string,
  robot?: PaperRobotProjection
): void {
  if (child.ownerUserId !== parent.ownerUserId || child.portfolioId !== parent.portfolioId || child.ledgerEpoch !== parent.ledgerEpoch) {
    fail(`${path} identity does not match snapshot`);
  }
  if (robot && (child.botId !== robot.botId || child.botRevision !== robot.botRevision)) fail(`${path} identity does not match robot`);
}

function owner(actual: string, expected: string, path: string): void {
  if (actual !== expected) fail(`${path}.ownerUserId does not match the authenticated user`);
}

function object(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} must be an object`);
  return value as JsonRecord;
}

function array<T>(value: unknown, path: string, parser: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value.map((entry, index) => parser(entry, `${path}[${index}]`));
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${path} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function money(value: unknown, path: string): PaperMoney {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)\.\d{6}$/.test(value)) fail(`${path} must be a canonical six-decimal money string`);
  return value;
}

function optionalMoney(value: unknown, path: string): PaperMoney | undefined {
  return value === undefined ? undefined : money(value, path);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be finite`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${path} must be a non-negative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result < 1) fail(`${path} must be positive`);
  return result;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, path);
}

function timestamp(value: unknown, path: string): number {
  return nonNegativeInteger(value, path);
}

function optionalTimestamp(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, path);
}

function literal<T extends string | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(`${path} must equal ${String(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${path} is invalid`);
  return value as T[number];
}

function boundary<T>(name: string, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new Error(`Invalid ${name} response: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}
