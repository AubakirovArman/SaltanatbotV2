import { paperMultiLegHash } from "./canonical.js";
import { PaperMultiLegIdempotencyConflictError, PaperMultiLegJournal, PaperMultiLegNotFoundError, type PaperMultiLegRunView } from "./journal.js";
import { parsePaperMultiLegIdempotencyKey, parsePaperMultiLegPlan, validatePaperMultiLegPlanAt } from "./schema.js";
import { PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN, type PaperMultiLegRecoveryStatus, type PaperMultiLegRunSummary, type PaperMultiLegState } from "./types.js";

export interface PaperMultiLegSubmission {
  created: boolean;
  run: PaperMultiLegRunView;
}

export class PaperMultiLegService {
  private recoveryStatus: PaperMultiLegRecoveryStatus = { status: "not-run", recoveredRuns: 0 };

  constructor(
    readonly journal: PaperMultiLegJournal,
    private readonly now: () => number = Date.now
  ) {}

  submitAndRun(planInput: unknown, idempotencyInput: unknown, at = this.now()): PaperMultiLegSubmission {
    const plan = parsePaperMultiLegPlan(planInput);
    const idempotencyKey = parsePaperMultiLegIdempotencyKey(idempotencyInput);
    const existing = this.journal.getRunByIdempotency(idempotencyKey);
    if (existing) {
      if (existing.state.planHash !== paperMultiLegHash(plan)) {
        throw new PaperMultiLegIdempotencyConflictError(`Paper idempotency key ${idempotencyKey} belongs to a different plan`);
      }
      return { created: false, run: this.runToTerminal(existing.state.runId, at) };
    }
    validatePaperMultiLegPlanAt(plan, at);
    const created = this.journal.createRun(plan, idempotencyKey, at);
    return { created: created.created, run: this.runToTerminal(created.state.runId, at) };
  }

  /** One durable transition, exposed for deterministic failure/restart tests. */
  advanceOne(runId: string, at = this.now()): PaperMultiLegState {
    return this.journal.advance(runId, at);
  }

  recoverIncomplete(at = this.now()): number {
    this.recoveryStatus = { status: "running", recoveredRuns: 0, startedAt: at };
    try {
      let recovered = 0;
      while (true) {
        const runIds = this.journal.listIncompleteRunIds(100);
        if (runIds.length === 0) {
          this.recoveryStatus = { status: "ready", recoveredRuns: recovered, startedAt: at, completedAt: this.now() };
          return recovered;
        }
        for (const runId of runIds) {
          this.runToTerminal(runId, at);
          recovered += 1;
        }
      }
    } catch (error) {
      this.recoveryStatus = { status: "failed", recoveredRuns: 0, startedAt: at, completedAt: this.now(), error: "recovery-failed" };
      throw error;
    }
  }

  getRecoveryStatus(): PaperMultiLegRecoveryStatus {
    return { ...this.recoveryStatus };
  }

  getRun(runId: string): PaperMultiLegRunView | undefined {
    return this.journal.getRun(runId);
  }

  listRuns(limit = 50): PaperMultiLegRunSummary[] {
    return this.journal.listRuns(limit);
  }

  private runToTerminal(runId: string, at: number): PaperMultiLegRunView {
    for (let step = 0; step < PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN; step += 1) {
      const before = this.journal.getRun(runId);
      if (!before) throw new PaperMultiLegNotFoundError(`Unknown paper multi-leg run ${runId}`);
      if (before.state.terminal) return before;
      const next = this.journal.advance(runId, Math.max(at, before.state.updatedAt));
      if (next.lastSequence <= before.state.lastSequence) {
        throw new Error(`Paper multi-leg run ${runId} made no recovery progress`);
      }
    }
    throw new Error(`Paper multi-leg run ${runId} exceeded its deterministic transition bound`);
  }
}

export function createPaperMultiLegService(path: string, options: ConstructorParameters<typeof PaperMultiLegJournal>[1] = {}, now: () => number = Date.now): PaperMultiLegService {
  return new PaperMultiLegService(PaperMultiLegJournal.open(path, options), now);
}
