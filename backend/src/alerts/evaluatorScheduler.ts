import type { PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import type { Pool } from "pg";
import { timeframeMs } from "../market/timeframes.js";
import { evaluatePriceThresholdAlert } from "./priceEvaluator.js";
import { PublicClosedCandleReader, type PublicClosedCandleReadOptions, type PublicClosedCandleReadResult } from "./publicClosedCandleReader.js";
import { AlertRepository } from "./repository.js";
import type { ClaimedPriceAlertRule, ClaimPriceAlertInput, CompletePriceEvaluationInput, CompletePriceEvaluationResult, DeferPriceEvaluationInput, FailPriceEvaluationInput, RecoverExpiredLeasesResult } from "./repositoryTypes.js";

export const MAX_PRICE_ALERT_SWEEP = 500;
export const MAX_PUBLIC_ALERT_SCOPE_CONCURRENCY = 4;
export const MAX_PUBLIC_ALERT_READS_PER_SWEEP = 16;
export const MAX_PUBLIC_ALERT_READS_PER_PROVIDER_PER_SWEEP = 8;
export const INITIAL_PRICE_ALERT_CANDLE_LIMIT = 1;
export const CONTINUATION_PRICE_ALERT_CANDLE_LIMIT = 1;

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SWEEP_LIMIT = 100;
const DEFAULT_SCOPE_CONCURRENCY = 4;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_CANDLE_LIMIT = INITIAL_PRICE_ALERT_CANDLE_LIMIT;
const PROVIDER_LAG_RETRY_SECONDS = 30;
const MAX_HEALTHY_DEFER_SECONDS = 86_400;

export interface PriceAlertSchedulerRepository {
  recoverExpiredLeases(): Promise<RecoverExpiredLeasesResult>;
  claimDuePriceAlert(input: ClaimPriceAlertInput): Promise<ClaimedPriceAlertRule | undefined>;
  completePriceEvaluation(input: CompletePriceEvaluationInput): Promise<CompletePriceEvaluationResult>;
  deferPriceEvaluation(input: DeferPriceEvaluationInput): Promise<boolean>;
  failPriceEvaluation(input: FailPriceEvaluationInput): Promise<boolean>;
}

export interface PriceAlertPublicReader {
  read(definition: PriceThresholdAlertDefinitionV1, options?: PublicClosedCandleReadOptions): Promise<PublicClosedCandleReadResult>;
}

export interface PriceAlertSchedulerErrorContext {
  phase: "startup-recovery" | "sweep-recovery" | "claim" | "read" | "evaluate" | "complete" | "defer" | "backoff";
  ruleId?: string;
}

export interface PriceAlertEvaluatorSchedulerOptions {
  workerId: string;
  intervalMs?: number;
  sweepLimit?: number;
  publicScopeConcurrency?: number;
  leaseMs?: number;
  /** Initial-arm recent window only; cursor continuations always request one bar. */
  candleLimit?: number;
  publicReadLimit?: number;
  publicProviderReadLimit?: number;
  onError?: (error: unknown, context: PriceAlertSchedulerErrorContext) => void;
  onSweep?: (result: PriceAlertSweepResult) => void;
}

export interface PriceAlertSweepResult {
  claimAttempts: number;
  claimed: number;
  applied: number;
  duplicates: number;
  triggered: number;
  deferred: number;
  backedOff: number;
  lostClaims: number;
  publicReads: number;
  coalescedReads: number;
  admissionDeferred: number;
}

export interface PriceAlertEvaluatorScheduler {
  start(): Promise<void>;
  trigger(): Promise<PriceAlertSweepResult>;
  quiesce(): void;
  drain(): Promise<void>;
}

/**
 * Bounded PostgreSQL-backed lane for public price alerts. Each sweep is
 * single-flight, claims at most 500 rules, performs at most four public reads
 * concurrently, and admits at most sixteen unique scope/cursor reads (eight per
 * provider) per sweep. Equal scope/cursor reads are coalesced. Missing or invalid
 * evidence is durably backed off; a healthy no-new-bar result is deferred
 * without an error. This lane never executes trades or sends notifications.
 */
export function createPriceAlertEvaluatorScheduler(repository: PriceAlertSchedulerRepository, reader: PriceAlertPublicReader, options: PriceAlertEvaluatorSchedulerOptions): PriceAlertEvaluatorScheduler {
  const intervalMs = boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 250, 60_000);
  const sweepLimit = boundedInteger(options.sweepLimit, DEFAULT_SWEEP_LIMIT, 1, MAX_PRICE_ALERT_SWEEP);
  const concurrency = boundedInteger(options.publicScopeConcurrency, DEFAULT_SCOPE_CONCURRENCY, 1, MAX_PUBLIC_ALERT_SCOPE_CONCURRENCY);
  const leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 1_000, 300_000);
  const candleLimit = boundedInteger(options.candleLimit, DEFAULT_CANDLE_LIMIT, 1, INITIAL_PRICE_ALERT_CANDLE_LIMIT);
  const publicReadLimit = boundedInteger(options.publicReadLimit, MAX_PUBLIC_ALERT_READS_PER_SWEEP, 1, MAX_PUBLIC_ALERT_READS_PER_SWEEP);
  const publicProviderReadLimit = boundedInteger(options.publicProviderReadLimit, MAX_PUBLIC_ALERT_READS_PER_PROVIDER_PER_SWEEP, 1, Math.min(MAX_PUBLIC_ALERT_READS_PER_PROVIDER_PER_SWEEP, publicReadLimit));
  const onError = options.onError ?? (() => undefined);
  const onSweep = options.onSweep ?? (() => undefined);
  const reportError = (error: unknown, context: PriceAlertSchedulerErrorContext) => {
    try {
      onError(error, context);
    } catch {
      // Error reporting must never break lease cleanup or the scheduler loop.
    }
  };
  const reportSweep = (result: PriceAlertSweepResult) => {
    try {
      onSweep(result);
    } catch {
      // Metrics callbacks are observational and cannot break the evaluator.
    }
  };
  let accepting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialization: Promise<void> | undefined;
  let inFlight: Promise<PriceAlertSweepResult> | undefined;

  const trigger = (): Promise<PriceAlertSweepResult> => {
    if (!accepting) return Promise.resolve(emptySweep());
    if (inFlight) return inFlight;
    const current = runSweep().then((result) => {
      reportSweep(result);
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

  const runSweep = async (): Promise<PriceAlertSweepResult> => {
    const result = emptySweep();
    const admission = createReadAdmission(reader, candleLimit, publicReadLimit, publicProviderReadLimit, result);
    try {
      await repository.recoverExpiredLeases();
    } catch (error) {
      reportError(error, { phase: "sweep-recovery" });
      return result;
    }
    let remainingClaims = sweepLimit;
    const lane = async () => {
      while (accepting && !admission.exhausted && remainingClaims > 0) {
        remainingClaims -= 1;
        result.claimAttempts += 1;
        let claim: ClaimedPriceAlertRule | undefined;
        try {
          claim = await repository.claimDuePriceAlert({ workerId: options.workerId, leaseMs });
        } catch (error) {
          reportError(error, { phase: "claim" });
          return;
        }
        if (!claim) return;
        result.claimed += 1;
        await processClaim(repository, admission, claim, result, reportError);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sweepLimit) }, () => lane()));
    return result;
  };

  return {
    start() {
      if (accepting) return initialization ?? Promise.resolve();
      accepting = true;
      const current = (async () => {
        try {
          await repository.recoverExpiredLeases();
        } catch (error) {
          accepting = false;
          reportError(error, { phase: "startup-recovery" });
          throw error;
        }
        if (!accepting) return;
        timer = setInterval(() => void trigger(), intervalMs);
        timer.unref?.();
        void trigger();
      })();
      initialization = current;
      void current.then(
        () => {
          if (initialization === current) initialization = undefined;
        },
        () => {
          if (initialization === current) initialization = undefined;
        }
      );
      return current;
    },
    trigger,
    quiesce() {
      accepting = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async drain() {
      await initialization;
      while (inFlight) await inFlight;
    }
  };
}

export function createDefaultPriceAlertEvaluatorScheduler(pool: Pool, options: PriceAlertEvaluatorSchedulerOptions): PriceAlertEvaluatorScheduler {
  return createPriceAlertEvaluatorScheduler(new AlertRepository(pool), new PublicClosedCandleReader(), options);
}

interface SweepReadAdmission {
  exhausted: boolean;
  read(claim: ClaimedPriceAlertRule): Promise<PublicClosedCandleReadResult> | undefined;
}

function createReadAdmission(reader: PriceAlertPublicReader, initialCandleLimit: number, publicReadLimit: number, publicProviderReadLimit: number, sweep: PriceAlertSweepResult): SweepReadAdmission {
  const cache = new Map<string, Promise<PublicClosedCandleReadResult>>();
  const providerReads: Record<"binance" | "bybit", number> = { binance: 0, bybit: 0 };
  const admission: SweepReadAdmission = {
    exhausted: false,
    read(claim) {
      const cursor = claim.state.lastEvaluatedBarTime;
      const initialBarTime = cursor === undefined ? armedBarOpenTime(claim.definition.timeframe, claim.state.armedAt) : undefined;
      const key = JSON.stringify([claim.stateKey, cursor === undefined ? "armed-bar" : "cursor", cursor === undefined ? initialBarTime : cursor]);
      const existing = cache.get(key);
      if (existing) {
        sweep.coalescedReads += 1;
        return existing;
      }
      const provider = claim.definition.exchange;
      if (sweep.publicReads >= publicReadLimit) {
        admission.exhausted = true;
        return undefined;
      }
      if (providerReads[provider] >= publicProviderReadLimit) return undefined;
      sweep.publicReads += 1;
      providerReads[provider] += 1;
      const options: PublicClosedCandleReadOptions = {
        limit: cursor === undefined ? initialCandleLimit : CONTINUATION_PRICE_ALERT_CANDLE_LIMIT,
        ...(cursor === undefined ? { startAtBarTime: initialBarTime } : { afterBarTime: cursor })
      };
      const pending = Promise.resolve().then(() => reader.read(claim.definition, options));
      cache.set(key, pending);
      return pending;
    }
  };
  return admission;
}

function armedBarOpenTime(timeframe: PriceThresholdAlertDefinitionV1["timeframe"], armedAt: number): number {
  const interval = timeframeMs[timeframe];
  if (timeframe !== "1w") return Math.floor(armedAt / interval) * interval;
  const mondayUtcAnchor = 4 * 86_400_000;
  return Math.max(0, mondayUtcAnchor + Math.floor((armedAt - mondayUtcAnchor) / interval) * interval);
}

async function processClaim(repository: PriceAlertSchedulerRepository, admission: SweepReadAdmission, claim: ClaimedPriceAlertRule, sweep: PriceAlertSweepResult, onError: (error: unknown, context: PriceAlertSchedulerErrorContext) => void): Promise<void> {
  let read: PublicClosedCandleReadResult;
  try {
    const pending = admission.read(claim);
    if (!pending) {
      sweep.admissionDeferred += 1;
      await defer(repository, claim, sweep, onError, 1);
      return;
    }
    read = await pending;
  } catch (error) {
    onError(error, { phase: "read", ruleId: claim.id });
    await backoff(repository, claim, "public_reader_failed", sweep, onError);
    return;
  }
  if (read.status === "unavailable") {
    if (read.reason === "no-new-closed-candle") {
      await defer(repository, claim, sweep, onError, nextClosedCandleRetrySeconds(claim, read.observedAt));
      return;
    }
    await backoff(repository, claim, errorCode("public", read.reason), sweep, onError);
    return;
  }
  if (read.scopeKey !== claim.stateKey) {
    await backoff(repository, claim, "public_scope_mismatch", sweep, onError);
    return;
  }

  let evaluation: ReturnType<typeof evaluatePriceThresholdAlert>;
  try {
    evaluation = evaluatePriceThresholdAlert({
      ruleId: claim.id,
      ruleRevision: claim.currentRevision,
      definition: claim.definition,
      state: claim.state,
      candles: read.candles,
      now: read.observedAt
    });
  } catch (error) {
    onError(error, { phase: "evaluate", ruleId: claim.id });
    await backoff(repository, claim, "evaluation_failed", sweep, onError);
    return;
  }
  if (evaluation.status !== "evaluated") {
    if (evaluation.status === "idle" && evaluation.reason === "no-new-closed-candle") {
      await defer(repository, claim, sweep, onError, nextClosedCandleRetrySeconds(claim, read.observedAt));
      return;
    }
    await backoff(repository, claim, errorCode(evaluation.status, evaluation.reason), sweep, onError);
    return;
  }

  try {
    const completion = await repository.completePriceEvaluation({
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
      ...(evaluation.transition ? { transition: evaluation.transition } : {})
    });
    if (completion.outcome === "duplicate") sweep.duplicates += 1;
    else {
      sweep.applied += 1;
      if (evaluation.triggered) sweep.triggered += 1;
    }
  } catch (error) {
    onError(error, { phase: "complete", ruleId: claim.id });
    await backoff(repository, claim, "completion_failed", sweep, onError);
  }
}

function nextClosedCandleRetrySeconds(claim: ClaimedPriceAlertRule, observedAt: number): number {
  const interval = timeframeMs[claim.definition.timeframe];
  const cursor = claim.state.lastEvaluatedBarTime;
  const expectedClose = cursor === undefined ? armedBarOpenTime(claim.definition.timeframe, claim.state.armedAt) + interval : cursor + 2 * interval;
  if (!Number.isSafeInteger(expectedClose) || !Number.isSafeInteger(observedAt) || expectedClose <= observedAt) return PROVIDER_LAG_RETRY_SECONDS;
  return Math.min(MAX_HEALTHY_DEFER_SECONDS, Math.max(1, Math.ceil((expectedClose - observedAt) / 1_000)));
}

async function defer(repository: PriceAlertSchedulerRepository, claim: ClaimedPriceAlertRule, sweep: PriceAlertSweepResult, onError: (error: unknown, context: PriceAlertSchedulerErrorContext) => void, retryAfterSeconds?: number): Promise<void> {
  try {
    const persisted = await repository.deferPriceEvaluation(leaseFence(claim, retryAfterSeconds));
    if (persisted) sweep.deferred += 1;
    else sweep.lostClaims += 1;
  } catch (error) {
    sweep.lostClaims += 1;
    onError(error, { phase: "defer", ruleId: claim.id });
  }
}

async function backoff(repository: PriceAlertSchedulerRepository, claim: ClaimedPriceAlertRule, code: string, sweep: PriceAlertSweepResult, onError: (error: unknown, context: PriceAlertSchedulerErrorContext) => void): Promise<void> {
  try {
    const persisted = await repository.failPriceEvaluation({
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
    onError(error, { phase: "backoff", ruleId: claim.id });
  }
}

function errorCode(prefix: string, reason: string): string {
  return `${prefix}_${reason}`.replaceAll("-", "_").slice(0, 96);
}

function emptySweep(): PriceAlertSweepResult {
  return {
    claimAttempts: 0,
    claimed: 0,
    applied: 0,
    duplicates: 0,
    triggered: 0,
    deferred: 0,
    backedOff: 0,
    lostClaims: 0,
    publicReads: 0,
    coalescedReads: 0,
    admissionDeferred: 0
  };
}

function leaseFence(claim: ClaimedPriceAlertRule, retryAfterSeconds?: number): DeferPriceEvaluationInput {
  return {
    ownerUserId: claim.ownerUserId,
    ruleId: claim.id,
    expectedRevision: claim.currentRevision,
    authorizationRevision: claim.authorizationRevision,
    workerId: claim.workerId,
    leaseToken: claim.leaseToken,
    leaseGeneration: claim.leaseGeneration,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}
