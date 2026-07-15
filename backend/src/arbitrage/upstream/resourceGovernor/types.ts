export type UpstreamCircuitState = "closed" | "open" | "half-open";

export type UpstreamLeaseOutcome = "success" | "failure" | "aborted" | "ignored";

export interface UpstreamSourceBudget {
  /** Hard in-flight cap. Acquisition rejects immediately; there is no queue. */
  maxConcurrent: number;
  /** Consecutive upstream failures that open the circuit. */
  failureThreshold: number;
  /** Delay before exactly one half-open probe may run. */
  cooldownMs: number;
}

export interface UpstreamRunOptions {
  /**
   * Maps a rejection to governor accounting. Domain validation and unsupported
   * operations should be ignored rather than counted as an upstream outage.
   */
  classifyError?: (error: unknown) => Exclude<UpstreamLeaseOutcome, "success">;
}

export interface UpstreamResourceCounters {
  acquired: number;
  succeeded: number;
  failed: number;
  aborted: number;
  ignored: number;
  overloadRejected: number;
  circuitRejected: number;
  circuitOpened: number;
}

export interface UpstreamLatencySnapshot {
  lastMs?: number;
  averageMs?: number;
  maxMs?: number;
}

export interface UpstreamSourceSnapshot {
  source: string;
  state: UpstreamCircuitState;
  healthy: boolean;
  budget: UpstreamSourceBudget;
  active: number;
  available: number;
  halfOpenProbeActive: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  counters: UpstreamResourceCounters;
  latency: UpstreamLatencySnapshot;
  lastAcquiredAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastAbortAt?: number;
  circuitOpenedAt?: number;
}

export interface UpstreamGovernorSnapshot {
  generatedAt: number;
  healthy: boolean;
  totals: {
    sources: number;
    active: number;
    overloadRejected: number;
    circuitRejected: number;
    failed: number;
  };
  sources: UpstreamSourceSnapshot[];
}

export interface UpstreamResourceLease {
  readonly source: string;
  readonly acquiredAt: number;
  /** Idempotent: only the first release changes counters or capacity. */
  release(outcome?: UpstreamLeaseOutcome): boolean;
}
