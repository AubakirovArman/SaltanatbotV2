import {
  PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION,
  PAPER_ROBOT_JOURNAL_SCHEMA_VERSION,
  type PaperMoney,
  type PaperPortfolioProjection,
  type PaperRecentFillSummary,
  type PaperRecentLedgerEventMetadata,
  type PaperRobotCurvePoint,
  type PaperRobotJournal,
  type PaperRobotRuntimeMetadata
} from "./paperPortfolioTypes";

const CURVE_POINT_LIMIT = 256;
const RECENT_FILL_LIMIT = 50;
const RECENT_EVENT_LIMIT = 100;

type JsonRecord = Record<string, unknown>;

export function parsePaperRobotJournal(value: unknown, path: string): PaperRobotJournal {
  const item = object(value, path);
  literal(item.schemaVersion, PAPER_ROBOT_JOURNAL_SCHEMA_VERSION, `${path}.schemaVersion`);
  const curveItem = object(item.curve, `${path}.curve`);
  literal(curveItem.formulaVersion, PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION, `${path}.curve.formulaVersion`);
  literal(curveItem.basis, "current-epoch-realized-cash", `${path}.curve.basis`);
  literal(curveItem.pointOrder, "oldest-first", `${path}.curve.pointOrder`);
  const points = array(curveItem.points, `${path}.curve.points`, parseCurvePoint);
  if (points.length > CURVE_POINT_LIMIT) fail(`${path}.curve.points exceeds the ${CURVE_POINT_LIMIT} point bound`);
  const cashPoints = points.filter((point) => point.basis === "cash-realized");
  const equityPoints = points.filter((point) => point.basis === "current-equity");
  if (cashPoints.length === 0) fail(`${path}.curve must include persisted cash evidence`);
  if (equityPoints.length > 1 || (equityPoints.length === 1 && points.at(-1)?.basis !== "current-equity")) {
    fail(`${path}.curve current equity must be an optional final point`);
  }
  for (let index = 1; index < cashPoints.length; index += 1) {
    if (cashPoints[index]!.sequence <= cashPoints[index - 1]!.sequence) fail(`${path}.curve cash sequences must increase`);
  }
  const sourceCashPointCount = positiveInteger(curveItem.sourceCashPointCount, `${path}.curve.sourceCashPointCount`);
  const truncated = boolean(curveItem.truncated, `${path}.curve.truncated`);
  if (truncated ? sourceCashPointCount <= cashPoints.length : sourceCashPointCount !== cashPoints.length) {
    fail(`${path}.curve truncation evidence does not match its cash point count`);
  }
  const currentEquity = equityPoints[0];
  if (currentEquity && currentEquity.afterSequence < cashPoints.at(-1)!.sequence) {
    fail(`${path}.curve current equity predates persisted cash evidence`);
  }
  return {
    schemaVersion: PAPER_ROBOT_JOURNAL_SCHEMA_VERSION,
    ownerUserId: text(item.ownerUserId, `${path}.ownerUserId`),
    portfolioId: text(item.portfolioId, `${path}.portfolioId`),
    ledgerEpoch: positiveInteger(item.ledgerEpoch, `${path}.ledgerEpoch`),
    botId: text(item.botId, `${path}.botId`),
    botRevision: positiveInteger(item.botRevision, `${path}.botRevision`),
    curve: {
      formulaVersion: PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION,
      basis: "current-epoch-realized-cash",
      pointOrder: "oldest-first",
      truncated,
      sourceCashPointCount,
      points
    },
    recentFills: parseRecentFills(item.recentFills, `${path}.recentFills`),
    recentEvents: parseRecentEvents(item.recentEvents, `${path}.recentEvents`)
  };
}

export function validatePaperRuntimeJournals(
  snapshot: PaperPortfolioProjection,
  metadata: PaperRobotRuntimeMetadata[],
  path: string
): void {
  if (metadata.length !== snapshot.robots.length) fail(`${path} must match the snapshot robot set`);
  const seen = new Set<string>();
  metadata.forEach((runtime, index) => {
    const itemPath = `${path}[${index}]`;
    if (seen.has(runtime.botId)) fail(`${itemPath}.botId is duplicated`);
    seen.add(runtime.botId);
    const robot = snapshot.robots.find((candidate) => candidate.botId === runtime.botId);
    if (!robot) fail(`${itemPath}.botId does not match the snapshot`);
    if (runtime.botRevision !== undefined && runtime.botRevision !== robot.botRevision) fail(`${itemPath}.botRevision does not match the snapshot`);
    const journal = runtime.journal;
    if (
      journal.ownerUserId !== snapshot.ownerUserId
      || journal.portfolioId !== snapshot.portfolioId
      || journal.ledgerEpoch !== snapshot.ledgerEpoch
      || journal.botId !== robot.botId
      || journal.botRevision !== robot.botRevision
    ) fail(`${itemPath}.journal identity does not match the snapshot robot`);
    const timestamps = [
      ...journal.curve.points.map((point) => point.ts),
      ...journal.recentFills.items.map((fill) => fill.ts),
      ...journal.recentEvents.items.map((event) => event.ts)
    ];
    if (timestamps.some((timestamp) => timestamp < snapshot.epochStartedAt || timestamp > snapshot.asOf)) {
      fail(`${itemPath}.journal timestamp is outside the snapshot epoch`);
    }
    validateCurveEvidence(journal, robot, itemPath);
    const newestEvent = journal.recentEvents.items[0]!;
    if (newestEvent.sequence !== robot.ledger.lastSequence) fail(`${itemPath}.journal recent events do not reach the ledger head`);
    if (journal.recentEvents.truncated ? robot.ledger.eventCount <= journal.recentEvents.items.length : robot.ledger.eventCount !== journal.recentEvents.items.length) {
      fail(`${itemPath}.journal recent event window does not match ledger evidence`);
    }
    if (journal.recentFills.items.some((fill) => fill.sequence > robot.ledger.lastSequence)) {
      fail(`${itemPath}.journal fill exceeds robot ledger evidence`);
    }
  });
}

function validateCurveEvidence(
  journal: PaperRobotJournal,
  robot: PaperPortfolioProjection["robots"][number],
  path: string
): void {
  const cashPoints = journal.curve.points.filter((point) => point.basis === "cash-realized");
  const finalCash = cashPoints.at(-1)!;
  if (finalCash.cashBalance !== robot.metrics.cashBalance || finalCash.realizedNetCashPnl !== robot.metrics.realizedNetCashPnl) {
    fail(`${path}.journal cash evidence does not match robot metrics`);
  }
  if (finalCash.sequence > robot.ledger.lastSequence || journal.curve.sourceCashPointCount > robot.ledger.eventCount) {
    fail(`${path}.journal curve exceeds robot ledger evidence`);
  }
  const equityPoint = journal.curve.points.find((point) => point.basis === "current-equity");
  if (robot.metrics.equity.status === "available") {
    if (
      !equityPoint
      || equityPoint.afterSequence !== robot.ledger.lastSequence
      || equityPoint.ts !== Math.max(robot.ledger.observedAt, robot.metrics.equity.observedAt)
      || equityPoint.equity !== robot.metrics.equity.value
      || equityPoint.evidenceObservedAt !== robot.metrics.equity.observedAt
      || equityPoint.source !== robot.metrics.equity.source
    ) fail(`${path}.journal current equity does not match available evidence`);
  } else if (equityPoint) {
    fail(`${path}.journal must omit current equity without available evidence`);
  }
}

function parseCurvePoint(value: unknown, path: string): PaperRobotCurvePoint {
  const item = object(value, path);
  const basis = oneOf(item.basis, ["cash-realized", "current-equity"] as const, `${path}.basis`);
  if (basis === "cash-realized") {
    return {
      basis,
      sequence: positiveInteger(item.sequence, `${path}.sequence`),
      ts: timestamp(item.ts, `${path}.ts`),
      cashBalance: money(item.cashBalance, `${path}.cashBalance`),
      realizedNetCashPnl: money(item.realizedNetCashPnl, `${path}.realizedNetCashPnl`)
    };
  }
  return {
    basis,
    afterSequence: positiveInteger(item.afterSequence, `${path}.afterSequence`),
    ts: timestamp(item.ts, `${path}.ts`),
    equity: money(item.equity, `${path}.equity`),
    evidenceObservedAt: timestamp(item.evidenceObservedAt, `${path}.evidenceObservedAt`),
    source: text(item.source, `${path}.source`)
  };
}

function parseRecentFills(value: unknown, path: string): PaperRobotJournal["recentFills"] {
  const item = object(value, path);
  literal(item.order, "newest-first", `${path}.order`);
  const truncated = boolean(item.truncated, `${path}.truncated`);
  const items = array(item.items, `${path}.items`, parseRecentFill);
  validateNewestWindow(items, truncated, RECENT_FILL_LIMIT, path);
  return { order: "newest-first", truncated, items };
}

function parseRecentFill(value: unknown, path: string): PaperRecentFillSummary {
  const item = object(value, path);
  return {
    fillId: text(item.fillId, `${path}.fillId`),
    sequence: positiveInteger(item.sequence, `${path}.sequence`),
    ts: timestamp(item.ts, `${path}.ts`),
    symbol: text(item.symbol, `${path}.symbol`),
    side: oneOf(item.side, ["buy", "sell"] as const, `${path}.side`),
    kind: oneOf(item.kind, ["open", "close"] as const, `${path}.kind`),
    qty: positiveFinite(item.qty, `${path}.qty`),
    price: money(item.price, `${path}.price`),
    fee: money(item.fee, `${path}.fee`),
    feeAsset: optionalText(item.feeAsset, `${path}.feeAsset`),
    realizedPnl: money(item.realizedPnl, `${path}.realizedPnl`)
  };
}

function parseRecentEvents(value: unknown, path: string): PaperRobotJournal["recentEvents"] {
  const item = object(value, path);
  literal(item.order, "newest-first", `${path}.order`);
  const truncated = boolean(item.truncated, `${path}.truncated`);
  const items = array(item.items, `${path}.items`, parseRecentEvent);
  if (items.length === 0) fail(`${path}.items must include ledger evidence`);
  validateNewestWindow(items, truncated, RECENT_EVENT_LIMIT, path);
  return { order: "newest-first", truncated, items };
}

function parseRecentEvent(value: unknown, path: string): PaperRecentLedgerEventMetadata {
  const item = object(value, path);
  return {
    eventId: text(item.eventId, `${path}.eventId`),
    sequence: positiveInteger(item.sequence, `${path}.sequence`),
    ts: timestamp(item.ts, `${path}.ts`),
    type: oneOf(item.type, [
      "account_initialized", "order_upserted", "order_cancelled", "fill", "fee", "cash", "position", "funding", "settings", "command_completed"
    ] as const, `${path}.type`)
  };
}

function validateNewestWindow(items: Array<{ sequence: number }>, truncated: boolean, limit: number, path: string): void {
  if (items.length > limit || (truncated && items.length !== limit)) fail(`${path}.items does not match its bounded window`);
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]!.sequence >= items[index - 1]!.sequence) fail(`${path}.items must be newest-first`);
  }
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

function positiveFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${path} must be positive and finite`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${path} must be a positive safe integer`);
  return value as number;
}

function timestamp(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${path} must be a non-negative safe integer`);
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function literal<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(`${path} must equal ${expected}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${path} is invalid`);
  return value as T[number];
}

function fail(message: string): never {
  throw new Error(message);
}
