import type { Pool } from "pg";
import { runScreenerEngine, type ScreenerEngineRunV1 } from "../screener/engine.js";
import { loadScreenerMarketData, ScreenerMarketDataError, type ScreenerMarketDataDependencies, type ScreenerMarketDataSnapshotV1 } from "../screener/marketData.js";
import { AlertRepository } from "./repository.js";
import { evaluateScreenerAlert, screenerDefinitionHash } from "./screenerAlertEvaluator.js";
import {
  SCREENER_ALERT_LEASE_MS,
  type ClaimedScreenerAlertRule,
  type ClaimScreenerAlertInput,
  type CompleteScreenerEvaluationInput,
  type CompleteScreenerEvaluationResult,
  type DeferScreenerEvaluationInput,
  type FailScreenerEvaluationInput
} from "./repositoryTypes.js";

/** One full evaluation (market data + engine + completion) must fit this budget. */
export const SCREENER_ALERT_EVALUATION_BUDGET_MS = 90_000;
/** Admission: the low-frequency lane performs at most one evaluation per sweep. */
export const SCREENER_ALERT_EVALUATIONS_PER_SWEEP = 1;

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export interface ScreenerAlertRunnerRepository {
  claimDueScreenerAlert(input: ClaimScreenerAlertInput): Promise<ClaimedScreenerAlertRule | undefined>;
  completeScreenerEvaluation(input: CompleteScreenerEvaluationInput): Promise<CompleteScreenerEvaluationResult>;
  deferScreenerEvaluation(input: DeferScreenerEvaluationInput): Promise<boolean>;
  failScreenerEvaluation(input: FailScreenerEvaluationInput): Promise<boolean>;
}

export interface ScreenerAlertRunnerErrorContext {
  phase: "claim" | "market-data" | "evaluate" | "complete" | "defer" | "backoff";
  ruleId?: string;
}

export interface ScreenerAlertRunnerOptions {
  workerId: string;
  leaseMs?: number;
  evaluationBudgetMs?: number;
  /** Injection seam for tests; defaults to the live R5.2.1 market-data lane. */
  marketData?: (definition: Parameters<typeof loadScreenerMarketData>[0], dependencies?: ScreenerMarketDataDependencies) => Promise<ScreenerMarketDataSnapshotV1>;
  marketDataDependencies?: ScreenerMarketDataDependencies;
  now?: () => number;
  onError?: (error: unknown, context: ScreenerAlertRunnerErrorContext) => void;
}

export interface ScreenerAlertSweepResult {
  claimAttempts: number;
  claimed: number;
  applied: number;
  duplicates: number;
  triggered: number;
  initialized: number;
  deferred: number;
  availabilityFloorDeferred: number;
  cooldownDeferred: number;
  backedOff: number;
  lostClaims: number;
}

export interface ScreenerAlertLaneOptions extends ScreenerAlertRunnerOptions {
  intervalMs?: number;
  onSweep?: (result: ScreenerAlertSweepResult) => void;
}

export interface ScreenerAlertEvaluatorLane {
  start(): Promise<void>;
  trigger(): Promise<ScreenerAlertSweepResult>;
  quiesce(): void;
  drain(): Promise<void>;
}

/**
 * One bounded screener-alert evaluation: claim at most one due screener rule,
 * load the full R5.2.1 market-data snapshot under an AbortSignal and a 90s
 * budget, run the engine, apply the pure match-set transition evaluator and
 * finish through the durable completion/defer/backoff lanes. Never trades and
 * never sends anything beyond the transactional in-app notification row.
 */
export async function runScreenerAlertSweep(repository: ScreenerAlertRunnerRepository, options: ScreenerAlertRunnerOptions, signal?: AbortSignal): Promise<ScreenerAlertSweepResult> {
  const result = emptySweep();
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => undefined);
  const leaseMs = boundedInteger(options.leaseMs, SCREENER_ALERT_LEASE_MS, 1_000, SCREENER_ALERT_LEASE_MS);
  const budgetMs = boundedInteger(options.evaluationBudgetMs, SCREENER_ALERT_EVALUATION_BUDGET_MS, 1_000, SCREENER_ALERT_EVALUATION_BUDGET_MS);
  if (signal?.aborted) return result;

  result.claimAttempts += 1;
  let claim: ClaimedScreenerAlertRule | undefined;
  try {
    claim = await repository.claimDueScreenerAlert({ workerId: options.workerId, leaseMs });
  } catch (error) {
    report(onError, error, { phase: "claim" });
    return result;
  }
  if (!claim) return result;
  result.claimed += 1;

  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  signal?.addEventListener("abort", abortUpstream, { once: true });
  const budgetTimer = setTimeout(abortUpstream, budgetMs);
  budgetTimer.unref?.();
  try {
    let run: ScreenerEngineRunV1;
    try {
      const load = options.marketData ?? loadScreenerMarketData;
      const snapshot = await load(claim.definition.screen, {
        ...options.marketDataDependencies,
        signal: controller.signal,
        runBudgetMs: budgetMs
      });
      run = runScreenerEngine({
        definition: claim.definition.screen,
        definitionHash: screenerDefinitionHash(claim.definition.screen),
        universe: snapshot.universe,
        candlesBySymbol: snapshot.candlesBySymbol,
        unavailableReasonBySymbol: snapshot.unavailableReasonBySymbol,
        now: now()
      });
    } catch (error) {
      report(onError, error, { phase: "market-data", ruleId: claim.id });
      await backoff(repository, claim, error instanceof ScreenerMarketDataError ? errorCode("screener", error.code) : "screener_market_data_unavailable", result, onError);
      return result;
    }

    let evaluation: ReturnType<typeof evaluateScreenerAlert>;
    try {
      evaluation = evaluateScreenerAlert({
        ruleId: claim.id,
        ruleRevision: claim.currentRevision,
        definition: claim.definition,
        definitionHash: claim.definitionHash,
        state: claim.state,
        ...(claim.cooldownUntil === undefined ? {} : { cooldownUntil: claim.cooldownUntil }),
        run,
        now: now()
      });
    } catch (error) {
      report(onError, error, { phase: "evaluate", ruleId: claim.id });
      await backoff(repository, claim, "screener_evaluation_failed", result, onError);
      return result;
    }
    if (evaluation.status !== "unavailable" && evaluation.stateKey !== claim.stateKey) {
      await backoff(repository, claim, "screener_scope_mismatch", result, onError);
      return result;
    }

    if (evaluation.status === "idle") {
      await defer(repository, claim, result, onError);
      return result;
    }
    if (evaluation.status === "deferred") {
      if (evaluation.reason === "screener-availability-floor") result.availabilityFloorDeferred += 1;
      else result.cooldownDeferred += 1;
      await defer(repository, claim, result, onError, evaluation.retryAfterSeconds);
      return result;
    }
    if (evaluation.status === "unavailable") {
      await backoff(repository, claim, errorCode("screener", evaluation.reason), result, onError);
      return result;
    }

    try {
      const completion = await repository.completeScreenerEvaluation({
        ownerUserId: claim.ownerUserId,
        ruleId: claim.id,
        expectedRevision: claim.currentRevision,
        authorizationRevision: claim.authorizationRevision,
        workerId: claim.workerId,
        leaseToken: claim.leaseToken,
        leaseGeneration: claim.leaseGeneration,
        expectedStateRevision: claim.stateRevision,
        observation: evaluation.observation,
        nextState: evaluation.nextState,
        ...(evaluation.status === "triggered" ? { transition: evaluation.transition } : {})
      });
      if (completion.outcome === "duplicate") result.duplicates += 1;
      else {
        result.applied += 1;
        if (evaluation.status === "triggered") result.triggered += 1;
        else result.initialized += 1;
      }
    } catch (error) {
      report(onError, error, { phase: "complete", ruleId: claim.id });
      await backoff(repository, claim, "screener_completion_failed", result, onError);
    }
    return result;
  } finally {
    clearTimeout(budgetTimer);
    signal?.removeEventListener("abort", abortUpstream);
  }
}

/**
 * Low-frequency single-flight lane wrapper hosted by the research worker.
 * Lease recovery is intentionally left to the co-hosted price lane, which
 * already recovers expired leases for every rule kind each sweep.
 */
export function createScreenerAlertLane(repository: ScreenerAlertRunnerRepository, options: ScreenerAlertLaneOptions): ScreenerAlertEvaluatorLane {
  const intervalMs = boundedInteger(options.intervalMs, DEFAULT_SWEEP_INTERVAL_MS, 1_000, 300_000);
  const onSweep = options.onSweep ?? (() => undefined);
  let accepting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<ScreenerAlertSweepResult> | undefined;
  let quiesceController = new AbortController();

  const trigger = (): Promise<ScreenerAlertSweepResult> => {
    if (!accepting) return Promise.resolve(emptySweep());
    if (inFlight) return inFlight;
    const current = runScreenerAlertSweep(repository, options, quiesceController.signal).then((result) => {
      try {
        onSweep(result);
      } catch {
        // Metrics callbacks are observational and cannot break the evaluator.
      }
      return result;
    });
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = undefined;
      },
      () => {
        if (inFlight === current) inFlight = undefined;
      }
    );
    return current;
  };

  return {
    start() {
      if (accepting) return Promise.resolve();
      accepting = true;
      quiesceController = new AbortController();
      timer = setInterval(() => void trigger(), intervalMs);
      timer.unref?.();
      void trigger();
      return Promise.resolve();
    },
    trigger,
    quiesce() {
      accepting = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      quiesceController.abort();
    },
    async drain() {
      while (inFlight) await inFlight;
    }
  };
}

export function createDefaultScreenerAlertLane(pool: Pool, options: ScreenerAlertLaneOptions): ScreenerAlertEvaluatorLane {
  return createScreenerAlertLane(new AlertRepository(pool), options);
}

async function defer(repository: ScreenerAlertRunnerRepository, claim: ClaimedScreenerAlertRule, sweep: ScreenerAlertSweepResult, onError: (error: unknown, context: ScreenerAlertRunnerErrorContext) => void, retryAfterSeconds?: number): Promise<void> {
  try {
    const persisted = await repository.deferScreenerEvaluation({
      ownerUserId: claim.ownerUserId,
      ruleId: claim.id,
      expectedRevision: claim.currentRevision,
      authorizationRevision: claim.authorizationRevision,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    });
    if (persisted) sweep.deferred += 1;
    else sweep.lostClaims += 1;
  } catch (error) {
    sweep.lostClaims += 1;
    report(onError, error, { phase: "defer", ruleId: claim.id });
  }
}

async function backoff(repository: ScreenerAlertRunnerRepository, claim: ClaimedScreenerAlertRule, code: string, sweep: ScreenerAlertSweepResult, onError: (error: unknown, context: ScreenerAlertRunnerErrorContext) => void): Promise<void> {
  try {
    const persisted = await repository.failScreenerEvaluation({
      ownerUserId: claim.ownerUserId,
      ruleId: claim.id,
      expectedRevision: claim.currentRevision,
      authorizationRevision: claim.authorizationRevision,
      workerId: claim.workerId,
      leaseToken: claim.leaseToken,
      leaseGeneration: claim.leaseGeneration,
      stateKey: claim.stateKey,
      errorCode: code
    });
    if (persisted) sweep.backedOff += 1;
    else sweep.lostClaims += 1;
  } catch (error) {
    sweep.lostClaims += 1;
    report(onError, error, { phase: "backoff", ruleId: claim.id });
  }
}

function report(onError: (error: unknown, context: ScreenerAlertRunnerErrorContext) => void, error: unknown, context: ScreenerAlertRunnerErrorContext): void {
  try {
    onError(error, context);
  } catch {
    // Error reporting must never break lease cleanup or the lane loop.
  }
}

function errorCode(prefix: string, reason: string): string {
  const merged = reason.startsWith(`${prefix}_`) || reason.startsWith(`${prefix}-`) ? reason : `${prefix}_${reason}`;
  return merged.replaceAll("-", "_").slice(0, 96);
}

function emptySweep(): ScreenerAlertSweepResult {
  return {
    claimAttempts: 0,
    claimed: 0,
    applied: 0,
    duplicates: 0,
    triggered: 0,
    initialized: 0,
    deferred: 0,
    availabilityFloorDeferred: 0,
    cooldownDeferred: 0,
    backedOff: 0,
    lostClaims: 0
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}
