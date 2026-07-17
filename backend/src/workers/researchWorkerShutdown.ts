export interface ResearchWorkerDatabaseShutdown {
  markStopped(): Promise<boolean>;
  closePool(): Promise<void>;
  heartbeatRejected(): void;
  heartbeatFailed(error: unknown): void;
}

export interface ResearchWorkerExecutionDrain {
  readonly currentHeartbeat?: Promise<unknown>;
  markDraining(): Promise<boolean>;
  stopActive(): Promise<unknown>;
  heartbeatRejected(): void;
  heartbeatFailed(error: unknown): void;
}

/**
 * Serializes the final active heartbeat, the durable draining marker and job
 * shutdown. In particular, an already-issued ready pulse must not be able to
 * complete after the draining marker and make a stopping worker look ready.
 */
export async function drainResearchWorkerExecutions(shutdown: ResearchWorkerExecutionDrain): Promise<void> {
  await Promise.allSettled([shutdown.currentHeartbeat]);
  try {
    try {
      const marked = await shutdown.markDraining();
      if (!marked) shutdown.heartbeatRejected();
    } catch (error) {
      shutdown.heartbeatFailed(error);
    }
  } finally {
    await shutdown.stopActive();
  }
}

/**
 * Best-effort terminal heartbeat followed by an unconditional database close.
 * A heartbeat failure must never keep the worker's PostgreSQL pool alive.
 */
export async function closeResearchWorkerDatabase(shutdown: ResearchWorkerDatabaseShutdown): Promise<void> {
  try {
    const marked = await shutdown.markStopped();
    if (!marked) shutdown.heartbeatRejected();
  } catch (error) {
    shutdown.heartbeatFailed(error);
  } finally {
    await shutdown.closePool();
  }
}
