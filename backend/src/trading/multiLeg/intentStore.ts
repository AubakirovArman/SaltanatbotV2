import type { DatabaseSync } from "node:sqlite";
import type { PaperMultiLegEvent, PaperMultiLegPlan, PaperMultiLegTerminalStatus } from "../../arbitrage/paperMultiLeg/types.js";
import { PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER } from "../paperPortfolioStore.js";
import {
  fail,
  identity,
  moneyMicros,
  ownerId,
  positiveInteger,
  positiveMoneyMicros,
  serializeJson,
  sha256,
  timestamp,
  transaction,
  validateMutation,
  type PaperMutationIdentity
} from "../paperPortfolioStoreSupport.js";

export type PaperMultiLegIntentStatus = "running" | "terminal";
export type PaperMultiLegSourceEngine = "n-leg-v1" | "route-families-v1";

/** One owner-scoped durable multi-leg paper intent inside the versioned trading store. */
export interface PaperMultiLegIntent {
  intentId: string;
  ownerUserId: string;
  portfolioId: string;
  portfolioEpoch: number;
  plan: PaperMultiLegPlan;
  planHash: string;
  sourceEngine: PaperMultiLegSourceEngine;
  sourceOpportunityId: string;
  sourceEvaluatedAt: number;
  status: PaperMultiLegIntentStatus;
  terminalOutcome?: PaperMultiLegTerminalStatus;
  reservedCapitalMicros: number;
  netPnlMicros?: number;
  feesMicros?: number;
  createdAt: number;
  updatedAt: number;
}

interface IntentRow {
  intentId: string;
  ownerUserId: string;
  portfolioId: string;
  portfolioEpoch: number;
  planJson: string;
  planHash: string;
  sourceEngine: PaperMultiLegSourceEngine;
  sourceOpportunityId: string;
  sourceEvaluatedAt: number;
  status: PaperMultiLegIntentStatus;
  terminalOutcome: PaperMultiLegTerminalStatus | null;
  reservedCapitalMicros: number;
  netPnlMicros: number | null;
  feesMicros: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Stable server-assigned intent identity that survives a retried submit command. */
export function paperMultiLegIntentIdFor(ownerUserId: string, idempotencyKey: string): string {
  const digest = sha256(`${ownerUserId.trim()}\0paper-multi-leg\0${idempotencyKey.trim()}`);
  return `mleg-${digest.slice(0, 32)}`;
}

/** One authoritative idempotency-key shape shared by every durable event append. */
export function paperMultiLegEventIdempotencyKey(intentId: string, sequence: number): string {
  return `mleg:${identity(intentId, "intent id", 160)}:${positiveInteger(sequence, "event sequence")}`;
}

export function getPaperMultiLegIntentFrom(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string
): PaperMultiLegIntent | undefined {
  const row = database.prepare(`
    SELECT * FROM paper_multi_leg_intents WHERE ownerUserId = ? AND intentId = ?
  `).get(ownerId(ownerUserId), identity(intentId, "intent id", 160)) as unknown as IntentRow | undefined;
  return row ? intentFromRow(row) : undefined;
}

export function listPaperMultiLegIntentsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  options: { portfolioId?: string; limit?: number } = {}
): PaperMultiLegIntent[] {
  const owner = ownerId(ownerUserId);
  const limit = positiveInteger(options.limit ?? 50, "intent list limit");
  const rows = (options.portfolioId === undefined
    ? database.prepare(`
        SELECT * FROM paper_multi_leg_intents WHERE ownerUserId = ?
        ORDER BY createdAt DESC, intentId ASC LIMIT ?
      `).all(owner, limit)
    : database.prepare(`
        SELECT * FROM paper_multi_leg_intents WHERE ownerUserId = ? AND portfolioId = ?
        ORDER BY createdAt DESC, intentId ASC LIMIT ?
      `).all(owner, identity(options.portfolioId, "portfolio id", 200), limit)) as unknown as IntentRow[];
  return rows.map(intentFromRow);
}

export function countRunningPaperMultiLegIntentsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId?: string
): number {
  const owner = ownerId(ownerUserId);
  const row = (portfolioId === undefined
    ? database.prepare(`
        SELECT COUNT(*) AS value FROM paper_multi_leg_intents WHERE ownerUserId = ? AND status = 'running'
      `).get(owner)
    : database.prepare(`
        SELECT COUNT(*) AS value FROM paper_multi_leg_intents WHERE ownerUserId = ? AND portfolioId = ? AND status = 'running'
      `).get(owner, identity(portfolioId, "portfolio id", 200))) as { value: number };
  return Number(row.value);
}

/** Capital still held by running intents; the read model and submit path subtract it from available cash. */
export function sumRunningPaperMultiLegReservedMicrosFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string
): number {
  const row = database.prepare(`
    SELECT COALESCE(SUM(reservedCapitalMicros), 0) AS value FROM paper_multi_leg_intents
    WHERE ownerUserId = ? AND portfolioId = ? AND status = 'running'
  `).get(ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200)) as { value: number };
  return moneyMicros(Number(row.value), "running multi-leg reservation total");
}

/** Startup recovery scan across owners; every returned intent is still running. */
export function listRunningPaperMultiLegIntentIdentitiesFrom(
  database: DatabaseSync,
  limit = 100
): Array<{ ownerUserId: string; intentId: string }> {
  return database.prepare(`
    SELECT ownerUserId, intentId FROM paper_multi_leg_intents
    WHERE status = 'running' ORDER BY createdAt ASC, intentId ASC LIMIT ?
  `).all(positiveInteger(limit, "recovery scan limit")) as Array<{ ownerUserId: string; intentId: string }>;
}

/** Inserts the running intent row; the reservation is the row itself and is released only by the terminal flip. */
export function createPaperMultiLegIntentIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: {
    intentId: string;
    portfolioId: string;
    portfolioEpoch: number;
    plan: PaperMultiLegPlan;
    planHash: string;
    reservedCapitalMicros: number;
    now: number;
  }
): PaperMultiLegIntent {
  const owner = ownerId(ownerUserId);
  const intentId = identity(input.intentId, "intent id", 160);
  if (!/^[0-9a-f]{64}$/.test(input.planHash)) fail("INVALID_PLAN_HASH", "Paper multi-leg plan hash must be 64 hexadecimal characters");
  const reserved = positiveMoneyMicros(input.reservedCapitalMicros, "multi-leg reserved capital");
  const now = timestamp(input.now, "intent creation time");
  return transaction(database, () => {
    if (getPaperMultiLegIntentFrom(database, owner, intentId)) fail("ALREADY_EXISTS", `Paper multi-leg intent ${intentId} already exists`);
    database.prepare(`
      INSERT INTO paper_multi_leg_intents
        (intentId, ownerUserId, portfolioId, portfolioEpoch, planJson, planHash,
         sourceEngine, sourceOpportunityId, sourceEvaluatedAt, status,
         reservedCapitalMicros, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      intentId, owner, identity(input.portfolioId, "portfolio id", 200),
      positiveInteger(input.portfolioEpoch, "portfolio epoch"),
      serializeJson(input.plan, "paper multi-leg plan"), input.planHash,
      input.plan.source.engine, input.plan.source.opportunityId,
      timestamp(input.plan.source.evaluatedAt, "source evaluation time"),
      reserved, now, now
    );
    return requireIntent(database, owner, intentId);
  });
}

/** Durable append with the canonical idempotency key; sequences must stay contiguous per intent. */
export function appendPaperMultiLegIntentEventIn(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string,
  event: PaperMultiLegEvent
): void {
  const owner = ownerId(ownerUserId);
  const id = identity(intentId, "intent id", 160);
  transaction(database, () => {
    const intent = requireIntent(database, owner, id);
    if (intent.status !== "running") fail("INTENT_NOT_RUNNING", "Paper multi-leg events may only be appended to a running intent");
    if (event.runId !== id) fail("INTENT_EVENT_MISMATCH", "Paper multi-leg event does not belong to this intent");
    const last = database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS value FROM paper_multi_leg_intent_events WHERE intentId = ?
    `).get(id) as { value: number };
    if (event.sequence !== Number(last.value) + 1) {
      fail("EVENT_SEQUENCE_CONFLICT", `Paper multi-leg event sequence ${event.sequence} is not contiguous after ${Number(last.value)}`);
    }
    database.prepare(`
      INSERT INTO paper_multi_leg_intent_events (intentId, sequence, eventJson, idempotencyKey, ts)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id, positiveInteger(event.sequence, "event sequence"),
      serializeJson(event, "paper multi-leg event"),
      paperMultiLegEventIdempotencyKey(id, event.sequence),
      timestamp(event.ts, "event time")
    );
  });
}

export function listPaperMultiLegIntentEventsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string
): PaperMultiLegEvent[] {
  const owner = ownerId(ownerUserId);
  const id = identity(intentId, "intent id", 160);
  requireIntent(database, owner, id);
  const rows = database.prepare(`
    SELECT eventJson FROM paper_multi_leg_intent_events WHERE intentId = ? ORDER BY sequence ASC
  `).all(id) as Array<{ eventJson: string }>;
  return rows.map((row) => {
    let value: unknown;
    try { value = JSON.parse(row.eventJson); } catch { fail("INVALID_JSON", "Paper multi-leg event journal is not valid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_JSON", "Paper multi-leg event journal is not an object");
    return value as PaperMultiLegEvent;
  });
}

/**
 * The only reservation release: one guarded running→terminal flip. A second
 * call can never release again because the WHERE clause no longer matches.
 */
export function finalizePaperMultiLegIntentIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: {
    intentId: string;
    terminalOutcome: PaperMultiLegTerminalStatus;
    netPnlMicros: number;
    feesMicros: number;
    now: number;
  }
): PaperMultiLegIntent {
  const owner = ownerId(ownerUserId);
  const id = identity(input.intentId, "intent id", 160);
  if (!Number.isSafeInteger(input.netPnlMicros)) fail("INVALID_MONEY", "Multi-leg net PnL micros must be a safe integer");
  moneyMicros(input.feesMicros, "multi-leg fees");
  return transaction(database, () => {
    const changed = database.prepare(`
      UPDATE paper_multi_leg_intents
      SET status = 'terminal', terminalOutcome = ?, netPnlMicros = ?, feesMicros = ?, updatedAt = ?
      WHERE ownerUserId = ? AND intentId = ? AND status = 'running'
    `).run(
      input.terminalOutcome, input.netPnlMicros, input.feesMicros,
      timestamp(input.now, "terminal stamp time"), owner, id
    ).changes;
    if (changed !== 1) fail("RESERVATION_ALREADY_RELEASED", `Paper multi-leg intent ${id} reservation was already released`);
    return requireIntent(database, owner, id);
  });
}

/**
 * Durable applied receipt for multi-leg commands without a portfolio target
 * (the owner-level kill switch). It mirrors the paper mutation receipt
 * discipline: same table, same identity conflict rules, single transaction.
 */
export function recordPaperMultiLegReceiptIn(
  database: DatabaseSync,
  ownerUserId: string,
  identityInput: PaperMutationIdentity,
  targetId: string,
  result: Record<string, unknown>
): Record<string, unknown> {
  const owner = ownerId(ownerUserId);
  const mutation = validateMutation(identityInput);
  const target = identity(targetId, "receipt target id", 200);
  return transaction(database, () => {
    const prior = database.prepare(`
      SELECT id, idempotencyKey, requestHash, action, targetId, status, result FROM paper_portfolio_mutations
      WHERE ownerUserId = ? AND (idempotencyKey = ? OR id = ?)
    `).get(owner, mutation.idempotencyKey, mutation.mutationId) as
      { id: string; idempotencyKey: string; requestHash: string; action: string; targetId: string | null; status: string; result: string | null } | undefined;
    if (prior) {
      if (
        prior.id !== mutation.mutationId || prior.idempotencyKey !== mutation.idempotencyKey
        || prior.requestHash !== mutation.requestHash || prior.action !== "executor" || prior.targetId !== target
      ) fail("IDEMPOTENCY_CONFLICT", "Mutation identity was already used for a different request");
      if (prior.status !== "applied" || prior.result === null) fail("MUTATION_IN_PROGRESS", "Mutation does not have a durable applied result");
      return JSON.parse(prior.result) as Record<string, unknown>;
    }
    const count = Number((database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE ownerUserId = ?").get(owner) as { value: number }).value);
    if (count >= PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER) fail("RECEIPT_LIMIT", `An owner may keep at most ${PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER} paper mutation receipts`);
    database.prepare(`
      INSERT INTO paper_portfolio_mutations
        (ownerUserId, id, idempotencyKey, requestHash, action, targetId, status, result, createdAt, completedAt)
      VALUES (?, ?, ?, ?, 'executor', ?, 'applied', ?, ?, ?)
    `).run(
      owner, mutation.mutationId, mutation.idempotencyKey, mutation.requestHash, target,
      serializeJson(result, "paper multi-leg receipt result"), mutation.now, mutation.now
    );
    return structuredClone(result);
  });
}

function requireIntent(database: DatabaseSync, owner: string, intentId: string): PaperMultiLegIntent {
  const intent = getPaperMultiLegIntentFrom(database, owner, intentId);
  if (!intent) fail("INTENT_NOT_FOUND", `Paper multi-leg intent ${intentId} was not found`);
  return intent;
}

function intentFromRow(row: IntentRow): PaperMultiLegIntent {
  const { planJson, terminalOutcome, netPnlMicros, feesMicros, ...rest } = row;
  let plan: unknown;
  try { plan = JSON.parse(planJson); } catch { fail("INVALID_JSON", "Paper multi-leg intent plan is not valid JSON"); }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("INVALID_JSON", "Paper multi-leg intent plan is not an object");
  return {
    ...rest,
    plan: plan as PaperMultiLegPlan,
    ...(terminalOutcome === null ? {} : { terminalOutcome }),
    ...(netPnlMicros === null ? {} : { netPnlMicros }),
    ...(feesMicros === null ? {} : { feesMicros })
  };
}
