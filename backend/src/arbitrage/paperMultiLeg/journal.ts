import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { paperMultiLegHash } from "./canonical.js";
import { createPaperMultiLegInitialEvent, nextPaperMultiLegEvent, replayPaperMultiLegEvents } from "./engine.js";
import { PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN, type PaperMultiLegEvent, type PaperMultiLegPlan, type PaperMultiLegRunSummary, type PaperMultiLegState } from "./types.js";

const DEFAULT_MAX_RUNS = 10_000;

interface RunRow {
  runId: string;
  idempotencyKey: string;
  planHash: string;
  status: PaperMultiLegState["status"];
  eventCount: number;
  terminal: number;
  createdAt: number;
  updatedAt: number;
}

interface EventRow {
  eventId: string;
  runId: string;
  sequence: number;
  type: PaperMultiLegEvent["type"];
  data: string;
  ts: number;
}

export interface PaperMultiLegJournalOptions {
  maxRuns?: number;
  maxEventsPerRun?: number;
}

export interface PaperMultiLegRunView {
  state: PaperMultiLegState;
  events: PaperMultiLegEvent[];
}

/**
 * Isolated append-only SQLite journal. A hard run/event cap makes persistence
 * bounded; reaching it fails closed instead of silently deleting audit data.
 */
export class PaperMultiLegJournal {
  readonly maxRuns: number;
  readonly maxEventsPerRun: number;

  constructor(
    readonly database: DatabaseSync,
    options: PaperMultiLegJournalOptions = {}
  ) {
    this.maxRuns = boundedInteger(options.maxRuns ?? DEFAULT_MAX_RUNS, 1, 100_000, "maxRuns");
    this.maxEventsPerRun = boundedInteger(options.maxEventsPerRun ?? PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN, 20, PAPER_MULTI_LEG_MAX_EVENTS_PER_RUN, "maxEventsPerRun");
    this.initialize();
  }

  static open(path: string, options: PaperMultiLegJournalOptions = {}): PaperMultiLegJournal {
    if (!path.trim()) throw new Error("Paper multi-leg journal path is required");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    return new PaperMultiLegJournal(new DatabaseSync(path), options);
  }

  createRun(plan: PaperMultiLegPlan, idempotencyKey: string, ts: number): { created: boolean; state: PaperMultiLegState } {
    const planHash = paperMultiLegHash(plan);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.runByIdempotency(idempotencyKey);
      if (existing) {
        if (existing.planHash !== planHash) {
          throw new PaperMultiLegIdempotencyConflictError(`Paper idempotency key ${idempotencyKey} belongs to a different plan`);
        }
        const state = this.readState(existing);
        this.database.exec("COMMIT");
        return { created: false, state };
      }
      const atRunId = this.runById(plan.runId);
      if (atRunId) {
        throw new PaperMultiLegIdempotencyConflictError(`Paper run ${plan.runId} already exists with another idempotency key`);
      }
      const count = Number((this.database.prepare("SELECT COUNT(*) AS value FROM paper_multi_leg_runs").get() as { value: number }).value);
      if (count >= this.maxRuns) {
        throw new PaperMultiLegCapacityError(`Paper multi-leg journal reached its ${this.maxRuns}-run retention cap`);
      }
      const event = createPaperMultiLegInitialEvent(plan, planHash, ts);
      this.database
        .prepare(
          `INSERT INTO paper_multi_leg_runs
           (runId, idempotencyKey, planHash, status, eventCount, terminal, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
        )
        .run(plan.runId, idempotencyKey, planHash, "executing", ts, ts);
      this.insertEvent(event);
      const state = replayPaperMultiLegEvents([event], idempotencyKey);
      this.database.exec("COMMIT");
      return { created: true, state };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Appends at most one transition inside one immediate transaction. */
  advance(runId: string, ts: number): PaperMultiLegState {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.runById(runId);
      if (!row) throw new PaperMultiLegNotFoundError(`Unknown paper multi-leg run ${runId}`);
      const events = this.eventsFor(runId);
      const current = this.readState(row, events);
      const next = nextPaperMultiLegEvent(current, Math.max(ts, current.updatedAt));
      if (!next) {
        this.database.exec("COMMIT");
        return current;
      }
      if (events.length >= this.maxEventsPerRun) {
        throw new PaperMultiLegCapacityError(`Paper multi-leg run ${runId} reached its ${this.maxEventsPerRun}-event cap`);
      }
      this.insertEvent(next);
      const state = replayPaperMultiLegEvents([...events, next], row.idempotencyKey);
      this.database
        .prepare(
          `UPDATE paper_multi_leg_runs
           SET status = ?, eventCount = ?, terminal = ?, updatedAt = ?
           WHERE runId = ? AND eventCount = ?`
        )
        .run(state.status, state.lastSequence, state.terminal ? 1 : 0, state.updatedAt, runId, current.lastSequence);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): PaperMultiLegRunView | undefined {
    const row = this.runById(runId);
    if (!row) return undefined;
    const events = this.eventsFor(runId);
    return { state: this.readState(row, events), events };
  }

  getRunByIdempotency(idempotencyKey: string): PaperMultiLegRunView | undefined {
    const row = this.runByIdempotency(idempotencyKey);
    if (!row) return undefined;
    const events = this.eventsFor(row.runId);
    return { state: this.readState(row, events), events };
  }

  listRuns(limit = 50): PaperMultiLegRunSummary[] {
    const boundedLimit = boundedInteger(limit, 1, 100, "limit");
    const rows = this.database
      .prepare(
        `SELECT runId, idempotencyKey, planHash, status, eventCount, terminal, createdAt, updatedAt
         FROM paper_multi_leg_runs ORDER BY createdAt DESC, runId ASC LIMIT ?`
      )
      .all(boundedLimit) as unknown as RunRow[];
    return rows.map((row) => {
      const state = this.readState(row);
      return {
        runId: state.runId,
        sourceKind: state.plan.source.kind,
        opportunityId: state.plan.source.opportunityId,
        status: state.status,
        legCount: state.plan.legs.length,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt
      };
    });
  }

  listIncompleteRunIds(limit = 100): string[] {
    const boundedLimit = boundedInteger(limit, 1, 100, "limit");
    return (this.database.prepare("SELECT runId FROM paper_multi_leg_runs WHERE terminal = 0 ORDER BY createdAt ASC, runId ASC LIMIT ?").all(boundedLimit) as unknown as Array<{ runId: string }>).map(({ runId }) => runId);
  }

  close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA wal_autocheckpoint = 1000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS paper_multi_leg_runs (
        runId TEXT PRIMARY KEY CHECK (length(runId) BETWEEN 8 AND 160),
        idempotencyKey TEXT NOT NULL UNIQUE CHECK (length(idempotencyKey) BETWEEN 8 AND 160),
        planHash TEXT NOT NULL CHECK (length(planHash) = 64),
        status TEXT NOT NULL CHECK (status IN ('executing', 'awaiting-compensation-decision', 'compensating', 'completed', 'compensated', 'aborted-no-exposure', 'manual-review-required')),
        eventCount INTEGER NOT NULL CHECK (eventCount BETWEEN 1 AND 24),
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        createdAt INTEGER NOT NULL CHECK (createdAt > 0),
        updatedAt INTEGER NOT NULL CHECK (updatedAt >= createdAt)
      );
      CREATE TABLE IF NOT EXISTS paper_multi_leg_events (
        eventId TEXT PRIMARY KEY,
        runId TEXT NOT NULL REFERENCES paper_multi_leg_runs(runId) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 24),
        type TEXT NOT NULL CHECK (type IN ('run-created', 'original-fill', 'compensation-decision', 'compensation-fill', 'run-terminal')),
        data TEXT NOT NULL CHECK (length(data) <= 65536),
        ts INTEGER NOT NULL CHECK (ts > 0),
        UNIQUE (runId, sequence)
      );
      CREATE INDEX IF NOT EXISTS paper_multi_leg_runs_terminal_created
      ON paper_multi_leg_runs (terminal, createdAt, runId);
      CREATE TRIGGER IF NOT EXISTS paper_multi_leg_events_no_update
      BEFORE UPDATE ON paper_multi_leg_events
      BEGIN
        SELECT RAISE(ABORT, 'paper multi-leg events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS paper_multi_leg_events_no_delete
      BEFORE DELETE ON paper_multi_leg_events
      BEGIN
        SELECT RAISE(ABORT, 'paper multi-leg events are append-only');
      END;
    `);
  }

  private readState(row: RunRow, events = this.eventsFor(row.runId)): PaperMultiLegState {
    const state = replayPaperMultiLegEvents(events, row.idempotencyKey);
    if (state.planHash !== row.planHash || state.status !== row.status || state.lastSequence !== row.eventCount || Boolean(state.terminal) !== Boolean(row.terminal) || state.createdAt !== row.createdAt || state.updatedAt !== row.updatedAt) {
      throw new Error(`Paper multi-leg run index is inconsistent for ${row.runId}`);
    }
    return state;
  }

  private runById(runId: string): RunRow | undefined {
    return this.database
      .prepare(
        `SELECT runId, idempotencyKey, planHash, status, eventCount, terminal, createdAt, updatedAt
         FROM paper_multi_leg_runs WHERE runId = ?`
      )
      .get(runId) as unknown as RunRow | undefined;
  }

  private runByIdempotency(idempotencyKey: string): RunRow | undefined {
    return this.database
      .prepare(
        `SELECT runId, idempotencyKey, planHash, status, eventCount, terminal, createdAt, updatedAt
         FROM paper_multi_leg_runs WHERE idempotencyKey = ?`
      )
      .get(idempotencyKey) as unknown as RunRow | undefined;
  }

  private eventsFor(runId: string): PaperMultiLegEvent[] {
    return (
      this.database
        .prepare(
          `SELECT eventId, runId, sequence, type, data, ts
           FROM paper_multi_leg_events WHERE runId = ? ORDER BY sequence ASC`
        )
        .all(runId) as unknown as EventRow[]
    ).map((row) => ({
      eventId: row.eventId,
      runId: row.runId,
      sequence: row.sequence,
      type: row.type,
      data: parseEventData(row.data),
      ts: row.ts
    })) as PaperMultiLegEvent[];
  }

  private insertEvent(event: PaperMultiLegEvent): void {
    this.database
      .prepare(
        `INSERT INTO paper_multi_leg_events (eventId, runId, sequence, type, data, ts)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.eventId, event.runId, event.sequence, event.type, JSON.stringify(event.data), event.ts);
  }
}

export class PaperMultiLegIdempotencyConflictError extends Error {}
export class PaperMultiLegCapacityError extends Error {}
export class PaperMultiLegNotFoundError extends Error {}

function parseEventData(value: string): PaperMultiLegEvent["data"] {
  try {
    return JSON.parse(value) as PaperMultiLegEvent["data"];
  } catch {
    throw new Error("Paper multi-leg journal contains invalid JSON");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
