import type { DatabaseSync } from "node:sqlite";
import type { NLegOpportunity } from "../../arbitrage/engines/nLeg/index.js";
import type { PairwiseOpportunity } from "../../arbitrage/engines/pairwise/index.js";
import { paperMultiLegPlanFromNLeg, paperMultiLegPlanFromRouteFamily } from "../../arbitrage/paperMultiLeg/builders.js";
import { paperMultiLegHash } from "../../arbitrage/paperMultiLeg/canonical.js";
import { createPaperMultiLegInitialEvent, nextPaperMultiLegEvent, replayPaperMultiLegEvents } from "../../arbitrage/paperMultiLeg/engine.js";
import { validatePaperMultiLegPlanAt } from "../../arbitrage/paperMultiLeg/schema.js";
import {
  PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN,
  PAPER_MULTI_LEG_MAX_PLAN_LIFETIME_MS,
  type PaperMultiLegPlan,
  type PaperMultiLegState
} from "../../arbitrage/paperMultiLeg/types.js";
import {
  PAPER_MULTI_LEG_KILL_SWITCH_TARGET_ID,
  type PaperPortfolioExecutorPayload
} from "../paperPortfolioCommandContract.js";
import { formatMicros } from "../paperPortfolioProjectionStore.js";
import {
  getPaperPortfolioEpochFrom,
  getPaperPortfolioFrom,
  recordPaperExecutorReceiptIn
} from "../paperPortfolioStore.js";
import { fail, ownerId, transaction, type PaperMutationIdentity } from "../paperPortfolioStoreSupport.js";
import {
  combinedMultiLegPnl,
  MULTI_LEG_ERROR_CODES,
  MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER,
  MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO,
  multiLegKillSwitchSettingsKey,
  multiLegQuoteToMicros,
  worstCaseMultiLegCapitalQuote
} from "./contract.js";
import {
  appendPaperMultiLegIntentEventIn,
  countRunningPaperMultiLegIntentsFrom,
  createPaperMultiLegIntentIn,
  finalizePaperMultiLegIntentIn,
  getPaperMultiLegIntentFrom,
  listPaperMultiLegIntentEventsFrom,
  listRunningPaperMultiLegIntentIdentitiesFrom,
  paperMultiLegIntentIdFor,
  recordPaperMultiLegReceiptIn,
  sumRunningPaperMultiLegReservedMicrosFrom,
  type PaperMultiLegIntent
} from "./intentStore.js";

export type PaperMultiLegSubmitPayload = Extract<PaperPortfolioExecutorPayload, { kind: "paper-multi-leg.submit" }>;
export type PaperMultiLegKillSwitchPayload = Extract<PaperPortfolioExecutorPayload, { kind: "paper-multi-leg.kill-switch" }>;

/** Canonical signed USDT-micros rendering; negative research PnL stays explicit. */
export function formatSignedMultiLegMicros(micros: number): string {
  return micros < 0 ? `-${formatMicros(-micros)}` : formatMicros(micros);
}

/** Absent or `enabled: false` disables the switch; anything unreadable fails closed. */
export function isPaperMultiLegKillSwitchEnabled(database: DatabaseSync, ownerUserId: string): boolean {
  const row = database.prepare("SELECT value FROM settings WHERE key = ? AND encrypted = 0")
    .get(multiLegKillSwitchSettingsKey(ownerId(ownerUserId))) as { value: string } | undefined;
  if (!row) return false;
  try {
    const parsed = JSON.parse(row.value) as { enabled?: unknown };
    return !(parsed && typeof parsed === "object" && parsed.enabled === false);
  } catch {
    return true;
  }
}

/** Owner-level kill switch write with the standard durable applied receipt. */
export function setPaperMultiLegKillSwitch(
  database: DatabaseSync,
  ownerUserId: string,
  mutation: PaperMutationIdentity,
  payload: PaperMultiLegKillSwitchPayload
): Record<string, unknown> {
  const owner = ownerId(ownerUserId);
  return transaction(database, () => {
    database.prepare(`
      INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 0)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0
    `).run(multiLegKillSwitchSettingsKey(owner), JSON.stringify({ enabled: payload.enabled, updatedAt: mutation.now }));
    return recordPaperMultiLegReceiptIn(database, owner, mutation, PAPER_MULTI_LEG_KILL_SWITCH_TARGET_ID, {
      target: PAPER_MULTI_LEG_KILL_SWITCH_TARGET_ID,
      enabled: payload.enabled
    });
  });
}

/**
 * The complete fenced submit pipeline: kill switch, fail-closed plan builders,
 * plan freshness, active-intent limits, worst-case reservation against the
 * portfolio's available cash, then the pure engine driven to terminal with
 * every transition durably journaled. A redelivered command resumes its own
 * intent instead of double-reserving, and the terminal stamp plus receipt land
 * in one transaction so the reservation is released exactly once.
 */
export function submitPaperMultiLegIntent(
  database: DatabaseSync,
  ownerUserId: string,
  mutation: PaperMutationIdentity,
  payload: PaperMultiLegSubmitPayload
): Record<string, unknown> {
  const owner = ownerId(ownerUserId);
  const intentId = paperMultiLegIntentIdFor(owner, mutation.idempotencyKey);
  const existing = getPaperMultiLegIntentFrom(database, owner, intentId);
  if (existing) return resumeSubmittedIntent(database, owner, existing, mutation, payload);
  if (isPaperMultiLegKillSwitchEnabled(database, owner)) {
    fail(MULTI_LEG_ERROR_CODES.KILL_SWITCH, "Paper multi-leg submissions are disabled by the owner kill switch");
  }
  const portfolio = getPaperPortfolioFrom(database, owner, payload.portfolioId);
  if (!portfolio) fail("NOT_FOUND", "Paper portfolio was not found");
  if (portfolio.status !== "active") fail("PORTFOLIO_ARCHIVED", "Paper multi-leg intents require an active portfolio");
  const epoch = getPaperPortfolioEpochFrom(database, owner, portfolio.id, portfolio.currentEpoch);
  if (!epoch || epoch.status !== "active") fail("EPOCH_NOT_FOUND", "Paper portfolio has no active ledger epoch");
  const plan = rejectedWrapped(() => {
    const built = buildPaperMultiLegPlan(payload, intentId, mutation.now);
    validatePaperMultiLegPlanAt(built, mutation.now);
    return built;
  });
  if (countRunningPaperMultiLegIntentsFrom(database, owner) >= MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER) {
    fail(MULTI_LEG_ERROR_CODES.LIMIT_EXCEEDED, `An owner may run at most ${MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER} concurrent multi-leg intents`);
  }
  if (countRunningPaperMultiLegIntentsFrom(database, owner, portfolio.id) >= MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO) {
    fail(MULTI_LEG_ERROR_CODES.LIMIT_EXCEEDED, `A portfolio may run at most ${MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO} concurrent multi-leg intents`);
  }
  let reservedMicros: number;
  try {
    reservedMicros = multiLegQuoteToMicros(worstCaseMultiLegCapitalQuote(plan));
  } catch (error) {
    fail(MULTI_LEG_ERROR_CODES.INSUFFICIENT_CAPITAL, `Worst-case multi-leg reservation is not representable: ${reason(error)}`);
  }
  const availableMicros = epoch.cashBalanceMicros - sumRunningPaperMultiLegReservedMicrosFrom(database, owner, portfolio.id);
  if (reservedMicros > availableMicros) {
    fail(
      MULTI_LEG_ERROR_CODES.INSUFFICIENT_CAPITAL,
      `Worst-case multi-leg capital ${formatMicros(reservedMicros)} USDT exceeds the portfolio's available ${formatMicros(Math.max(0, availableMicros))} USDT`
    );
  }
  const planHash = paperMultiLegHash(plan);
  transaction(database, () => {
    createPaperMultiLegIntentIn(database, owner, {
      intentId,
      portfolioId: portfolio.id,
      portfolioEpoch: portfolio.currentEpoch,
      plan,
      planHash,
      reservedCapitalMicros: reservedMicros,
      now: mutation.now
    });
    appendPaperMultiLegIntentEventIn(database, owner, intentId, createPaperMultiLegInitialEvent(plan, planHash, mutation.now));
  });
  const state = drivePaperMultiLegIntentToTerminal(database, owner, intentId, mutation.now);
  return transaction(database, () => {
    const finalized = finalizeFromState(database, owner, intentId, state, mutation.now);
    return recordPaperExecutorReceiptIn(database, owner, {
      ...mutation,
      portfolioId: finalized.portfolioId,
      ledgerEpoch: finalized.portfolioEpoch,
      result: submitResult(portfolio.revision, finalized, state)
    });
  });
}

/**
 * Continues a durable intent through the pure engine, never re-appending an
 * existing sequence: the journal is replayed first and every produced event is
 * validated by a full deterministic replay before the next transition.
 */
export function continuePaperMultiLegIntent(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string,
  at: number,
  stepBudget = PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN
): PaperMultiLegState {
  const owner = ownerId(ownerUserId);
  const events = [...listPaperMultiLegIntentEventsFrom(database, owner, intentId)];
  if (events.length === 0) fail("INTENT_EVENTS_MISSING", `Paper multi-leg intent ${intentId} has no durable journal`);
  let state = replayPaperMultiLegEvents(events, intentId);
  for (let step = 0; step < stepBudget && !state.terminal; step += 1) {
    const next = nextPaperMultiLegEvent(state, Math.max(at, state.updatedAt));
    if (!next) break;
    appendPaperMultiLegIntentEventIn(database, owner, intentId, next);
    events.push(next);
    state = replayPaperMultiLegEvents(events, intentId);
  }
  return state;
}

/**
 * Startup recovery on the same path that resumes persisted robots: every
 * running intent is replayed and continued to the identical terminal state.
 * The guarded terminal flip keeps the reservation release single-shot.
 */
export function recoverIncompletePaperMultiLegIntents(database: DatabaseSync, now = Date.now()): number {
  let recovered = 0;
  while (true) {
    const running = listRunningPaperMultiLegIntentIdentitiesFrom(database, 100);
    if (running.length === 0) return recovered;
    for (const intent of running) {
      const state = drivePaperMultiLegIntentToTerminal(database, intent.ownerUserId, intent.intentId, now);
      transaction(database, () => finalizeFromState(database, intent.ownerUserId, intent.intentId, state, now));
      recovered += 1;
    }
  }
}

function resumeSubmittedIntent(
  database: DatabaseSync,
  owner: string,
  existing: PaperMultiLegIntent,
  mutation: PaperMutationIdentity,
  payload: PaperMultiLegSubmitPayload
): Record<string, unknown> {
  if (existing.portfolioId !== payload.portfolioId) {
    fail("IDEMPOTENCY_CONFLICT", "Paper multi-leg idempotency key was already used for another portfolio");
  }
  const state = drivePaperMultiLegIntentToTerminal(database, owner, existing.intentId, mutation.now);
  return transaction(database, () => {
    const intent = existing.status === "running"
      ? finalizeFromState(database, owner, existing.intentId, state, mutation.now)
      : existing;
    const portfolio = getPaperPortfolioFrom(database, owner, intent.portfolioId);
    if (!portfolio) fail("NOT_FOUND", "Paper portfolio was not found");
    return recordPaperExecutorReceiptIn(database, owner, {
      ...mutation,
      portfolioId: intent.portfolioId,
      ledgerEpoch: intent.portfolioEpoch,
      result: submitResult(portfolio.revision, intent, state)
    });
  });
}

function drivePaperMultiLegIntentToTerminal(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string,
  at: number
): PaperMultiLegState {
  const state = continuePaperMultiLegIntent(database, ownerUserId, intentId, at);
  if (!state.terminal) throw new Error(`Paper multi-leg intent ${intentId} exceeded its deterministic transition bound`);
  return state;
}

/** Combined both-legs-all-costs PnL stamped with the exactly-once terminal flip. */
function finalizeFromState(
  database: DatabaseSync,
  ownerUserId: string,
  intentId: string,
  state: PaperMultiLegState,
  now: number
): PaperMultiLegIntent {
  const terminal = state.terminal;
  if (!terminal) throw new Error(`Paper multi-leg intent ${intentId} cannot be finalized before its terminal event`);
  const combined = combinedMultiLegPnl(state);
  return finalizePaperMultiLegIntentIn(database, ownerUserId, {
    intentId,
    terminalOutcome: terminal.status,
    netPnlMicros: multiLegQuoteToMicros(combined.netPnlQuote),
    feesMicros: multiLegQuoteToMicros(combined.feesQuote),
    now
  });
}

function submitResult(portfolioRevision: number, intent: PaperMultiLegIntent, state: PaperMultiLegState): Record<string, unknown> {
  return {
    portfolioId: intent.portfolioId,
    portfolioRevision,
    ledgerEpoch: intent.portfolioEpoch,
    intentId: intent.intentId,
    status: intent.status,
    outcome: intent.terminalOutcome ?? null,
    reservedCapital: formatMicros(intent.reservedCapitalMicros),
    netPnl: intent.netPnlMicros === undefined ? null : formatSignedMultiLegMicros(intent.netPnlMicros),
    fees: intent.feesMicros === undefined ? null : formatMicros(intent.feesMicros),
    residualExposure: (state.terminal?.unresolvedExposure ?? []).map((line) => ({
      legId: line.legId,
      instrumentId: line.instrumentId,
      quantityUnit: line.quantityUnit,
      quantity: line.quantity
    }))
  };
}

/** The builders re-validate every opportunity field at apply time and fail closed. */
function buildPaperMultiLegPlan(payload: PaperMultiLegSubmitPayload, runId: string, now: number): PaperMultiLegPlan {
  const base = {
    runId,
    createdAt: now,
    expiresAt: now + PAPER_MULTI_LEG_MAX_PLAN_LIFETIME_MS,
    ...(payload.fillScenario ? { scenarios: payload.fillScenario } : {})
  };
  return payload.source.type === "n-leg"
    ? paperMultiLegPlanFromNLeg(payload.source.opportunity as unknown as NLegOpportunity, base)
    : paperMultiLegPlanFromRouteFamily(payload.source.opportunity as unknown as PairwiseOpportunity, payload.source.family, base);
}

function rejectedWrapped(build: () => PaperMultiLegPlan): PaperMultiLegPlan {
  try {
    return build();
  } catch (error) {
    fail(MULTI_LEG_ERROR_CODES.PLAN_REJECTED, `Paper multi-leg plan was rejected: ${reason(error)}`);
  }
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
