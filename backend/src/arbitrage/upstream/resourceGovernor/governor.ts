import { ArbitrageOverloadError } from "../../sharedAbortableWork.js";
import type { UpstreamCircuitState, UpstreamGovernorSnapshot, UpstreamLeaseOutcome, UpstreamResourceCounters, UpstreamResourceLease, UpstreamRunOptions, UpstreamSourceBudget, UpstreamSourceSnapshot } from "./types.js";

interface MutableSourceState {
  readonly budget: UpstreamSourceBudget;
  active: number;
  state: UpstreamCircuitState;
  halfOpenProbeActive: boolean;
  consecutiveFailures: number;
  openUntil?: number;
  counters: UpstreamResourceCounters;
  latencyTotalMs: number;
  latencySamples: number;
  latencyLastMs?: number;
  latencyMaxMs?: number;
  lastAcquiredAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastAbortAt?: number;
  circuitOpenedAt?: number;
}

export class UpstreamSourceOverloadError extends ArbitrageOverloadError {
  readonly source: string;
  readonly upstreamCode = "UPSTREAM_SOURCE_OVERLOADED";

  constructor(source: string) {
    super(`Public upstream '${source}' concurrency limit reached`);
    this.name = "UpstreamSourceOverloadError";
    this.source = source;
  }
}

export class UpstreamCircuitOpenError extends ArbitrageOverloadError {
  readonly source: string;
  readonly retryAt: number;
  readonly upstreamCode = "UPSTREAM_CIRCUIT_OPEN";

  constructor(source: string, retryAt: number) {
    super(`Public upstream '${source}' circuit is open`);
    this.name = "UpstreamCircuitOpenError";
    this.source = source;
    this.retryAt = retryAt;
  }
}

/**
 * Process-compatible, queue-free resource governor for public market data.
 * A lease consumes capacity immediately or fails immediately. `run` is the
 * preferred API because it guarantees release on every promise outcome.
 */
export class UpstreamResourceGovernor {
  private readonly states = new Map<string, MutableSourceState>();
  private readonly now: () => number;

  constructor(budgets: Readonly<Record<string, UpstreamSourceBudget>>, now: () => number = Date.now) {
    this.now = now;
    for (const [source, budget] of Object.entries(budgets)) {
      validateSource(source);
      this.states.set(source, createState(validateBudget(budget)));
    }
    if (this.states.size === 0) throw new Error("At least one named upstream source budget is required");
  }

  acquire(source: string): UpstreamResourceLease {
    const state = this.requireSource(source);
    const acquiredAt = this.now();
    refreshCircuit(state, acquiredAt);

    if (state.state === "open") {
      state.counters.circuitRejected += 1;
      throw new UpstreamCircuitOpenError(source, state.openUntil ?? acquiredAt);
    }
    if (state.state === "half-open" && state.halfOpenProbeActive) {
      state.counters.circuitRejected += 1;
      // The original openUntil is already due once half-open begins. Returning
      // that stale timestamp makes competing reconnectors retry every 1ms while
      // the single recovery probe is still active. Publish a future retry bound.
      throw new UpstreamCircuitOpenError(source, acquiredAt + state.budget.cooldownMs);
    }
    if (state.active >= state.budget.maxConcurrent) {
      state.counters.overloadRejected += 1;
      throw new UpstreamSourceOverloadError(source);
    }

    const halfOpenProbe = state.state === "half-open";
    if (halfOpenProbe) state.halfOpenProbeActive = true;
    state.active += 1;
    state.counters.acquired += 1;
    state.lastAcquiredAt = acquiredAt;
    let released = false;

    return {
      source,
      acquiredAt,
      release: (outcome: UpstreamLeaseOutcome = "success") => {
        if (released) return false;
        released = true;
        this.release(source, state, acquiredAt, halfOpenProbe, outcome);
        return true;
      }
    };
  }

  async run<Value>(source: string, operation: () => Promise<Value>, options: UpstreamRunOptions = {}): Promise<Value> {
    const lease = this.acquire(source);
    try {
      const value = await operation();
      lease.release("success");
      return value;
    } catch (error) {
      lease.release(options.classifyError?.(error) ?? classifyDefault(error));
      throw error;
    }
  }

  snapshot(): UpstreamGovernorSnapshot {
    const generatedAt = this.now();
    const sources = [...this.states.entries()].map(([source, state]) => snapshotSource(source, state, generatedAt)).sort((left, right) => left.source.localeCompare(right.source));
    return {
      generatedAt,
      healthy: sources.every((source) => source.healthy),
      totals: {
        sources: sources.length,
        active: sources.reduce((sum, source) => sum + source.active, 0),
        overloadRejected: sources.reduce((sum, source) => sum + source.counters.overloadRejected, 0),
        circuitRejected: sources.reduce((sum, source) => sum + source.counters.circuitRejected, 0),
        failed: sources.reduce((sum, source) => sum + source.counters.failed, 0)
      },
      sources
    };
  }

  sourceSnapshot(source: string): UpstreamSourceSnapshot {
    return snapshotSource(source, this.requireSource(source), this.now());
  }

  /** Accounts a rejection made by a bounded coalescer before a source lease starts. */
  recordExternalOverload(source: string): void {
    this.requireSource(source).counters.overloadRejected += 1;
  }

  private requireSource(source: string) {
    const state = this.states.get(source);
    if (!state) throw new Error(`Unknown public upstream source '${source}'`);
    return state;
  }

  private release(source: string, state: MutableSourceState, acquiredAt: number, halfOpenProbe: boolean, outcome: UpstreamLeaseOutcome) {
    const finishedAt = this.now();
    state.active = Math.max(0, state.active - 1);
    const latencyMs = Math.max(0, finishedAt - acquiredAt);
    state.latencyLastMs = latencyMs;
    state.latencyMaxMs = Math.max(state.latencyMaxMs ?? 0, latencyMs);
    state.latencyTotalMs += latencyMs;
    state.latencySamples += 1;
    if (halfOpenProbe) state.halfOpenProbeActive = false;

    if (outcome === "success") {
      state.counters.succeeded += 1;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = finishedAt;
      if (halfOpenProbe) closeCircuit(state);
      return;
    }
    if (outcome === "aborted") {
      state.counters.aborted += 1;
      state.lastAbortAt = finishedAt;
      return;
    }
    if (outcome === "ignored") {
      state.counters.ignored += 1;
      return;
    }

    state.counters.failed += 1;
    state.consecutiveFailures += 1;
    state.lastFailureAt = finishedAt;
    if (halfOpenProbe || state.consecutiveFailures >= state.budget.failureThreshold) {
      openCircuit(state, finishedAt);
    }
  }
}

function createState(budget: UpstreamSourceBudget): MutableSourceState {
  return {
    budget,
    active: 0,
    state: "closed",
    halfOpenProbeActive: false,
    consecutiveFailures: 0,
    counters: { acquired: 0, succeeded: 0, failed: 0, aborted: 0, ignored: 0, overloadRejected: 0, circuitRejected: 0, circuitOpened: 0 },
    latencyTotalMs: 0,
    latencySamples: 0
  };
}

function refreshCircuit(state: MutableSourceState, now: number) {
  if (state.state === "open" && now >= (state.openUntil ?? Number.POSITIVE_INFINITY)) {
    state.state = "half-open";
    state.halfOpenProbeActive = false;
  }
}

function openCircuit(state: MutableSourceState, now: number) {
  // Work admitted before the first failure may still be unwinding. Its later
  // failure is counted, but it must not masquerade as another circuit opening
  // or keep extending the original cooldown window.
  if (state.state === "open") return;
  state.state = "open";
  state.openUntil = now + state.budget.cooldownMs;
  state.halfOpenProbeActive = false;
  state.circuitOpenedAt = now;
  state.counters.circuitOpened += 1;
}

function closeCircuit(state: MutableSourceState) {
  state.state = "closed";
  state.openUntil = undefined;
  state.halfOpenProbeActive = false;
  state.consecutiveFailures = 0;
}

function snapshotSource(source: string, state: MutableSourceState, now: number): UpstreamSourceSnapshot {
  refreshCircuit(state, now);
  const latency = state.latencySamples > 0 ? { lastMs: state.latencyLastMs, averageMs: state.latencyTotalMs / state.latencySamples, maxMs: state.latencyMaxMs } : {};
  return {
    source,
    state: state.state,
    healthy: state.state === "closed",
    budget: { ...state.budget },
    active: state.active,
    available: Math.max(0, state.budget.maxConcurrent - state.active),
    halfOpenProbeActive: state.halfOpenProbeActive,
    cooldownRemainingMs: state.state === "open" ? Math.max(0, (state.openUntil ?? now) - now) : 0,
    consecutiveFailures: state.consecutiveFailures,
    counters: { ...state.counters },
    latency,
    ...(state.lastAcquiredAt === undefined ? {} : { lastAcquiredAt: state.lastAcquiredAt }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.lastFailureAt === undefined ? {} : { lastFailureAt: state.lastFailureAt }),
    ...(state.lastAbortAt === undefined ? {} : { lastAbortAt: state.lastAbortAt }),
    ...(state.circuitOpenedAt === undefined ? {} : { circuitOpenedAt: state.circuitOpenedAt })
  };
}

function classifyDefault(error: unknown): Exclude<UpstreamLeaseOutcome, "success"> {
  return error instanceof Error && error.name === "AbortError" ? "aborted" : "failure";
}

function validateSource(source: string) {
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(source)) throw new Error(`Invalid upstream source name '${source}'`);
}

function validateBudget(budget: UpstreamSourceBudget): UpstreamSourceBudget {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  return { ...budget };
}
