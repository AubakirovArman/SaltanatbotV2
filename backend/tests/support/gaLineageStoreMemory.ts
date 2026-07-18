import {
  GaCandidateNotFoundError,
  GaPromotionOverfitError,
  GaPromotionRequiresOosError,
  GaRunActiveError,
  isOverfitReport,
  type GaCandidateRecord,
  type GaEvolutionLineageStore,
  type GaNewCandidateInput,
  type GaRunRecord,
  type GaRunStatus
} from "../../src/ga/repository.js";

/**
 * In-memory GaEvolutionLineageStore double mirroring the PostgreSQL
 * repository semantics the GA suites depend on: the one-active-run-per-owner
 * unique index (GaRunActiveError), the atomic checkpointed→running resume
 * claim, (generation ASC, fingerprint ASC) candidate ordering, COALESCE
 * checkpoint/pareto on finishRun and the clean-OOS promotion gate. Timestamps
 * are pinned so two independent stores fed identical inputs produce
 * byte-identical rows — the seeded-reproducibility comparisons rely on it.
 */

const FIXED_TIMESTAMP = "2026-07-18T00:00:00.000Z";

export interface MemoryGaLineageStoreOptions {
  /** Mirrors the compute_jobs EXISTS probe of failOrphanedRuns; defaults to "driving job still active". */
  isJobActive?: (jobId: string | undefined) => boolean;
}

export class MemoryGaLineageStore implements GaEvolutionLineageStore {
  private readonly runs = new Map<string, GaRunRecord>();
  private readonly candidates = new Map<string, GaCandidateRecord>();
  private readonly isJobActive: (jobId: string | undefined) => boolean;

  constructor(options: MemoryGaLineageStoreOptions = {}) {
    this.isJobActive = options.isJobActive ?? (() => true);
  }

  /** Test seam: install a run row directly (e.g. a synthetic checkpointed run). */
  seedRun(record: GaRunRecord): void {
    this.runs.set(record.id, clone(record));
  }

  /** Test seam: install a candidate row directly (e.g. one without an OOS report). */
  seedCandidate(record: GaCandidateRecord): void {
    this.candidates.set(candidateKey(record.runId, record.fingerprint), clone(record));
  }

  /** Test seam: every candidate row across all runs in storage order for equality checks. */
  allCandidateRows(): GaCandidateRecord[] {
    return [...this.candidates.values()].map(clone).sort(byGenerationThenFingerprint);
  }

  /** Test seam: raw run row incl. checkpoint, without owner scoping. */
  runSnapshot(runId: string): GaRunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async failOrphanedRuns(ownerUserId: string): Promise<number> {
    let failed = 0;
    for (const run of this.runs.values()) {
      if (run.ownerUserId === ownerUserId && run.status === "running" && !this.isJobActive(run.jobId)) {
        run.status = "failed";
        failed += 1;
      }
    }
    return failed;
  }

  async hasActiveRun(ownerUserId: string): Promise<boolean> {
    return [...this.runs.values()].some((run) => run.ownerUserId === ownerUserId && run.status === "running");
  }

  async findRunByJobId(ownerUserId: string, jobId: string): Promise<GaRunRecord | undefined> {
    const run = [...this.runs.values()].find((entry) => entry.ownerUserId === ownerUserId && entry.jobId === jobId);
    return run ? clone(run) : undefined;
  }

  async getRun(ownerUserId: string, runId: string): Promise<GaRunRecord | undefined> {
    const run = this.runs.get(runId);
    return run && run.ownerUserId === ownerUserId ? clone(run) : undefined;
  }

  async createRun(input: {
    id: string;
    ownerUserId: string;
    jobId: string;
    config: Record<string, unknown>;
    seed: number;
    engineVersion: string;
    generatorVersion: string;
  }): Promise<GaRunRecord> {
    if (await this.hasActiveRun(input.ownerUserId)) {
      throw new GaRunActiveError("Another GA evolution run is already active for this owner.");
    }
    const run: GaRunRecord = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      jobId: input.jobId,
      status: "running",
      config: clone(input.config),
      seed: input.seed,
      engineVersion: input.engineVersion,
      generatorVersion: input.generatorVersion,
      currentGeneration: 0,
      createdAt: FIXED_TIMESTAMP,
      updatedAt: FIXED_TIMESTAMP
    };
    this.runs.set(run.id, run);
    return clone(run);
  }

  async claimResume(ownerUserId: string, runId: string, jobId: string): Promise<GaRunRecord | undefined> {
    const run = this.runs.get(runId);
    if (!run || run.ownerUserId !== ownerUserId || run.status !== "checkpointed") return undefined;
    if (await this.hasActiveRun(ownerUserId)) {
      throw new GaRunActiveError("Another GA evolution run is already active for this owner.");
    }
    run.status = "running";
    run.jobId = jobId;
    return clone(run);
  }

  async setDatasetFingerprint(runId: string, fingerprint: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run && run.datasetFingerprint === undefined) run.datasetFingerprint = fingerprint;
  }

  async restoreObjectives(runId: string): Promise<{ fingerprint: string; generation: number; objectives: Record<string, number>; oosReport?: Record<string, unknown> }[]> {
    return this.rowsOf(runId).map((row) => ({
      fingerprint: row.fingerprint,
      generation: row.generation,
      objectives: clone(row.objectives),
      ...(row.oosReport ? { oosReport: clone(row.oosReport) } : {})
    }));
  }

  async recordGeneration(
    runId: string,
    input: {
      generation: number;
      candidates: readonly GaNewCandidateInput[];
      paretoRanks: ReadonlyMap<string, number>;
      pareto: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
    }
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown GA run ${runId}`);
    for (const candidate of input.candidates) {
      const key = candidateKey(runId, candidate.fingerprint);
      if (this.candidates.has(key)) throw new Error(`Duplicate GA candidate ${candidate.fingerprint}`);
      this.candidates.set(key, {
        runId,
        fingerprint: candidate.fingerprint,
        generation: candidate.generation,
        parentFingerprints: clone(candidate.parentFingerprints),
        mutationLog: clone(candidate.mutationLog),
        ir: clone(candidate.ir),
        metrics: clone(candidate.metrics),
        objectives: clone(candidate.objectives),
        oosReport: clone(candidate.oosReport),
        createdAt: FIXED_TIMESTAMP
      });
    }
    for (const [fingerprint, rank] of input.paretoRanks) {
      const row = this.candidates.get(candidateKey(runId, fingerprint));
      if (row) row.paretoRank = rank;
    }
    run.currentGeneration = input.generation;
    run.pareto = clone(input.pareto);
    run.checkpoint = clone(input.checkpoint);
  }

  async finishRun(
    runId: string,
    input: { status: Exclude<GaRunStatus, "running">; checkpoint?: Record<string, unknown>; pareto?: Record<string, unknown> }
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = input.status;
    if (input.checkpoint) run.checkpoint = clone(input.checkpoint);
    if (input.pareto) run.pareto = clone(input.pareto);
  }

  async listRuns(ownerUserId: string, limit: number): Promise<GaRunRecord[]> {
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    return [...this.runs.values()]
      .filter((run) => run.ownerUserId === ownerUserId)
      .reverse()
      .slice(0, bounded)
      .map((run) => {
        const { checkpoint: _checkpoint, ...listed } = clone(run);
        return listed;
      });
  }

  async listCandidates(ownerUserId: string, runId: string, options: { generation?: number; limit: number }): Promise<GaCandidateRecord[]> {
    if (!(await this.getRun(ownerUserId, runId))) return [];
    const bounded = Math.max(1, Math.min(100, Math.floor(options.limit)));
    return this.rowsOf(runId)
      .filter((row) => options.generation === undefined || row.generation === options.generation)
      .slice(0, bounded)
      .map(clone);
  }

  async getCandidate(ownerUserId: string, runId: string, fingerprint: string): Promise<GaCandidateRecord | undefined> {
    if (!(await this.getRun(ownerUserId, runId))) return undefined;
    const row = this.candidates.get(candidateKey(runId, fingerprint));
    return row ? clone(row) : undefined;
  }

  async getLineage(ownerUserId: string, runId: string): Promise<Pick<GaCandidateRecord, "fingerprint" | "generation" | "parentFingerprints" | "mutationLog">[]> {
    if (!(await this.getRun(ownerUserId, runId))) return [];
    return this.rowsOf(runId).map((row) => ({
      fingerprint: row.fingerprint,
      generation: row.generation,
      parentFingerprints: clone(row.parentFingerprints),
      mutationLog: clone(row.mutationLog)
    }));
  }

  async promote(ownerUserId: string, runId: string, fingerprint: string, promotedAt: number): Promise<GaCandidateRecord> {
    if (!(await this.getRun(ownerUserId, runId))) throw new GaCandidateNotFoundError("GA candidate not found.");
    const row = this.candidates.get(candidateKey(runId, fingerprint));
    if (!row) throw new GaCandidateNotFoundError("GA candidate not found.");
    if (!row.oosReport) throw new GaPromotionRequiresOosError("Promotion requires an out-of-sample report.");
    if (isOverfitReport(row.oosReport)) {
      throw new GaPromotionOverfitError("Promotion refused: the candidate is flagged as overfit out of sample.");
    }
    row.promotedAt = row.promotedAt ?? promotedAt;
    return clone(row);
  }

  private rowsOf(runId: string): GaCandidateRecord[] {
    return [...this.candidates.values()].filter((row) => row.runId === runId).sort(byGenerationThenFingerprint);
  }
}

function candidateKey(runId: string, fingerprint: string): string {
  return `${runId}\n${fingerprint}`;
}

function byGenerationThenFingerprint(left: GaCandidateRecord, right: GaCandidateRecord): number {
  return left.generation - right.generation || (left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0);
}

/** JSONB round-trip semantics: drops undefined, breaks aliasing between caller and storage. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
