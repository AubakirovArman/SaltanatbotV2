import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildOrderBookDatasetRowsV1 } from "./dataset.js";
import { extractOrderBookFeaturesV1 } from "./features.js";
import { predictOrderBookReturnV1, trainOrderBookRidgeModelV1, type OrderBookRidgeModelV1 } from "./model.js";
import { assessAndNormalizeSnapshotV1 } from "./quality.js";
import { createResearchSessionSchema, predictResearchModelSchema, trainResearchModelSchema, uploadResearchSnapshotsSchema, type CreateResearchSessionInput, type PredictResearchModelInput, type ResearchSnapshotUpload, type TrainResearchModelInput } from "./researchSchemas.js";
import type { LabelPolicyV1, NormalizedL2SnapshotV1, SequencedL2SnapshotV1, SnapshotQualityPolicyV1 } from "./types.js";

export const ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1 = "orderbook-ml-research-api-v1" as const;
export const DEFAULT_MAX_RESEARCH_SESSIONS = 4;
export const DEFAULT_MAX_RESEARCH_SNAPSHOTS = 2_000;
export const DEFAULT_MAX_RESEARCH_MODELS = 3;
export const DEFAULT_RESEARCH_SESSION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_RESEARCH_OPERATION_BUDGET_MS = 2_000;

const EXECUTION_BOUNDARY = {
  researchOnly: true,
  paperOrders: false,
  liveOrders: false
} as const;

const ONLINE_CAPTURE = {
  available: false,
  mode: "upload-only",
  reason: "The public order-book hub publishes throttled partial depth without verified reconstruction continuity; it is not a valid ML capture source."
} as const;

export interface OrderBookMlResearchServiceOptions {
  clock?: () => number;
  monotonicClock?: () => number;
  maxSessions?: number;
  maxSnapshotsPerSession?: number;
  maxModelsPerSession?: number;
  sessionTtlMs?: number;
  operationBudgetMs?: number;
}

interface QualityCounters {
  submittedSnapshots: number;
  acceptedSnapshots: number;
  rejectedSnapshots: number;
  discardedSnapshots: number;
  acceptedBatches: number;
  rejectedBatches: number;
  issuesByCode: Record<string, number>;
}

interface PredictionCounters {
  attempted: number;
  accepted: number;
  rejected: number;
}

interface DatasetSummary {
  builtAt: number;
  rows: number;
  horizonMs: number;
}

interface ResearchSession {
  id: string;
  name?: string;
  createdAt: number;
  expiresAt: number;
  qualityPolicy: SnapshotQualityPolicyV1;
  labelPolicy: LabelPolicyV1;
  snapshots: NormalizedL2SnapshotV1[];
  lastRaw?: SequencedL2SnapshotV1;
  models: Map<string, OrderBookRidgeModelV1>;
  quality: QualityCounters;
  predictions: PredictionCounters;
  lastDataset?: DatasetSummary;
}

export class OrderBookMlResearchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "OrderBookMlResearchError";
  }
}

/** Bounded, in-memory and deliberately disconnected from every order path. */
export class OrderBookMlResearchService {
  private readonly sessions = new Map<string, ResearchSession>();
  private readonly clock: () => number;
  private readonly monotonicClock: () => number;
  readonly limits: Readonly<Required<Omit<OrderBookMlResearchServiceOptions, "clock" | "monotonicClock">>>;

  constructor(options: OrderBookMlResearchServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? performance.now.bind(performance);
    this.limits = {
      maxSessions: boundedInteger(options.maxSessions, DEFAULT_MAX_RESEARCH_SESSIONS, 1, 32, "maxSessions"),
      maxSnapshotsPerSession: boundedInteger(options.maxSnapshotsPerSession, DEFAULT_MAX_RESEARCH_SNAPSHOTS, 90, 10_000, "maxSnapshotsPerSession"),
      maxModelsPerSession: boundedInteger(options.maxModelsPerSession, DEFAULT_MAX_RESEARCH_MODELS, 1, 10, "maxModelsPerSession"),
      sessionTtlMs: boundedInteger(options.sessionTtlMs, DEFAULT_RESEARCH_SESSION_TTL_MS, 60_000, 24 * 60 * 60 * 1_000, "sessionTtlMs"),
      operationBudgetMs: boundedInteger(options.operationBudgetMs, DEFAULT_RESEARCH_OPERATION_BUDGET_MS, 100, 30_000, "operationBudgetMs")
    };
  }

  health() {
    this.pruneExpired();
    return {
      schemaVersion: ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1,
      ok: true,
      service: "order-book-ml-research",
      storage: "bounded-ephemeral-memory",
      rawDataPersistence: false,
      onlineCapture: ONLINE_CAPTURE,
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false,
      probabilitiesProduced: false,
      executionBoundary: EXECUTION_BOUNDARY,
      limits: { ...this.limits },
      registry: {
        sessions: this.sessions.size,
        snapshots: [...this.sessions.values()].reduce((sum, session) => sum + session.snapshots.length, 0),
        models: [...this.sessions.values()].reduce((sum, session) => sum + session.models.size, 0)
      }
    };
  }

  listSessions() {
    this.pruneExpired();
    return [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)).map((session) => this.describeSession(session));
  }

  createSession(input: CreateResearchSessionInput) {
    const parsed = createResearchSessionSchema.parse(input);
    this.pruneExpired();
    if (this.sessions.size >= this.limits.maxSessions) {
      throw new OrderBookMlResearchError("Research session capacity is exhausted; delete or wait for an existing session to expire.", 429, "session-capacity");
    }
    const now = this.now();
    const session: ResearchSession = {
      id: randomUUID(),
      ...(parsed.name ? { name: parsed.name } : {}),
      createdAt: now,
      expiresAt: now + this.limits.sessionTtlMs,
      qualityPolicy: { ...parsed.qualityPolicy },
      labelPolicy: { horizonsMs: [...parsed.labelPolicy.horizonsMs], maximumAlignmentDelayMs: parsed.labelPolicy.maximumAlignmentDelayMs },
      snapshots: [],
      models: new Map(),
      quality: emptyQualityCounters(),
      predictions: { attempted: 0, accepted: 0, rejected: 0 }
    };
    this.sessions.set(session.id, session);
    return this.describeSession(session);
  }

  getSession(sessionId: string) {
    return this.describeSession(this.requireSession(sessionId));
  }

  deleteSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    this.sessions.delete(session.id);
    return { deleted: true, sessionId: session.id, ephemeralArtifactsDeleted: session.models.size };
  }

  ingest(sessionId: string, input: readonly ResearchSnapshotUpload[]) {
    const parsed = uploadResearchSnapshotsSchema.parse({ snapshots: input }).snapshots;
    const session = this.requireSession(sessionId);
    if (session.snapshots.length + parsed.length > this.limits.maxSnapshotsPerSession) {
      throw new OrderBookMlResearchError(`Session snapshot capacity ${this.limits.maxSnapshotsPerSession} would be exceeded.`, 413, "snapshot-capacity");
    }
    const deadline = this.deadline();
    session.quality.submittedSnapshots += parsed.length;
    const normalized: NormalizedL2SnapshotV1[] = [];
    let previous = session.lastRaw;
    let rejectionRecorded = false;
    const recordRejection = (issues: readonly { code: string }[]) => {
      if (rejectionRecorded) return;
      recordRejectedBatch(session.quality, parsed.length, issues);
      rejectionRecorded = true;
    };
    try {
      for (let index = 0; index < parsed.length; index += 1) {
        this.assertWithinBudget(deadline);
        const raw = cloneRawSnapshot(parsed[index]!);
        const serverNow = this.now();
        if (raw.receivedAt > serverNow + session.qualityPolicy.maximumFutureSkewMs || raw.exchangeTs > serverNow + session.qualityPolicy.maximumFutureSkewMs) {
          const issues = [{ code: "timestamp-future", message: "uploaded capture timestamp exceeds the server's configured future-skew allowance" }] as const;
          recordRejection(issues);
          throw new OrderBookMlResearchError(`Snapshot ${index} failed sequenced L2 quality validation.`, 422, "snapshot-quality", { index, issues });
        }
        const assessment = assessAndNormalizeSnapshotV1(raw, {
          // Offline upload validates freshness at capture time. It does not claim
          // that historical data is currently fresh.
          now: raw.receivedAt,
          policy: session.qualityPolicy,
          ...(previous ? { previous } : {})
        });
        if (!assessment.accepted) {
          recordRejection(assessment.issues);
          throw new OrderBookMlResearchError(`Snapshot ${index} failed sequenced L2 quality validation.`, 422, "snapshot-quality", { index, issues: assessment.issues });
        }
        normalized.push(assessment.snapshot);
        previous = raw;
      }
      this.assertWithinBudget(deadline);
    } catch (error) {
      const code = error instanceof OrderBookMlResearchError ? error.code : "ingest-processing-error";
      recordRejection([{ code }]);
      throw error;
    }
    session.snapshots.push(...normalized);
    session.lastRaw = previous;
    session.quality.acceptedSnapshots += normalized.length;
    session.quality.acceptedBatches += 1;
    return {
      accepted: normalized.length,
      totalSnapshots: session.snapshots.length,
      firstAcceptedSequence: normalized[0]!.sequence,
      lastAcceptedSequence: normalized.at(-1)!.sequence,
      quality: cloneQuality(session.quality)
    };
  }

  train(sessionId: string, input: TrainResearchModelInput) {
    const parsed = trainResearchModelSchema.parse(input);
    const session = this.requireSession(sessionId);
    if (!session.labelPolicy.horizonsMs.includes(parsed.horizonMs)) {
      throw new OrderBookMlResearchError("Requested horizon is not configured for this session.", 409, "horizon-not-configured");
    }
    const deadline = this.deadline();
    const rows = buildOrderBookDatasetRowsV1({
      snapshots: session.snapshots,
      labelPolicy: session.labelPolicy,
      requireAllHorizons: false
    });
    this.assertWithinBudget(deadline);
    const result = trainOrderBookRidgeModelV1(rows, {
      horizonMs: parsed.horizonMs,
      trainedAt: this.now(),
      minimumRowsPerSplit: parsed.minimumRowsPerSplit,
      maximumRows: this.limits.maxSnapshotsPerSession,
      ...(parsed.ridgeLambda === undefined ? {} : { ridgeLambda: parsed.ridgeLambda }),
      ...(parsed.trainFraction === undefined ? {} : { trainFraction: parsed.trainFraction }),
      ...(parsed.validationFraction === undefined ? {} : { validationFraction: parsed.validationFraction }),
      ...(parsed.flatThresholdBps === undefined ? {} : { flatThresholdBps: parsed.flatThresholdBps }),
      ...(parsed.outOfDistributionZScore === undefined ? {} : { outOfDistributionZScore: parsed.outOfDistributionZScore })
    });
    this.assertWithinBudget(deadline);
    if (!session.models.has(result.model.modelId) && session.models.size >= this.limits.maxModelsPerSession) {
      throw new OrderBookMlResearchError("Research model capacity is exhausted for this session.", 409, "model-capacity");
    }
    session.models.set(result.model.modelId, structuredClone(result.model));
    session.lastDataset = { builtAt: this.now(), rows: rows.length, horizonMs: parsed.horizonMs };
    return {
      model: structuredClone(result.model),
      dataset: { ...session.lastDataset },
      split: {
        trainRows: result.split.train.length,
        validationRows: result.split.validation.length,
        testRows: result.split.test.length,
        excludedMissingLabel: result.split.excludedMissingLabel,
        purgedTrainRows: result.split.purgedTrainRows,
        purgedValidationRows: result.split.purgedValidationRows,
        validationStartsAt: result.split.validationStartsAt,
        testStartsAt: result.split.testStartsAt
      }
    };
  }

  getModel(sessionId: string, modelId: string) {
    const session = this.requireSession(sessionId);
    const model = session.models.get(modelId);
    if (!model) throw new OrderBookMlResearchError("Research model was not found in this session.", 404, "model-not-found");
    return structuredClone(model);
  }

  predict(sessionId: string, input: PredictResearchModelInput) {
    const parsed = predictResearchModelSchema.parse(input);
    const session = this.requireSession(sessionId);
    const model = session.models.get(parsed.modelId);
    if (!model) throw new OrderBookMlResearchError("Research model was not found in this session.", 404, "model-not-found");
    session.predictions.attempted += 1;
    const deadline = this.deadline();
    const normalized: NormalizedL2SnapshotV1[] = [];
    let previous: SequencedL2SnapshotV1 | undefined;
    try {
      for (const candidate of parsed.snapshots) {
        this.assertWithinBudget(deadline);
        const raw = cloneRawSnapshot(candidate);
        const assessment = assessAndNormalizeSnapshotV1(raw, {
          now: this.now(),
          policy: session.qualityPolicy,
          ...(previous ? { previous } : {})
        });
        if (!assessment.accepted) {
          throw new OrderBookMlResearchError("Inference snapshot failed current-time quality validation.", 422, "inference-quality", { issues: assessment.issues });
        }
        normalized.push(assessment.snapshot);
        previous = raw;
      }
      const current = normalized.at(-1)!;
      const predecessor = normalized.length === 2 ? normalized[0] : undefined;
      const features = extractOrderBookFeaturesV1({ current, ...(predecessor ? { previous: predecessor } : {}) });
      const prediction = predictOrderBookReturnV1(model, { snapshot: current, features });
      this.assertWithinBudget(deadline);
      session.predictions.accepted += 1;
      return {
        prediction,
        provenance: {
          captureMode: "caller-uploaded-fresh-sequenced-l2",
          snapshots: normalized.length,
          featureSchemaVersion: features.schemaVersion,
          normalizerVersion: current.normalizerVersion,
          qualityEvaluatedAt: current.quality.evaluatedAt
        }
      };
    } catch (error) {
      session.predictions.rejected += 1;
      throw error;
    }
  }

  private describeSession(session: ResearchSession) {
    const first = session.snapshots[0];
    const last = session.snapshots.at(-1);
    return {
      schemaVersion: ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1,
      id: session.id,
      ...(session.name ? { name: session.name } : {}),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      storage: "bounded-ephemeral-memory",
      rawDataPersistence: false,
      captureMode: "uploaded-sequenced-l2",
      onlineCapture: ONLINE_CAPTURE,
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false,
      probabilitiesProduced: false,
      executionBoundary: EXECUTION_BOUNDARY,
      qualityPolicy: { ...session.qualityPolicy },
      labelPolicy: { horizonsMs: [...session.labelPolicy.horizonsMs], maximumAlignmentDelayMs: session.labelPolicy.maximumAlignmentDelayMs },
      quality: cloneQuality(session.quality),
      predictions: { ...session.predictions },
      snapshotCount: session.snapshots.length,
      provenance:
        first && last
          ? {
              venue: first.venue,
              market: first.market,
              instrumentId: first.instrumentId,
              symbol: first.symbol,
              normalizerVersion: first.normalizerVersion,
              connectionGeneration: first.connectionGeneration,
              firstSequence: first.sequence,
              lastSequence: last.sequence,
              firstExchangeTs: first.exchangeTs,
              lastExchangeTs: last.exchangeTs,
              exchangeTimestampSource: first.exchangeTimestampSource,
              checksumVerifiedForEverySnapshot: session.snapshots.every((snapshot) => snapshot.checksumVerified === true)
            }
          : null,
      dataset: session.lastDataset ? { ...session.lastDataset } : null,
      models: [...session.models.values()].map(modelSummary)
    };
  }

  private requireSession(sessionId: string) {
    this.pruneExpired();
    const session = this.sessions.get(sessionId);
    if (!session) throw new OrderBookMlResearchError("Research session was not found or has expired.", 404, "session-not-found");
    return session;
  }

  private pruneExpired() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Research service clock must return a positive safe integer");
    return value;
  }

  private deadline() {
    return this.monotonicClock() + this.limits.operationBudgetMs;
  }

  private assertWithinBudget(deadline: number) {
    if (this.monotonicClock() > deadline) {
      throw new OrderBookMlResearchError("Research operation exceeded its bounded processing budget.", 503, "operation-budget-exceeded");
    }
  }
}

function emptyQualityCounters(): QualityCounters {
  return {
    submittedSnapshots: 0,
    acceptedSnapshots: 0,
    rejectedSnapshots: 0,
    discardedSnapshots: 0,
    acceptedBatches: 0,
    rejectedBatches: 0,
    issuesByCode: {}
  };
}

function recordRejectedBatch(counters: QualityCounters, batchSize: number, issues: readonly { code: string }[]) {
  counters.rejectedSnapshots += 1;
  counters.discardedSnapshots += Math.max(0, batchSize - 1);
  counters.rejectedBatches += 1;
  for (const issue of issues) counters.issuesByCode[issue.code] = (counters.issuesByCode[issue.code] ?? 0) + 1;
}

function cloneQuality(value: QualityCounters): QualityCounters {
  return { ...value, issuesByCode: { ...value.issuesByCode } };
}

function cloneRawSnapshot(snapshot: ResearchSnapshotUpload): SequencedL2SnapshotV1 {
  return {
    ...snapshot,
    bids: snapshot.bids.map(([price, quantity]) => [price, quantity] as const),
    asks: snapshot.asks.map(([price, quantity]) => [price, quantity] as const)
  };
}

function modelSummary(model: OrderBookRidgeModelV1) {
  return {
    modelId: model.modelId,
    schemaVersion: model.schemaVersion,
    algorithm: model.algorithm,
    target: { ...model.target },
    trainedAt: model.trainedAt,
    trainingWindow: { ...model.trainingWindow, connectionGenerations: [...model.trainingWindow.connectionGenerations] },
    metrics: structuredClone(model.metrics),
    executionBoundary: { ...model.executionBoundary }
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be within ${minimum}..${maximum}`);
  }
  return resolved;
}
