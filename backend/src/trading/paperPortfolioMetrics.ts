import { replayPaperLedger, type PaperLedgerEvent } from "./paperLedger.js";
import {
  PAPER_METRICS_FORMULA_VERSION,
  PAPER_PORTFOLIO_SCHEMA_VERSION,
  type EvidenceValue,
  type PaperCashConservation,
  type PaperDurableMarkInput,
  type PaperMoney,
  type PaperOpenOrderProjection,
  type PaperPortfolioProjection,
  type PaperPortfolioProjectionInput,
  type PaperPositionProjection,
  type PaperRobotProjection,
  type PaperRobotProjectionContext,
  type PaperRobotProjectionInput,
  type PaperTradeStatistics
} from "./paperPortfolioTypes.js";
import type { PendingOrder, PositionState } from "./types.js";

export const PAPER_MONEY_DECIMALS = 6;
export const PAPER_PORTFOLIO_MAX_ROBOTS = 256;
export const PAPER_PORTFOLIO_MAX_EVENTS_PER_ROBOT = 20_000;
export const PAPER_PORTFOLIO_MAX_TOTAL_EVENTS = 100_000;
export const PAPER_PORTFOLIO_MAX_MARKS_PER_ROBOT = 64;

const MONEY_SCALE = 1_000_000n;
const QUANTITY_SCALE = 100_000_000n;
const MAX_LEDGER_NUMBER = 1_000_000_000;
const CANONICAL_MONEY = /^-?(?:0|[1-9]\d*)\.\d{6}$/;
type MoneyUnits = bigint;

interface CashAnalysis {
  feesPaid: MoneyUnits;
  fundingNet: MoneyUnits;
  realizedNetCashPnl: MoneyUnits;
  legacyCashAdjustments: MoneyUnits;
  cashEventMaxDrawdown: MoneyUnits;
  cashDeltas: Array<{ ts: number; amount: MoneyUnits }>;
  closingPnls: MoneyUnits[];
}

interface RobotResult {
  projection: PaperRobotProjection;
  allocationStatus: PaperRobotProjectionInput["allocationStatus"];
  allocation: MoneyUnits;
  cashBalance: MoneyUnits;
  analysis: CashAnalysis;
}

/** Pure, bounded projection of current-epoch paper ledgers and durable marks. */
export function projectPaperPortfolio(input: PaperPortfolioProjectionInput): PaperPortfolioProjection {
  const context = validatePortfolioInput(input);
  const seenBots = new Set<string>();
  let totalEvents = 0;
  for (const robot of input.robots) {
    if (seenBots.has(robot.botId)) throw new Error(`Duplicate paper portfolio bot ${robot.botId}`);
    seenBots.add(robot.botId);
    totalEvents += robot.ledgerEvents.length;
  }
  if (totalEvents > PAPER_PORTFOLIO_MAX_TOTAL_EVENTS) throw new Error("Paper portfolio event limit exceeded");

  const results = input.robots.map((robot) => projectRobotInternal(robot, context))
    .sort((left, right) => left.projection.botId.localeCompare(right.projection.botId));
  const robots = results.map((result) => result.projection);
  const activeResults = results.filter((result) => result.allocationStatus === "active");
  const activeRobots = activeResults.map((result) => result.projection);
  const initialCapital = parseBoundedMoney(input.initialCapital, "initial capital", false, true);
  const unallocatedCash = parseBoundedMoney(input.unallocatedCash, "unallocated cash", false);
  const allocatedCapital = sumUnits(activeResults.map((result) => result.allocation));
  const cashBalance = unallocatedCash + sumUnits(activeResults.map((result) => result.cashBalance));
  const feesPaid = sumUnits(results.map((result) => result.analysis.feesPaid));
  const fundingNet = sumUnits(results.map((result) => result.analysis.fundingNet));
  const realizedNetCashPnl = sumUnits(results.map((result) => result.analysis.realizedNetCashPnl));
  const legacyCashAdjustments = sumUnits(results.map((result) => result.analysis.legacyCashAdjustments));
  const observedAt = robots.length > 0 ? Math.max(...robots.map((robot) => robot.ledger.observedAt)) : input.epochStartedAt;
  const aggregate = (select: (robot: PaperRobotProjection) => EvidenceValue<PaperMoney>, label: string) =>
    sumEvidence(activeRobots.map(select), observedAt, `portfolio:${label}`);
  const unrealizedPnl = aggregate((robot) => robot.metrics.unrealizedPnl, "unrealized-pnl");
  const grossExposure = aggregate((robot) => robot.metrics.grossExposure, "gross-exposure");
  const netExposure = aggregate((robot) => robot.metrics.netExposure, "net-exposure");
  const committedCapital = aggregate((robot) => robot.metrics.committedCapital, "committed-capital");
  const margin = sumEvidence(
    activeRobots.filter((robot) => robot.market === "futures").map((robot) => robot.metrics.margin),
    observedAt,
    "portfolio:futures-margin"
  );
  const equity = unrealizedPnl.status === "available"
    ? available(formatMoney(cashBalance + parseMoney(unrealizedPnl.value, "aggregate unrealized PnL")), unrealizedPnl.observedAt, "portfolio:equity")
    : unavailable<PaperMoney>("complete_fresh_marks_required");
  const cashDeltas = results.flatMap((result) => result.analysis.cashDeltas);
  const closingPnls = results.flatMap((result) => result.analysis.closingPnls);
  const conservationResult = conservation(initialCapital, realizedNetCashPnl, fundingNet, legacyCashAdjustments, cashBalance);

  return {
    schemaVersion: PAPER_PORTFOLIO_SCHEMA_VERSION,
    formulaVersion: PAPER_METRICS_FORMULA_VERSION,
    ownerUserId: input.ownerUserId,
    portfolioId: input.portfolioId,
    ledgerEpoch: input.ledgerEpoch,
    epochStartedAt: input.epochStartedAt,
    asOf: input.asOf,
    robots,
    positions: activeRobots.flatMap((robot) => robot.positions),
    openOrders: activeRobots.flatMap((robot) => robot.openOrders),
    aggregates: {
      allocatedCapital: formatMoney(allocatedCapital),
      unallocatedCash: formatMoney(unallocatedCash),
      initialCapital: formatMoney(initialCapital),
      cashBalance: formatMoney(cashBalance),
      feesPaid: formatMoney(feesPaid),
      fundingNet: formatMoney(fundingNet),
      realizedNetCashPnl: formatMoney(realizedNetCashPnl),
      legacyCashAdjustments: formatMoney(legacyCashAdjustments),
      cashEventMaxDrawdown: formatMoney(maxCashDrawdown(initialCapital, cashDeltas)),
      unrealizedPnl,
      grossExposure,
      netExposure,
      equity,
      reservedCapital: formatMoney(allocatedCapital),
      availableCapital: formatMoney(unallocatedCash),
      committedCapital,
      margin,
      borrowing: unavailable("not_modeled_in_paper_portfolio_v1"),
      tradeStatistics: tradeStatistics(closingPnls, observedAt)
    },
    cashConservation: conservationResult
  };
}

/** Project one robot after checking every owner/portfolio/epoch/revision boundary. */
export function projectPaperRobot(input: PaperRobotProjectionInput, context: PaperRobotProjectionContext): PaperRobotProjection {
  return projectRobotInternal(input, validateProjectionContext(context)).projection;
}

function projectRobotInternal(input: PaperRobotProjectionInput, context: PaperRobotProjectionContext): RobotResult {
  validateRobotInput(input, context);
  const state = replayPaperLedger(input.ledgerEvents, input.botId, input.ledgerEpoch);
  const events = canonicalEvents(input.ledgerEvents);
  if (!state.initialized || events.length === 0) throw new Error(`Paper ledger for ${input.botId} is not initialized`);
  const allocation = parseBoundedMoney(input.allocation, "bot allocation", false);
  const initialized = events[0];
  if (initialized.type !== "account_initialized" || ledgerMoney(initialized.data.balance, "initialized balance") !== allocation) {
    throw new Error(`Paper allocation does not match initialized balance for ${input.botId}`);
  }
  const marks = validateMarks(input.currentMarks, input, context);
  const analysis = analyzeCash(events, allocation);
  if (analysis.feesPaid !== ledgerMoney(state.feesPaid, "ledger fees") || analysis.fundingNet !== ledgerMoney(state.fundingNet, "ledger funding")) {
    throw new Error(`Paper ledger accounting mismatch for ${input.botId}`);
  }
  const cashBalance = ledgerMoney(state.balance, "cash balance");
  const expectedBalance = allocation + analysis.realizedNetCashPnl + analysis.fundingNet + analysis.legacyCashAdjustments;
  if (expectedBalance !== cashBalance) throw new Error(`Paper cash conservation failed for ${input.botId}`);
  const observedAt = events.at(-1)?.ts ?? context.epochStartedAt;
  const position = state.position ? projectPosition(state.position, input, marks) : undefined;
  const openOrders = state.orders.map((order) => projectOpenOrder(order, state.leverage, input, marks, observedAt));
  const positions = position ? [position] : [];
  if (input.allocationStatus !== "active" && (positions.length > 0 || openOrders.length > 0)) {
    throw new Error(`Released paper allocation ${input.botId} still has open risk`);
  }
  const unrealizedPnl = position?.unrealizedPnl ?? available(formatMoney(0n), observedAt, "paper-ledger:flat-position");
  const grossExposure = position?.grossExposure ?? available(formatMoney(0n), observedAt, "paper-ledger:flat-position");
  const netExposure = position?.netExposure ?? available(formatMoney(0n), observedAt, "paper-ledger:flat-position");
  const commitmentParts = [position?.committedCapital ?? available(formatMoney(0n), observedAt, "paper-ledger:flat-position"), ...openOrders.map((order) => order.committedCapital)];
  const committedCapital = sumEvidence(commitmentParts, observedAt, "paper-ledger:committed-capital");
  const margin = input.market === "futures" ? committedCapital : unavailable<PaperMoney>("not_applicable_spot");
  const equity = unrealizedPnl.status === "available"
    ? available(formatMoney(cashBalance + parseMoney(unrealizedPnl.value, "unrealized PnL")), unrealizedPnl.observedAt, "paper-ledger+durable-mark:equity")
    : unavailable<PaperMoney>("fresh_mark_required");
  const projection: PaperRobotProjection = {
    ownerUserId: input.ownerUserId,
    portfolioId: input.portfolioId,
    ledgerEpoch: input.ledgerEpoch,
    botId: input.botId,
    botRevision: input.botRevision,
    market: input.market,
    allocationStatus: input.allocationStatus,
    allocation: formatMoney(allocation),
    runtimeState: runtimeState(positions.length > 0, openOrders.length > 0),
    ledger: { eventCount: events.length, lastSequence: state.lastSequence, observedAt },
    metrics: {
      cashBalance: formatMoney(cashBalance),
      feesPaid: formatMoney(analysis.feesPaid),
      fundingNet: formatMoney(analysis.fundingNet),
      realizedNetCashPnl: formatMoney(analysis.realizedNetCashPnl),
      legacyCashAdjustments: formatMoney(analysis.legacyCashAdjustments),
      cashEventMaxDrawdown: formatMoney(analysis.cashEventMaxDrawdown),
      unrealizedPnl,
      grossExposure,
      netExposure,
      equity,
      reservedCapital: formatMoney(input.allocationStatus === "active" ? allocation : 0n),
      committedCapital,
      margin,
      borrowing: unavailable("not_modeled_in_paper_portfolio_v1"),
      tradeStatistics: tradeStatistics(analysis.closingPnls, observedAt)
    },
    positions,
    openOrders,
    cashConservation: conservation(allocation, analysis.realizedNetCashPnl, analysis.fundingNet, analysis.legacyCashAdjustments, cashBalance)
  };
  return { projection, allocationStatus: input.allocationStatus, allocation, cashBalance, analysis };
}

function validatePortfolioInput(input: PaperPortfolioProjectionInput): PaperRobotProjectionContext {
  if (input.schemaVersion !== PAPER_PORTFOLIO_SCHEMA_VERSION) throw new Error("Unsupported paper portfolio schema version");
  if (input.formulaVersion !== PAPER_METRICS_FORMULA_VERSION) throw new Error("Unsupported paper metrics formula version");
  parseBoundedMoney(input.initialCapital, "initial capital", false, true);
  parseBoundedMoney(input.unallocatedCash, "unallocated cash", false);
  if (input.robots.length > PAPER_PORTFOLIO_MAX_ROBOTS) throw new Error("Paper portfolio robot limit exceeded");
  return validateProjectionContext(input);
}

function validateProjectionContext(context: PaperRobotProjectionContext): PaperRobotProjectionContext {
  identity(context.ownerUserId, "owner user");
  identity(context.portfolioId, "portfolio");
  positiveInteger(context.ledgerEpoch, "ledger epoch");
  timestamp(context.epochStartedAt, "epoch start");
  timestamp(context.asOf, "projection time");
  if (context.asOf < context.epochStartedAt) throw new Error("Paper projection predates its epoch");
  nonNegativeInteger(context.markFreshnessMs, "mark freshness");
  return context;
}

function validateRobotInput(input: PaperRobotProjectionInput, context: PaperRobotProjectionContext): void {
  if (input.ownerUserId !== context.ownerUserId || input.portfolioId !== context.portfolioId || input.ledgerEpoch !== context.ledgerEpoch) {
    throw new Error(`Paper robot ${input.botId || "<unknown>"} identity does not match its portfolio`);
  }
  identity(input.botId, "bot");
  positiveInteger(input.botRevision, "bot revision");
  if (input.market !== "spot" && input.market !== "futures") throw new Error(`Invalid paper market for ${input.botId}`);
  if (!["active", "released", "closed"].includes(input.allocationStatus)) {
    throw new Error(`Invalid paper allocation status for ${input.botId}`);
  }
  parseBoundedMoney(input.allocation, "bot allocation", false);
  if (input.ledgerEvents.length > PAPER_PORTFOLIO_MAX_EVENTS_PER_ROBOT) throw new Error(`Paper event limit exceeded for ${input.botId}`);
  if (input.currentMarks.length > PAPER_PORTFOLIO_MAX_MARKS_PER_ROBOT) throw new Error(`Paper mark limit exceeded for ${input.botId}`);
  for (const event of input.ledgerEvents) {
    if (event.ts < context.epochStartedAt || event.ts > context.asOf) throw new Error(`Paper event for ${input.botId} is outside the current epoch`);
  }
}

function validateMarks(
  inputs: readonly PaperDurableMarkInput[],
  robot: PaperRobotProjectionInput,
  context: PaperRobotProjectionContext
): Map<string, EvidenceValue<PaperMoney>> {
  const marks = new Map<string, EvidenceValue<PaperMoney>>();
  for (const mark of inputs) {
    if (
      mark.ownerUserId !== context.ownerUserId
      || mark.portfolioId !== context.portfolioId
      || mark.ledgerEpoch !== context.ledgerEpoch
      || mark.botId !== robot.botId
      || mark.botRevision !== robot.botRevision
    ) throw new Error(`Durable mark identity does not match paper robot ${robot.botId}`);
    const symbol = identity(mark.symbol, "mark symbol");
    if (marks.has(symbol)) throw new Error(`Duplicate current durable mark for ${robot.botId}/${symbol}`);
    const price = formatMoney(parseBoundedMoney(mark.price, "mark price", false, true));
    const observedAt = timestamp(mark.observedAt, "mark observation");
    const expiresAt = timestamp(mark.expiresAt, "mark expiry");
    const persistedAt = timestamp(mark.persistedAt, "mark persistence");
    if (
      mark.durable !== true
      || expiresAt < observedAt
      || persistedAt < observedAt
      || persistedAt > context.asOf
      || observedAt > context.asOf
    ) {
      throw new Error(`Invalid durable mark chronology for ${robot.botId}/${symbol}`);
    }
    const source = identity(mark.source, "mark source");
    const effectiveExpiry = Math.min(expiresAt, observedAt + context.markFreshnessMs);
    marks.set(symbol, context.asOf <= effectiveExpiry
      ? available(price, observedAt, source)
      : {
          status: "stale",
          lastValue: price,
          observedAt,
          source,
          staleByMs: context.asOf - effectiveExpiry,
          reason: "mark_stale"
        });
  }
  return marks;
}

function projectPosition(
  position: PositionState,
  robot: PaperRobotProjectionInput,
  marks: Map<string, EvidenceValue<PaperMoney>>
): PaperPositionProjection {
  const markPrice = marks.get(position.symbol) ?? unavailable<PaperMoney>("mark_missing");
  const mark = markPrice.status === "available" ? parseMoney(markPrice.value, "position mark", false, true) : undefined;
  const entry = ledgerMoney(position.entryPrice, "position entry price");
  const gross = mark === undefined ? undefined : multiplyMoney(position.qty, mark);
  const unrealized = mark === undefined ? undefined : multiplyMoney(position.qty, position.side === "long" ? mark - entry : entry - mark);
  const committed = gross === undefined ? undefined : robot.market === "futures" ? divideMoney(gross, position.leverage) : gross;
  const source = markPrice.status === "available" ? markPrice.source : "";
  const observedAt = markPrice.status === "available" ? markPrice.observedAt : 0;
  return {
    ownerUserId: robot.ownerUserId,
    portfolioId: robot.portfolioId,
    ledgerEpoch: robot.ledgerEpoch,
    botId: robot.botId,
    botRevision: robot.botRevision,
    symbol: position.symbol,
    side: position.side,
    qty: position.qty,
    entryPrice: formatMoney(entry),
    leverage: position.leverage,
    openedAt: position.openedAt,
    markPrice,
    unrealizedPnl: unrealized === undefined ? unavailable("fresh_mark_required") : available(formatMoney(unrealized), observedAt, source),
    grossExposure: gross === undefined ? unavailable("fresh_mark_required") : available(formatMoney(gross), observedAt, source),
    netExposure: gross === undefined ? unavailable("fresh_mark_required") : available(formatMoney(position.side === "long" ? gross : -gross), observedAt, source),
    committedCapital: committed === undefined ? unavailable("fresh_mark_required") : available(formatMoney(committed), observedAt, source),
    positionMargin: robot.market === "spot"
      ? unavailable("not_applicable_spot")
      : committed === undefined
        ? unavailable("fresh_mark_required")
        : available(formatMoney(committed), observedAt, source)
  };
}

function projectOpenOrder(
  order: PendingOrder,
  leverage: number,
  robot: PaperRobotProjectionInput,
  marks: Map<string, EvidenceValue<PaperMoney>>,
  ledgerObservedAt: number
): PaperOpenOrderProjection {
  const explicitPrice = order.price ?? order.trgPrice;
  const referencePrice = explicitPrice === undefined
    ? (marks.get(order.symbol) ?? unavailable<PaperMoney>("mark_missing"))
    : available(formatMoney(ledgerMoney(explicitPrice, "order price")), ledgerObservedAt, "paper-ledger:order-price");
  const committedCapital = order.reduceOnly
    ? available(formatMoney(0n), ledgerObservedAt, "paper-ledger:reduce-only-order")
    : referencePrice.status === "available"
      ? available(formatMoney(robot.market === "futures"
        ? divideMoney(multiplyMoney(order.qty, parseMoney(referencePrice.value, "order reference", false, true)), leverage)
        : multiplyMoney(order.qty, parseMoney(referencePrice.value, "order reference", false, true))), referencePrice.observedAt, referencePrice.source)
      : unavailable<PaperMoney>("fresh_order_reference_price_required");
  return {
    ownerUserId: robot.ownerUserId,
    portfolioId: robot.portfolioId,
    ledgerEpoch: robot.ledgerEpoch,
    botId: robot.botId,
    botRevision: robot.botRevision,
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    qty: order.qty,
    reduceOnly: order.reduceOnly,
    tif: order.tif,
    createdAt: order.createdAt,
    referencePrice,
    committedCapital,
    ...(order.clientId === undefined ? {} : { clientId: order.clientId }),
    ...(order.price === undefined ? {} : { price: formatMoney(ledgerMoney(order.price, "order price")) }),
    ...(order.trgPrice === undefined ? {} : { triggerPrice: formatMoney(ledgerMoney(order.trgPrice, "order trigger price")) })
  };
}

function analyzeCash(events: readonly PaperLedgerEvent[], allocation: MoneyUnits): CashAnalysis {
  let feesPaid = 0n;
  let fundingNet = 0n;
  let realizedCash = 0n;
  let legacyCashAdjustments = 0n;
  const cashDeltas: Array<{ ts: number; amount: MoneyUnits }> = [];
  const closingPnls: MoneyUnits[] = [];
  for (const event of events) {
    if (event.type === "fee") {
      const amount = ledgerMoney(event.data.amount, "fee");
      feesPaid += amount;
      cashDeltas.push({ ts: event.ts, amount: -amount });
    } else if (event.type === "cash") {
      const amount = ledgerMoney(event.data.amount, "cash event");
      if (event.data.reason === "realized-pnl") realizedCash += amount;
      else legacyCashAdjustments += amount;
      cashDeltas.push({ ts: event.ts, amount });
    } else if (event.type === "funding") {
      const amount = ledgerMoney(event.data.amount, "funding event");
      fundingNet += amount;
      cashDeltas.push({ ts: event.ts, amount });
    } else if (event.type === "fill" && event.data.fill.kind === "close") {
      closingPnls.push(ledgerMoney(event.data.fill.realizedPnl, "close fill PnL"));
    }
  }
  return {
    feesPaid,
    fundingNet,
    realizedNetCashPnl: realizedCash - feesPaid,
    legacyCashAdjustments,
    cashEventMaxDrawdown: maxCashDrawdown(allocation, cashDeltas),
    cashDeltas,
    closingPnls
  };
}

function tradeStatistics(closingPnls: readonly MoneyUnits[], observedAt: number): PaperTradeStatistics {
  const winningTrades = closingPnls.filter((value) => value > 0n).length;
  const losingTrades = closingPnls.filter((value) => value < 0n).length;
  const breakevenTrades = closingPnls.length - winningTrades - losingTrades;
  const grossProfit = sumUnits(closingPnls.filter((value) => value > 0n));
  const grossLoss = -sumUnits(closingPnls.filter((value) => value < 0n));
  return {
    closedTrades: closingPnls.length,
    winningTrades,
    losingTrades,
    breakevenTrades,
    grossProfit: formatMoney(grossProfit),
    grossLoss: formatMoney(grossLoss),
    winRate: closingPnls.length === 0 ? unavailable("no_closed_trades") : available(winningTrades / closingPnls.length, observedAt, "paper-ledger:close-fills"),
    profitFactor: closingPnls.length === 0
      ? unavailable("no_closed_trades")
      : grossLoss === 0n
        ? unavailable("no_losing_trades")
        : available(Number(roundDivide(grossProfit * 100_000_000n, grossLoss)) / 100_000_000, observedAt, "paper-ledger:close-fills"),
    expectancy: closingPnls.length === 0
      ? unavailable("no_closed_trades")
      : available(formatMoney(roundDivide(sumUnits(closingPnls), BigInt(closingPnls.length))), observedAt, "paper-ledger:close-fills")
  };
}

function maxCashDrawdown(initialCash: MoneyUnits, deltas: readonly { ts: number; amount: MoneyUnits }[]): MoneyUnits {
  const byTimestamp = new Map<number, MoneyUnits>();
  for (const delta of deltas) byTimestamp.set(delta.ts, (byTimestamp.get(delta.ts) ?? 0n) + delta.amount);
  let cash = initialCash;
  let peak = initialCash;
  let maximum = 0n;
  for (const [, delta] of [...byTimestamp.entries()].sort((left, right) => left[0] - right[0])) {
    cash += delta;
    if (cash > peak) peak = cash;
    if (peak - cash > maximum) maximum = peak - cash;
  }
  return maximum;
}

function conservation(initial: MoneyUnits, realized: MoneyUnits, funding: MoneyUnits, legacy: MoneyUnits, actual: MoneyUnits): PaperCashConservation {
  const expected = initial + realized + funding + legacy;
  const difference = actual - expected;
  if (difference !== 0n) throw new Error("Paper portfolio cash conservation failed");
  return { expectedCashBalance: formatMoney(expected), actualCashBalance: formatMoney(actual), difference: formatMoney(difference), balanced: true };
}

function canonicalEvents(input: readonly PaperLedgerEvent[]): PaperLedgerEvent[] {
  const byId = new Map<string, PaperLedgerEvent>();
  for (const event of input) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function sumEvidence(values: readonly EvidenceValue<PaperMoney>[], observedAt: number, source: string): EvidenceValue<PaperMoney> {
  let total = 0n;
  let oldestObservation: number | undefined;
  for (const value of values) {
    if (value.status !== "available") return unavailable("complete_fresh_marks_required");
    total += parseMoney(value.value, "evidence value");
    oldestObservation = oldestObservation === undefined
      ? value.observedAt
      : Math.min(oldestObservation, value.observedAt);
  }
  return available(formatMoney(total), oldestObservation ?? observedAt, source);
}

function runtimeState(position: boolean, orders: boolean): PaperRobotProjection["runtimeState"] {
  if (position && orders) return "position_and_orders_open";
  if (position) return "position_open";
  if (orders) return "orders_open";
  return "idle";
}

function available<T>(value: T, observedAt: number, source: string): EvidenceValue<T> {
  return { status: "available", value, observedAt, source };
}

function unavailable<T>(reason: string): EvidenceValue<T> {
  return { status: "unavailable", reason };
}

function parseMoney(value: PaperMoney, label: string, signed = true, positive = false): MoneyUnits {
  if (typeof value !== "string" || value.length > 32 || !CANONICAL_MONEY.test(value) || value === "-0.000000") throw new Error(`Invalid canonical ${label}`);
  const negative = value.startsWith("-");
  if ((!signed && negative) || (positive && (negative || value === "0.000000"))) throw new Error(`Invalid ${label}`);
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split(".") as [string, string];
  const units = BigInt(whole) * MONEY_SCALE + BigInt(fraction);
  return negative ? -units : units;
}

function parseBoundedMoney(value: PaperMoney, label: string, signed = true, positive = false): MoneyUnits {
  const units = parseMoney(value, label, signed, positive);
  if ((units < 0n ? -units : units) > BigInt(MAX_LEDGER_NUMBER) * MONEY_SCALE) {
    throw new Error(`${label} exceeds the paper portfolio bound`);
  }
  return units;
}

function formatMoney(value: MoneyUnits): PaperMoney {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(PAPER_MONEY_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function ledgerMoney(value: number, label: string): MoneyUnits {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_LEDGER_NUMBER) throw new Error(`Invalid ${label}`);
  const fixed = Math.abs(value).toFixed(PAPER_MONEY_DECIMALS);
  return parseMoney(`${value < 0 ? "-" : ""}${fixed}`, label);
}

function multiplyMoney(quantity: number, price: MoneyUnits): MoneyUnits {
  return roundDivide(decimalNumberUnits(quantity, 8, "quantity") * price, QUANTITY_SCALE);
}

function divideMoney(value: MoneyUnits, divisor: number): MoneyUnits {
  const scaledDivisor = decimalNumberUnits(divisor, 8, "leverage");
  if (scaledDivisor <= 0n) throw new Error("Invalid leverage");
  return roundDivide(value * QUANTITY_SCALE, scaledDivisor);
}

function decimalNumberUnits(value: number, decimals: number, label: string): bigint {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_LEDGER_NUMBER) throw new Error(`Invalid ${label}`);
  const fixed = Math.abs(value).toFixed(decimals);
  const units = BigInt(fixed.replace(".", ""));
  return value < 0 ? -units : units;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Invalid fixed-point denominator");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function sumUnits(values: readonly MoneyUnits[]): MoneyUnits {
  return values.reduce((sum, value) => sum + value, 0n);
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(`Invalid ${label} identity`);
  return value;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label} timestamp`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}
