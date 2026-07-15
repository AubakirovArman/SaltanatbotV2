import { randomUUID } from "node:crypto";
import { z } from "zod";
import { notifyChecked, type NotifyPayload } from "../trading/notifications.js";
import { getSetting, setSetting } from "../trading/store.js";
import { projectedShortFundingBps } from "./funding.js";
import { refreshOpportunityQuality, type ArbitrageClockCalibration } from "./service.js";
import type { ArbitrageStreamHub } from "./stream.js";
import type { ArbitrageOpportunity, ArbitrageScanResponse } from "./types.js";

const LEGACY_STORE_KEY = "arbitrage:alert-rules:v1";
const STATE_STORE_KEY = "arbitrage:alert-state:v2";
const MAX_RULES = 50;
const MAX_ACTIVE_DELIVERIES = 1_000;
const MAX_TERMINAL_DELIVERIES = 200;
const MAX_DRAIN_BATCH = 50;

export const arbitrageAlertInputSchema = z.object({
  id: z.string().uuid().optional(),
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,20}USDT$/)
    .optional(),
  spotExchange: z.enum(["binance", "bybit"]).optional(),
  futuresExchange: z.enum(["binance", "bybit"]).optional(),
  minimumNetEdgeBps: z.number().finite().min(-10_000).max(10_000),
  minimumCapacityUsd: z.number().finite().min(0).max(1_000_000_000).default(0),
  estimatedNonFundingCostBps: z.number().finite().min(0).max(2_000).default(0),
  holdingHours: z
    .number()
    .finite()
    .min(0)
    .max(24 * 30)
    .default(8),
  cooldownSeconds: z.number().int().min(60).max(86_400).default(300),
  enabled: z.boolean().default(true)
});

export type ArbitrageAlertInput = z.infer<typeof arbitrageAlertInputSchema>;
export type ArbitrageAlertDeliveryStatus = "queued" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";

export interface ArbitrageAlertDeliverySummary {
  id: string;
  opportunityId: string;
  status: ArbitrageAlertDeliveryStatus;
  attempts: number;
  queuedAt: number;
  nextAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
}

export interface ArbitrageAlertRule extends ArbitrageAlertInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Latest crossing queued for any opportunity; per-route cooldown lives in pair state. */
  lastTriggeredAt?: number;
  lastDelivery?: ArbitrageAlertDeliverySummary;
}

export interface ArbitrageAlertDelivery extends ArbitrageAlertDeliverySummary {
  ruleId: string;
  symbol: string;
  maxAttempts: number;
  lastAttemptAt?: number;
  leaseUntil?: number;
  payload: NotifyPayload;
}

export interface ArbitrageAlertEvaluationResult {
  queuedDeliveryIds: string[];
  attemptedDeliveryIds: string[];
  deliveredDeliveryIds: string[];
  retryingDeliveryIds: string[];
  failedDeliveryIds: string[];
}

interface PairState {
  ruleId: string;
  opportunityId: string;
  eligible: boolean;
  updatedAt: number;
  lastTriggeredAt?: number;
  lastDeliveryId?: string;
}

interface PersistedAlertState {
  version: 2;
  rules: ArbitrageAlertRule[];
  pairStates: Record<string, PairState>;
  initializedRules: Record<string, true>;
  deliveries: ArbitrageAlertDelivery[];
}

interface AlertStorage {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

interface PendingEvaluation {
  scan: ArbitrageScanResponse;
  now?: number;
}

export interface ArbitrageAlertServiceOptions {
  storage?: AlertStorage;
  deliver?: (payload: NotifyPayload) => Promise<unknown>;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  deliveryTimeoutMs?: number;
  logger?: Pick<Console, "error">;
  clockCalibration?: Pick<ArbitrageClockCalibration, "assessTimestamp" | "assessSkew">;
}

export class ArbitrageAlertService {
  private hub?: ArbitrageStreamHub;
  private detach?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attached = false;
  private pendingEvaluation?: PendingEvaluation;
  private evaluationDrain?: Promise<ArbitrageAlertEvaluationResult>;
  private pendingDeliveryAt?: number;
  private deliveryDrain?: Promise<ArbitrageAlertEvaluationResult>;
  private workerError?: string;
  private readonly storage: AlertStorage;
  private readonly deliver: (payload: NotifyPayload) => Promise<unknown>;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly deliveryTimeoutMs: number;
  private readonly logger: Pick<Console, "error">;
  private readonly clockCalibration?: Pick<ArbitrageClockCalibration, "assessTimestamp" | "assessSkew">;

  constructor(options: ArbitrageAlertServiceOptions = {}) {
    this.storage = options.storage ?? { get: getSetting, set: (key, value) => setSetting(key, value) };
    this.deliver = options.deliver ?? ((payload) => notifyChecked(payload));
    this.now = options.now ?? Date.now;
    this.retryBaseMs = positiveInteger(options.retryBaseMs, 2_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(options.retryMaxMs, 5 * 60_000));
    this.maxAttempts = Math.max(1, Math.min(20, positiveInteger(options.maxAttempts, 6)));
    this.deliveryTimeoutMs = positiveInteger(options.deliveryTimeoutMs, 20_000);
    this.logger = options.logger ?? console;
    this.clockCalibration = options.clockCalibration;
  }

  attach(hub: ArbitrageStreamHub) {
    this.detach?.();
    this.clearRetryTimer();
    this.hub = hub;
    this.attached = true;
    this.detach = hub.subscribe((scan) => {
      void this.evaluate(scan).catch((error) => this.reportWorkerError("Alert evaluation failed", error));
    });
    this.syncBackgroundState();
    void this.flush().catch((error) => this.reportWorkerError("Alert outbox startup flush failed", error));
  }

  close() {
    this.attached = false;
    this.detach?.();
    this.detach = undefined;
    this.pendingEvaluation = undefined;
    this.clearRetryTimer();
    this.hub?.setBackgroundActive(false);
  }

  list(): ArbitrageAlertRule[] {
    return this.readState().rules;
  }

  listDeliveries(limit = 100): Array<Omit<ArbitrageAlertDelivery, "payload">> {
    return this.readState()
      .deliveries.slice()
      .sort((left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(500, Math.floor(limit))))
      .map(({ payload: _payload, ...delivery }) => delivery);
  }

  lastWorkerError() {
    return this.workerError;
  }

  save(input: ArbitrageAlertInput, now = this.now()) {
    const state = this.readState();
    const current = input.id ? state.rules.find((rule) => rule.id === input.id) : undefined;
    if (current) this.cancelRuleWork(state, current.id, "Rule was updated before delivery", now);
    const rule: ArbitrageAlertRule = {
      ...input,
      id: current?.id ?? randomUUID(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current?.lastTriggeredAt !== undefined ? { lastTriggeredAt: current.lastTriggeredAt } : {}),
      ...(current?.lastDelivery ? { lastDelivery: current.lastDelivery } : {})
    };
    state.rules = [rule, ...state.rules.filter((value) => value.id !== rule.id)].slice(0, MAX_RULES);
    this.resetRuleRuntime(state, rule.id);
    this.persist(state);
    this.syncBackgroundState(state.rules);
    this.scheduleRetry();
    return rule;
  }

  remove(id: string, now = this.now()) {
    const state = this.readState();
    state.rules = state.rules.filter((rule) => rule.id !== id);
    this.cancelRuleWork(state, id, "Rule was removed before delivery", now);
    this.resetRuleRuntime(state, id);
    this.persist(state);
    this.syncBackgroundState(state.rules);
    this.scheduleRetry();
    return state.rules;
  }

  evaluate(scan: ArbitrageScanResponse, now?: number): Promise<ArbitrageAlertEvaluationResult> {
    const evaluation = this.enqueueEvaluation(scan, now);
    // Delivery waits never block evaluation of the latest market state. Callers
    // still receive the combined result for backward-compatible diagnostics.
    return evaluation.then(async (evaluated) => mergeEvaluationResults(evaluated, await this.flush(now)));
  }

  /** Explicit retry hook for tests, health jobs and administrative recovery. */
  flush(now?: number): Promise<ArbitrageAlertEvaluationResult> {
    const requestedAt = now ?? this.now();
    this.pendingDeliveryAt = Math.max(this.pendingDeliveryAt ?? requestedAt, requestedAt);
    if (!this.deliveryDrain) {
      const drain = this.drainPendingDeliveries();
      this.deliveryDrain = drain;
      const clear = () => {
        if (this.deliveryDrain === drain) this.deliveryDrain = undefined;
      };
      void drain.then(clear, clear);
    }
    return this.deliveryDrain;
  }

  private enqueueEvaluation(scan: ArbitrageScanResponse, now?: number) {
    this.pendingEvaluation = { scan, ...(now === undefined ? {} : { now }) };
    if (!this.evaluationDrain) {
      const drain = this.drainPendingEvaluations();
      this.evaluationDrain = drain;
      const clear = () => {
        if (this.evaluationDrain === drain) this.evaluationDrain = undefined;
      };
      void drain.then(clear, clear);
    }
    return this.evaluationDrain;
  }

  private async drainPendingEvaluations() {
    // Give same-turn bursts a chance to collapse to their latest snapshot.
    await Promise.resolve();
    let result = emptyEvaluationResult();
    while (this.pendingEvaluation) {
      const pending = this.pendingEvaluation;
      this.pendingEvaluation = undefined;
      result = mergeEvaluationResults(result, this.evaluateSnapshot(pending.scan, pending.now ?? this.now()));
      await Promise.resolve();
    }
    return result;
  }

  private async drainPendingDeliveries() {
    await Promise.resolve();
    let result = emptyEvaluationResult();
    while (this.pendingDeliveryAt !== undefined) {
      const now = this.pendingDeliveryAt;
      this.pendingDeliveryAt = undefined;
      result = mergeEvaluationResults(result, await this.drainDue(now, []));
    }
    return result;
  }

  private evaluateSnapshot(scan: ArbitrageScanResponse, now: number) {
    const state = this.readState();
    const queuedDeliveryIds: string[] = [];
    for (const rule of state.rules) {
      if (!rule.enabled) {
        this.markRulePairsIneligible(state, rule.id, now);
        continue;
      }
      const initialized = state.initializedRules[rule.id] === true;
      const matches = scan.opportunities.filter((row) => matchesRule(row, rule));
      const seen = new Set<string>();
      for (const opportunity of matches) {
        const key = pairKey(rule.id, opportunity.id);
        seen.add(key);
        // Unknown freshness or either unhealthy route dependency is neither
        // eligible nor ineligible. Retain the last trustworthy pair state.
        const refreshed = refreshOpportunityQuality(opportunity, now, this.clockCalibration);
        if (opportunity.dataQuality !== "fresh" || refreshed.dataQuality !== "fresh" || !routeDependenciesHealthy(scan, opportunity)) continue;
        const previous = state.pairStates[key];
        const eligible = opportunityEligible(refreshed, rule, now);
        const crossed = initialized && !(previous?.eligible ?? false) && eligible;
        const coolingDown = previous?.lastTriggeredAt !== undefined && now - previous.lastTriggeredAt < rule.cooldownSeconds * 1_000;
        const nextPair: PairState = { ruleId: rule.id, opportunityId: opportunity.id, eligible, updatedAt: now, lastTriggeredAt: previous?.lastTriggeredAt, lastDeliveryId: previous?.lastDeliveryId };
        if (crossed && !coolingDown) {
          const delivery = this.enqueueDelivery(state, rule, refreshed, now);
          nextPair.lastTriggeredAt = now;
          nextPair.lastDeliveryId = delivery.id;
          rule.lastTriggeredAt = now;
          rule.updatedAt = now;
          rule.lastDelivery = deliverySummary(delivery);
          if (delivery.status === "queued") queuedDeliveryIds.push(delivery.id);
        }
        state.pairStates[key] = nextPair;
      }
      const completeUniverse = !scan.stale && !scan.truncated && completeSourceUniverse(scan);
      if (completeUniverse) {
        for (const [key, pair] of Object.entries(state.pairStates)) {
          if (pair.ruleId === rule.id && !seen.has(key) && pair.eligible) state.pairStates[key] = { ...pair, eligible: false, updatedAt: now };
        }
      }
      state.initializedRules[rule.id] = true;
    }
    this.prunePairState(state, now);
    this.persist(state);
    return emptyEvaluationResult(queuedDeliveryIds);
  }

  private enqueueDelivery(state: PersistedAlertState, rule: ArbitrageAlertRule, opportunity: ArbitrageOpportunity, now: number) {
    const activeCount = state.deliveries.filter((delivery) => activeStatus(delivery.status)).length;
    const net = effectiveNetEdgeBps(opportunity, rule, now);
    const delivery: ArbitrageAlertDelivery = {
      id: randomUUID(),
      ruleId: rule.id,
      opportunityId: opportunity.id,
      symbol: opportunity.symbol,
      status: activeCount >= MAX_ACTIVE_DELIVERIES ? "failed" : "queued",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      queuedAt: now,
      nextAttemptAt: activeCount >= MAX_ACTIVE_DELIVERIES ? undefined : now,
      ...(activeCount >= MAX_ACTIVE_DELIVERIES ? { lastError: "Alert outbox capacity reached; delivery was not queued" } : {}),
      payload: {
        event: "signal",
        bot: "Persistent arbitrage alert",
        symbol: opportunity.symbol,
        text: `${opportunity.spotExchange} spot → ${opportunity.futuresExchange} perpetual · estimated net ${(net / 100).toFixed(3)}% crossed ${(rule.minimumNetEdgeBps / 100).toFixed(3)}%`
      }
    };
    state.deliveries.push(delivery);
    return delivery;
  }

  private async drainDue(now: number, queuedDeliveryIds: string[]): Promise<ArbitrageAlertEvaluationResult> {
    const attemptedDeliveryIds: string[] = [];
    const deliveredDeliveryIds: string[] = [];
    const retryingDeliveryIds: string[] = [];
    const failedDeliveryIds: string[] = [];

    for (let processed = 0; processed < MAX_DRAIN_BATCH; processed += 1) {
      let state = this.readState();
      const delivery = state.deliveries.filter((candidate) => deliveryDue(candidate, now)).sort((left, right) => dueAt(left) - dueAt(right) || left.queuedAt - right.queuedAt)[0];
      if (!delivery) break;
      const rule = state.rules.find((candidate) => candidate.id === delivery.ruleId);
      if (!rule?.enabled) {
        delivery.status = "cancelled";
        delivery.lastError = "Rule is missing or disabled";
        delivery.nextAttemptAt = undefined;
        delivery.leaseUntil = undefined;
        this.persist(state);
        continue;
      }

      delivery.status = "sending";
      delivery.attempts += 1;
      delivery.lastAttemptAt = now;
      delivery.nextAttemptAt = undefined;
      delivery.leaseUntil = now + this.deliveryTimeoutMs;
      delivery.lastError = undefined;
      rule.lastDelivery = deliverySummary(delivery);
      this.persist(state);
      attemptedDeliveryIds.push(delivery.id);

      try {
        await withTimeout(this.deliver(delivery.payload), this.deliveryTimeoutMs);
        state = this.readState();
        const current = state.deliveries.find((candidate) => candidate.id === delivery.id);
        if (!current) continue;
        current.status = "delivered";
        current.deliveredAt = this.now();
        current.nextAttemptAt = undefined;
        current.leaseUntil = undefined;
        current.lastError = undefined;
        const currentRule = state.rules.find((candidate) => candidate.id === current.ruleId);
        if (currentRule) currentRule.lastDelivery = deliverySummary(current);
        deliveredDeliveryIds.push(current.id);
        this.persist(state);
      } catch (error) {
        state = this.readState();
        const current = state.deliveries.find((candidate) => candidate.id === delivery.id);
        if (!current || current.status === "cancelled") continue;
        current.lastError = errorMessage(error);
        current.leaseUntil = undefined;
        if (current.attempts >= current.maxAttempts) {
          current.status = "failed";
          current.nextAttemptAt = undefined;
          failedDeliveryIds.push(current.id);
        } else {
          current.status = "retrying";
          current.nextAttemptAt = now + retryDelay(current.attempts, this.retryBaseMs, this.retryMaxMs);
          retryingDeliveryIds.push(current.id);
        }
        const currentRule = state.rules.find((candidate) => candidate.id === current.ruleId);
        if (currentRule) currentRule.lastDelivery = deliverySummary(current);
        this.persist(state);
      }
    }
    this.scheduleRetry();
    return { queuedDeliveryIds, attemptedDeliveryIds, deliveredDeliveryIds, retryingDeliveryIds, failedDeliveryIds };
  }

  private readState(): PersistedAlertState {
    const current = this.storage.get<PersistedAlertState>(STATE_STORE_KEY);
    if (current?.version === 2 && Array.isArray(current.rules) && Array.isArray(current.deliveries)) {
      return { version: 2, rules: current.rules, pairStates: current.pairStates ?? {}, initializedRules: current.initializedRules ?? {}, deliveries: current.deliveries };
    }
    return { version: 2, rules: this.storage.get<ArbitrageAlertRule[]>(LEGACY_STORE_KEY) ?? [], pairStates: {}, initializedRules: {}, deliveries: [] };
  }

  private persist(state: PersistedAlertState) {
    const terminal = state.deliveries
      .filter((delivery) => !activeStatus(delivery.status))
      .sort((left, right) => right.queuedAt - left.queuedAt)
      .slice(0, MAX_TERMINAL_DELIVERIES);
    const active = state.deliveries.filter((delivery) => activeStatus(delivery.status));
    state.deliveries = [...active, ...terminal];
    this.storage.set(STATE_STORE_KEY, state);
  }

  private cancelRuleWork(state: PersistedAlertState, ruleId: string, reason: string, now: number) {
    const rule = state.rules.find((candidate) => candidate.id === ruleId);
    for (const delivery of state.deliveries) {
      if (delivery.ruleId !== ruleId || !activeStatus(delivery.status)) continue;
      delivery.status = "cancelled";
      delivery.lastError = reason;
      delivery.nextAttemptAt = undefined;
      delivery.leaseUntil = undefined;
      delivery.lastAttemptAt ??= now;
      if (rule?.lastDelivery?.id === delivery.id) rule.lastDelivery = deliverySummary(delivery);
    }
  }

  private resetRuleRuntime(state: PersistedAlertState, ruleId: string) {
    delete state.initializedRules[ruleId];
    for (const [key, pair] of Object.entries(state.pairStates)) if (pair.ruleId === ruleId) delete state.pairStates[key];
  }

  private markRulePairsIneligible(state: PersistedAlertState, ruleId: string, now: number) {
    for (const [key, pair] of Object.entries(state.pairStates)) {
      if (pair.ruleId === ruleId && pair.eligible) state.pairStates[key] = { ...pair, eligible: false, updatedAt: now };
    }
  }

  private prunePairState(state: PersistedAlertState, now: number) {
    const existingRules = new Set(state.rules.map((rule) => rule.id));
    for (const [key, pair] of Object.entries(state.pairStates)) {
      if (!existingRules.has(pair.ruleId) || (!pair.eligible && now - pair.updatedAt > 7 * 24 * 60 * 60_000)) delete state.pairStates[key];
    }
  }

  private scheduleRetry() {
    this.clearRetryTimer();
    if (!this.attached) return;
    const next = this.readState()
      .deliveries.filter((delivery) => activeStatus(delivery.status))
      .map(dueAt)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(2_147_483_647, next - this.now()));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush().catch((error) => this.reportWorkerError("Alert outbox retry failed", error));
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private syncBackgroundState(rules = this.list()) {
    this.hub?.setBackgroundActive(rules.some((rule) => rule.enabled));
  }

  private reportWorkerError(context: string, error: unknown) {
    this.workerError = `${context}: ${errorMessage(error)}`;
    this.logger.error(this.workerError);
  }
}

export function effectiveNetEdgeBps(row: ArbitrageOpportunity, rule: Pick<ArbitrageAlertRule, "estimatedNonFundingCostBps" | "holdingHours">, now = Date.now()) {
  return row.grossSpreadBps - rule.estimatedNonFundingCostBps + projectedShortFundingBps(row, rule.holdingHours, now);
}

function matchesRule(row: ArbitrageOpportunity, rule: ArbitrageAlertRule) {
  return (!rule.symbol || row.symbol === rule.symbol) && (!rule.spotExchange || row.spotExchange === rule.spotExchange) && (!rule.futuresExchange || row.futuresExchange === rule.futuresExchange);
}

function opportunityEligible(row: ArbitrageOpportunity, rule: ArbitrageAlertRule, now: number) {
  return effectiveNetEdgeBps(row, rule, now) >= rule.minimumNetEdgeBps && row.topBookCapacityUsd >= rule.minimumCapacityUsd;
}

/** Exact source dependency gate used by persistent alert evaluation. */
export function routeDependenciesHealthy(scan: Pick<ArbitrageScanResponse, "sources">, row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange">) {
  return sourceHealthy(scan, row.spotExchange, "spot") && sourceHealthy(scan, row.futuresExchange, "perpetual");
}

function completeSourceUniverse(scan: Pick<ArbitrageScanResponse, "sources">) {
  return (["binance", "bybit"] as const).every((exchange) => (["spot", "perpetual"] as const).every((market) => sourceHealthy(scan, exchange, market)));
}

function sourceHealthy(scan: Pick<ArbitrageScanResponse, "sources">, exchange: ArbitrageOpportunity["spotExchange"], market: "spot" | "perpetual") {
  const matching = scan.sources.filter((source) => source.exchange === exchange && source.market === market);
  return matching.length === 1 && matching[0]?.ok === true;
}

function pairKey(ruleId: string, opportunityId: string) {
  return `${ruleId}\u001f${opportunityId}`;
}

function emptyEvaluationResult(queuedDeliveryIds: string[] = []): ArbitrageAlertEvaluationResult {
  return { queuedDeliveryIds, attemptedDeliveryIds: [], deliveredDeliveryIds: [], retryingDeliveryIds: [], failedDeliveryIds: [] };
}

function mergeEvaluationResults(left: ArbitrageAlertEvaluationResult, right: ArbitrageAlertEvaluationResult): ArbitrageAlertEvaluationResult {
  return {
    queuedDeliveryIds: uniqueIds(left.queuedDeliveryIds, right.queuedDeliveryIds),
    attemptedDeliveryIds: uniqueIds(left.attemptedDeliveryIds, right.attemptedDeliveryIds),
    deliveredDeliveryIds: uniqueIds(left.deliveredDeliveryIds, right.deliveredDeliveryIds),
    retryingDeliveryIds: uniqueIds(left.retryingDeliveryIds, right.retryingDeliveryIds),
    failedDeliveryIds: uniqueIds(left.failedDeliveryIds, right.failedDeliveryIds)
  };
}

function uniqueIds(left: string[], right: string[]) {
  return [...new Set([...left, ...right])];
}

function deliverySummary(delivery: ArbitrageAlertDelivery): ArbitrageAlertDeliverySummary {
  return {
    id: delivery.id,
    opportunityId: delivery.opportunityId,
    status: delivery.status,
    attempts: delivery.attempts,
    queuedAt: delivery.queuedAt,
    nextAttemptAt: delivery.nextAttemptAt,
    deliveredAt: delivery.deliveredAt,
    lastError: delivery.lastError
  };
}

function activeStatus(status: ArbitrageAlertDeliveryStatus) {
  return status === "queued" || status === "sending" || status === "retrying";
}

function deliveryDue(delivery: ArbitrageAlertDelivery, now: number) {
  if (delivery.status === "queued" || delivery.status === "retrying") return (delivery.nextAttemptAt ?? delivery.queuedAt) <= now;
  return delivery.status === "sending" && (delivery.leaseUntil ?? delivery.lastAttemptAt ?? delivery.queuedAt) <= now;
}

function dueAt(delivery: ArbitrageAlertDelivery) {
  if (delivery.status === "sending") return delivery.leaseUntil ?? delivery.lastAttemptAt ?? delivery.queuedAt;
  return delivery.nextAttemptAt ?? delivery.queuedAt;
}

function retryDelay(attempts: number, baseMs: number, maxMs: number) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Notification delivery timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
