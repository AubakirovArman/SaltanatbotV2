import { randomUUID } from "node:crypto";
import { notifyChecked, type NotifyPayload } from "../../trading/notifications.js";
import { getSetting, setSetting } from "../../trading/store.js";
import { createResearchAlertState, evaluateResearchAlertSnapshot } from "./evaluate.js";
import { researchAlertPolicyInputSchema, researchAlertSnapshotSchema } from "./schema.js";
import type { ResearchAlertDelivery, ResearchAlertDeliverySummary, ResearchAlertOutboxIntent, ResearchAlertPersistedState, ResearchAlertPolicy, ResearchAlertPolicyInput, ResearchAlertServiceResult, ResearchAlertSnapshot, ResearchAlertStorage } from "./types.js";

export const RESEARCH_ALERT_STATE_KEY = "arbitrage:research-alert-state:v1";
const MAX_POLICIES = 50;
const MAX_ACTIVE_DELIVERIES = 1_000;
const MAX_TERMINAL_DELIVERIES = 200;
const MAX_DRAIN_BATCH = 50;

export interface ResearchAlertServiceOptions {
  storage?: ResearchAlertStorage;
  deliver?: (payload: NotifyPayload) => Promise<unknown>;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  deliveryTimeoutMs?: number;
  logger?: Pick<Console, "error">;
}

/** Durable notification-only runtime for generic research alert intents. */
export class ResearchAlertService {
  private readonly storage: ResearchAlertStorage;
  private readonly deliver: (payload: NotifyPayload) => Promise<unknown>;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly deliveryTimeoutMs: number;
  private readonly logger: Pick<Console, "error">;
  private evaluationTail: Promise<void> = Promise.resolve();
  private pendingDeliveryAt?: number;
  private deliveryDrain?: Promise<DeliveryResult>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private workerError?: string;

  constructor(options: ResearchAlertServiceOptions = {}) {
    this.storage = options.storage ?? { get: getSetting, set: (key, value) => setSetting(key, value) };
    this.deliver = options.deliver ?? ((payload) => notifyChecked(payload));
    this.now = options.now ?? Date.now;
    this.retryBaseMs = positiveInteger(options.retryBaseMs, 2_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(options.retryMaxMs, 5 * 60_000));
    this.maxAttempts = Math.max(1, Math.min(20, positiveInteger(options.maxAttempts, 6)));
    this.deliveryTimeoutMs = positiveInteger(options.deliveryTimeoutMs, 20_000);
    this.logger = options.logger ?? console;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduleRetry();
    void this.flush().catch((error) => this.reportWorkerError("Research alert startup flush failed", error));
  }

  close() {
    this.started = false;
    this.clearRetryTimer();
  }

  listPolicies(): ResearchAlertPolicy[] {
    return structuredClone(this.readState().policies);
  }

  listDeliveries(limit = 100): Array<Omit<ResearchAlertDelivery, "payload">> {
    return this.readState()
      .deliveries.slice()
      .sort((left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id))
      .slice(0, boundedLimit(limit))
      .map(({ payload: _payload, ...delivery }) => structuredClone(delivery));
  }

  lastWorkerError() {
    return this.workerError;
  }

  savePolicy(input: ResearchAlertPolicyInput, now = this.now()) {
    const state = this.readState();
    const parsed = researchAlertPolicyInputSchema.parse(input);
    const current = parsed.id ? state.policies.find((policy) => policy.id === parsed.id) : undefined;
    if (current) this.cancelPolicyWork(state, current.id, "Policy was updated before delivery", now);
    const normalized = normalizePolicyInput(parsed);
    const policy: ResearchAlertPolicy = {
      ...normalized,
      id: current?.id ?? randomUUID(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current?.lastTriggeredAt !== undefined ? { lastTriggeredAt: current.lastTriggeredAt } : {}),
      ...(current?.lastDelivery ? { lastDelivery: current.lastDelivery } : {})
    };
    state.policies = [policy, ...state.policies.filter((value) => value.id !== policy.id)].slice(0, MAX_POLICIES);
    this.resetPolicyRuntime(state, policy.id);
    this.persist(state);
    this.scheduleRetry();
    return structuredClone(policy);
  }

  removePolicy(id: string, now = this.now()) {
    const state = this.readState();
    state.policies = state.policies.filter((policy) => policy.id !== id);
    this.cancelPolicyWork(state, id, "Policy was removed before delivery", now);
    this.resetPolicyRuntime(state, id);
    this.persist(state);
    this.scheduleRetry();
    return structuredClone(state.policies);
  }

  ingest(snapshot: ResearchAlertSnapshot, now = this.now()): Promise<ResearchAlertServiceResult> {
    const parsedSnapshot = researchAlertSnapshotSchema.parse(snapshot) as ResearchAlertSnapshot;
    let resolve!: (value: EvaluationStage) => void;
    let reject!: (error: unknown) => void;
    const staged = new Promise<EvaluationStage>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const run = this.evaluationTail.then(() => {
      try {
        const evaluated = evaluateResearchAlertSnapshot(this.readState(), parsedSnapshot, now);
        const queuedDeliveryIds: string[] = [];
        for (const intent of evaluated.result.intents) {
          const delivery = this.enqueueDelivery(evaluated.state, intent);
          const pair = evaluated.state.pairs[pairKey(intent.policyId, intent.dedupKey)];
          if (pair) pair.lastDeliveryId = delivery.id;
          const policy = evaluated.state.policies.find((value) => value.id === intent.policyId);
          if (policy) policy.lastDelivery = deliverySummary(delivery);
          if (delivery.status === "queued") queuedDeliveryIds.push(delivery.id);
        }
        this.persist(evaluated.state);
        resolve({ evaluation: evaluated.result, queuedDeliveryIds });
      } catch (error) {
        reject(error);
      }
    });
    this.evaluationTail = run.catch(() => undefined);
    return staged.then(async ({ evaluation, queuedDeliveryIds }) => {
      const delivered = await this.flush(now);
      return { ...evaluation, queuedDeliveryIds, ...delivered };
    });
  }

  flush(now = this.now()): Promise<DeliveryResult> {
    this.pendingDeliveryAt = Math.max(this.pendingDeliveryAt ?? now, now);
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

  private async drainPendingDeliveries() {
    let result = emptyDeliveryResult();
    while (this.pendingDeliveryAt !== undefined) {
      const now = this.pendingDeliveryAt;
      this.pendingDeliveryAt = undefined;
      result = mergeDeliveryResults(result, await this.drainDue(now));
    }
    return result;
  }

  private enqueueDelivery(state: ResearchAlertPersistedState, intent: ResearchAlertOutboxIntent): ResearchAlertDelivery {
    const atCapacity = state.deliveries.filter((delivery) => activeStatus(delivery.status)).length >= MAX_ACTIVE_DELIVERIES;
    const delivery: ResearchAlertDelivery = {
      ...intent,
      id: randomUUID(),
      status: atCapacity ? "failed" : "queued",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      queuedAt: intent.createdAt,
      ...(atCapacity ? { lastError: "Research alert outbox capacity reached; delivery was not queued" } : { nextAttemptAt: intent.createdAt })
    };
    state.deliveries.push(delivery);
    return delivery;
  }

  private async drainDue(now: number): Promise<DeliveryResult> {
    const result = emptyDeliveryResult();
    for (let processed = 0; processed < MAX_DRAIN_BATCH; processed += 1) {
      let state = this.readState();
      const delivery = state.deliveries.filter((candidate) => deliveryDue(candidate, now)).sort((left, right) => dueAt(left) - dueAt(right) || left.queuedAt - right.queuedAt || left.id.localeCompare(right.id))[0];
      if (!delivery) break;
      const policy = state.policies.find((candidate) => candidate.id === delivery.policyId);
      if (!policy?.enabled) {
        delivery.status = "cancelled";
        delivery.lastError = "Policy is missing or disabled";
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
      policy.lastDelivery = deliverySummary(delivery);
      this.persist(state);
      result.attemptedDeliveryIds.push(delivery.id);

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
        const currentPolicy = state.policies.find((candidate) => candidate.id === current.policyId);
        if (currentPolicy) currentPolicy.lastDelivery = deliverySummary(current);
        result.deliveredDeliveryIds.push(current.id);
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
          result.failedDeliveryIds.push(current.id);
        } else {
          current.status = "retrying";
          current.nextAttemptAt = now + retryDelay(current.attempts, this.retryBaseMs, this.retryMaxMs);
          result.retryingDeliveryIds.push(current.id);
        }
        const currentPolicy = state.policies.find((candidate) => candidate.id === current.policyId);
        if (currentPolicy) currentPolicy.lastDelivery = deliverySummary(current);
        this.persist(state);
      }
    }
    this.scheduleRetry();
    return result;
  }

  private readState(): ResearchAlertPersistedState {
    const value = this.storage.get<ResearchAlertPersistedState>(RESEARCH_ALERT_STATE_KEY);
    if (value === undefined) return createResearchAlertState();
    if (value.version !== 1 || !Array.isArray(value.policies) || !Array.isArray(value.deliveries) || typeof value.pairs !== "object" || typeof value.initializedPolicies !== "object" || typeof value.snapshotFingerprints !== "object") {
      throw new Error("Persistent research alert state is invalid; refusing to reset it implicitly");
    }
    return structuredClone(value);
  }

  private persist(state: ResearchAlertPersistedState) {
    const terminal = state.deliveries
      .filter((delivery) => !activeStatus(delivery.status))
      .sort((left, right) => right.queuedAt - left.queuedAt)
      .slice(0, MAX_TERMINAL_DELIVERIES);
    const active = state.deliveries.filter((delivery) => activeStatus(delivery.status));
    state.deliveries = [...active, ...terminal];
    this.storage.set(RESEARCH_ALERT_STATE_KEY, structuredClone(state));
  }

  private cancelPolicyWork(state: ResearchAlertPersistedState, policyId: string, reason: string, now: number) {
    const policy = state.policies.find((candidate) => candidate.id === policyId);
    for (const delivery of state.deliveries) {
      if (delivery.policyId !== policyId || !activeStatus(delivery.status)) continue;
      delivery.status = "cancelled";
      delivery.lastError = reason;
      delivery.nextAttemptAt = undefined;
      delivery.leaseUntil = undefined;
      delivery.lastAttemptAt ??= now;
      if (policy?.lastDelivery?.id === delivery.id) policy.lastDelivery = deliverySummary(delivery);
    }
  }

  private resetPolicyRuntime(state: ResearchAlertPersistedState, policyId: string) {
    delete state.initializedPolicies[policyId];
    for (const [key, pair] of Object.entries(state.pairs)) if (pair.policyId === policyId) delete state.pairs[key];
  }

  private scheduleRetry() {
    this.clearRetryTimer();
    if (!this.started) return;
    let state: ResearchAlertPersistedState;
    try {
      state = this.readState();
    } catch (error) {
      this.reportWorkerError("Research alert outbox state is unavailable", error);
      return;
    }
    const next = state.deliveries
      .filter((delivery) => activeStatus(delivery.status))
      .map(dueAt)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flush().catch((error) => this.reportWorkerError("Research alert retry failed", error));
      },
      Math.max(0, Math.min(2_147_483_647, next - this.now()))
    );
    this.retryTimer.unref?.();
  }

  private clearRetryTimer() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private reportWorkerError(message: string, error: unknown) {
    this.workerError = `${message}: ${errorMessage(error)}`;
    this.logger.error(this.workerError);
  }
}

interface EvaluationStage {
  evaluation: Omit<ResearchAlertServiceResult, "queuedDeliveryIds" | keyof DeliveryResult>;
  queuedDeliveryIds: string[];
}

interface DeliveryResult {
  attemptedDeliveryIds: string[];
  deliveredDeliveryIds: string[];
  retryingDeliveryIds: string[];
  failedDeliveryIds: string[];
}

function normalizePolicyInput(input: ResearchAlertPolicyInput): ResearchAlertPolicyInput {
  return {
    ...input,
    families: [...new Set(input.families)].sort(),
    economicAssetIds: [...new Set(input.economicAssetIds)].sort()
  };
}

function deliverySummary(delivery: ResearchAlertDelivery): ResearchAlertDeliverySummary {
  return { id: delivery.id, dedupKey: delivery.dedupKey, routeId: delivery.routeId, family: delivery.family, status: delivery.status, attempts: delivery.attempts, queuedAt: delivery.queuedAt, nextAttemptAt: delivery.nextAttemptAt, deliveredAt: delivery.deliveredAt, lastError: delivery.lastError };
}

function activeStatus(status: ResearchAlertDelivery["status"]) {
  return status === "queued" || status === "sending" || status === "retrying";
}

function deliveryDue(delivery: ResearchAlertDelivery, now: number) {
  if (delivery.status === "queued" || delivery.status === "retrying") return (delivery.nextAttemptAt ?? delivery.queuedAt) <= now;
  return delivery.status === "sending" && (delivery.leaseUntil ?? delivery.lastAttemptAt ?? delivery.queuedAt) <= now;
}

function dueAt(delivery: ResearchAlertDelivery) {
  return delivery.status === "sending" ? (delivery.leaseUntil ?? delivery.lastAttemptAt ?? delivery.queuedAt) : (delivery.nextAttemptAt ?? delivery.queuedAt);
}

function pairKey(policyId: string, dedupKey: string) {
  return `${policyId}\u001f${dedupKey}`;
}

function retryDelay(attempts: number, baseMs: number, maxMs: number) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

function boundedLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new TypeError("Research alert delivery limit must be an integer from 1 to 500");
  return value;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function emptyDeliveryResult(): DeliveryResult {
  return { attemptedDeliveryIds: [], deliveredDeliveryIds: [], retryingDeliveryIds: [], failedDeliveryIds: [] };
}

function mergeDeliveryResults(left: DeliveryResult, right: DeliveryResult): DeliveryResult {
  return {
    attemptedDeliveryIds: unique(left.attemptedDeliveryIds, right.attemptedDeliveryIds),
    deliveredDeliveryIds: unique(left.deliveredDeliveryIds, right.deliveredDeliveryIds),
    retryingDeliveryIds: unique(left.retryingDeliveryIds, right.retryingDeliveryIds),
    failedDeliveryIds: unique(left.failedDeliveryIds, right.failedDeliveryIds)
  };
}

function unique(left: string[], right: string[]) {
  return [...new Set([...left, ...right])];
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
        timer = setTimeout(() => reject(new Error(`Research alert delivery timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
