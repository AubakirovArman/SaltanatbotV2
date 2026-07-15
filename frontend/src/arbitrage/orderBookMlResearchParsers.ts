import {
  ORDER_BOOK_ML_RESEARCH_SCHEMA,
  ORDER_BOOK_QUALITY_POLICY_SCHEMA,
  SEQUENCED_L2_SNAPSHOT_SCHEMA,
  type ResearchExecutionBoundary,
  type ResearchHealth,
  type ResearchModelMetrics,
  type ResearchModelSummary,
  type ResearchOnlineCapture,
  type ResearchPredictionResult,
  type ResearchQualityCounters,
  type ResearchSession,
  type ResearchSessionProvenance,
  type ResearchSplitSummary,
  type ResearchStatus,
  type ResearchTrainingResult,
  type ResearchTrainingWindow,
  type SequencedL2SnapshotInput
} from "./orderBookMlResearchTypes";

export const MAX_RESEARCH_JSON_CHARACTERS = 900_000;
export const MAX_RESEARCH_UPLOAD_SNAPSHOTS = 250;

const ENVELOPE_KEYS = ["schemaVersion", "researchOnly", "participantIdentityInferred", "probabilitiesProduced", "executionBoundary"] as const;
const BOUNDARY_KEYS = ["researchOnly", "paperOrders", "liveOrders"] as const;

export interface ResearchIngestResult {
  accepted: number;
  totalSnapshots: number;
  firstAcceptedSequence: number;
  lastAcceptedSequence: number;
  quality: ResearchQualityCounters;
}

export interface ResearchDeleteResult {
  deleted: true;
  sessionId: string;
  ephemeralArtifactsDeleted: number;
}

export function parseResearchHealthResponse(value: unknown): ResearchHealth {
  return health(value, "health response");
}

export function parseResearchStatusResponse(value: unknown): ResearchStatus {
  const response = envelope(value, "status response", ["health", "sessions"]);
  const parsed = { health: health(response.health, "status response.health"), sessions: sessions(response.sessions, "status response.sessions") };
  if (parsed.health.registry.sessions !== parsed.sessions.length || parsed.health.registry.snapshots !== parsed.sessions.reduce((sum, entry) => sum + entry.snapshotCount, 0) || parsed.health.registry.models !== parsed.sessions.reduce((sum, entry) => sum + entry.models.length, 0)) {
    fail("status response registry totals do not match its sessions");
  }
  return parsed;
}

export function parseResearchSessionsResponse(value: unknown): ResearchSession[] {
  const response = envelope(value, "sessions response", ["sessions"]);
  return sessions(response.sessions, "sessions response.sessions");
}

export function parseResearchSessionResponse(value: unknown): ResearchSession {
  const response = envelope(value, "session response", ["session"]);
  return session(response.session, "session response.session");
}

export function parseResearchDeleteResponse(value: unknown): ResearchDeleteResult {
  const response = envelope(value, "delete response", ["deleted", "sessionId", "ephemeralArtifactsDeleted"]);
  literal(response.deleted, true, "delete response.deleted");
  return {
    deleted: true,
    sessionId: uuid(response.sessionId, "delete response.sessionId"),
    ephemeralArtifactsDeleted: integer(response.ephemeralArtifactsDeleted, "delete response.ephemeralArtifactsDeleted", 0)
  };
}

export function parseResearchIngestResponse(value: unknown): ResearchIngestResult {
  const response = envelope(value, "ingest response", ["ingest"]);
  const ingest = object(response.ingest, "ingest response.ingest", ["accepted", "totalSnapshots", "firstAcceptedSequence", "lastAcceptedSequence", "quality"]);
  return {
    accepted: integer(ingest.accepted, "ingest response.ingest.accepted", 1),
    totalSnapshots: integer(ingest.totalSnapshots, "ingest response.ingest.totalSnapshots", 1),
    firstAcceptedSequence: integer(ingest.firstAcceptedSequence, "ingest response.ingest.firstAcceptedSequence", 0),
    lastAcceptedSequence: integer(ingest.lastAcceptedSequence, "ingest response.ingest.lastAcceptedSequence", 0),
    quality: quality(ingest.quality, "ingest response.ingest.quality")
  };
}

export function parseResearchTrainingResponse(value: unknown): ResearchTrainingResult {
  const response = envelope(value, "training response", ["model", "dataset", "split"]);
  return {
    model: modelArtifact(response.model, "training response.model"),
    dataset: dataset(response.dataset, "training response.dataset"),
    split: split(response.split, "training response.split")
  };
}

export function parseResearchModelResponse(value: unknown): ResearchModelSummary {
  const response = envelope(value, "model response", ["model"]);
  return modelArtifact(response.model, "model response.model");
}

export function parseResearchPredictionResponse(value: unknown): ResearchPredictionResult {
  const response = envelope(value, "prediction response", ["prediction", "provenance"]);
  const prediction = object(response.prediction, "prediction response.prediction", [
    "schemaVersion",
    "modelId",
    "instrumentId",
    "symbol",
    "horizonMs",
    "anchorSequence",
    "anchorExchangeTs",
    "predictedReturnBps",
    "direction",
    "signalToNoise",
    "distribution",
    "contributions",
    "behaviorScope",
    "participantIdentityInferred",
    "executionBoundary"
  ]);
  literal(prediction.schemaVersion, "orderbook-prediction-v1", "prediction response.prediction.schemaVersion");
  literal(prediction.behaviorScope, "anonymous-aggregate-liquidity", "prediction response.prediction.behaviorScope");
  literal(prediction.participantIdentityInferred, false, "prediction response.prediction.participantIdentityInferred");
  const direction = oneOf(prediction.direction, ["up", "down", "flat"] as const, "prediction response.prediction.direction");
  const distribution = object(prediction.distribution, "prediction response.prediction.distribution", ["status", "maximumAbsoluteZScore", "threshold"]);
  const distributionStatus = oneOf(distribution.status, ["within-training-range", "out-of-distribution"] as const, "prediction response.prediction.distribution.status");
  const contributions = array(prediction.contributions, "prediction response.prediction.contributions").map((value, index) => {
    const item = object(value, `prediction response.prediction.contributions[${index}]`, ["feature", "standardizedValue", "contributionBps"]);
    return { feature: text(item.feature, `${index}.feature`), standardizedValue: finite(item.standardizedValue, `${index}.standardizedValue`), contributionBps: finite(item.contributionBps, `${index}.contributionBps`) };
  });
  if (contributions.length > 5) fail("prediction response.prediction.contributions must contain at most 5 entries");
  const provenance = object(response.provenance, "prediction response.provenance", ["captureMode", "snapshots", "featureSchemaVersion", "normalizerVersion", "qualityEvaluatedAt"]);
  literal(provenance.captureMode, "caller-uploaded-fresh-sequenced-l2", "prediction response.provenance.captureMode");
  literal(provenance.featureSchemaVersion, "orderbook-feature-v1", "prediction response.provenance.featureSchemaVersion");
  const maximumAbsoluteZScore = finite(distribution.maximumAbsoluteZScore, "prediction response.prediction.distribution.maximumAbsoluteZScore", 0);
  const distributionThreshold = finite(distribution.threshold, "prediction response.prediction.distribution.threshold", 1);
  if (maximumAbsoluteZScore > distributionThreshold !== (distributionStatus === "out-of-distribution")) fail("prediction response.prediction.distribution status is inconsistent with its z-score");
  return {
    prediction: {
      schemaVersion: "orderbook-prediction-v1",
      modelId: modelId(prediction.modelId, "prediction response.prediction.modelId"),
      instrumentId: text(prediction.instrumentId, "prediction response.prediction.instrumentId"),
      symbol: text(prediction.symbol, "prediction response.prediction.symbol"),
      horizonMs: integer(prediction.horizonMs, "prediction response.prediction.horizonMs", 1),
      anchorSequence: integer(prediction.anchorSequence, "prediction response.prediction.anchorSequence", 0),
      anchorExchangeTs: integer(prediction.anchorExchangeTs, "prediction response.prediction.anchorExchangeTs", 1),
      predictedReturnBps: finite(prediction.predictedReturnBps, "prediction response.prediction.predictedReturnBps"),
      direction,
      signalToNoise: finite(prediction.signalToNoise, "prediction response.prediction.signalToNoise", 0),
      distribution: {
        status: distributionStatus,
        maximumAbsoluteZScore,
        threshold: distributionThreshold
      },
      contributions,
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false,
      executionBoundary: executionBoundary(prediction.executionBoundary, "prediction response.prediction.executionBoundary")
    },
    provenance: {
      captureMode: "caller-uploaded-fresh-sequenced-l2",
      snapshots: integer(provenance.snapshots, "prediction response.provenance.snapshots", 1, 2),
      featureSchemaVersion: "orderbook-feature-v1",
      normalizerVersion: text(provenance.normalizerVersion, "prediction response.provenance.normalizerVersion"),
      qualityEvaluatedAt: integer(provenance.qualityEvaluatedAt, "prediction response.provenance.qualityEvaluatedAt", 1)
    }
  };
}

export function parseResearchSnapshotBatchJson(source: string, maximum = MAX_RESEARCH_UPLOAD_SNAPSHOTS): SequencedL2SnapshotInput[] {
  if (!source.trim()) fail("snapshot JSON is required");
  if (source.length > MAX_RESEARCH_JSON_CHARACTERS) fail(`snapshot JSON exceeds ${MAX_RESEARCH_JSON_CHARACTERS} characters`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    fail("snapshot JSON is invalid");
  }
  if (!Array.isArray(decoded)) {
    const payload = object(decoded, "snapshot payload", ["snapshots"]);
    decoded = payload.snapshots;
  }
  const values = array(decoded, "snapshot payload.snapshots");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RESEARCH_UPLOAD_SNAPSHOTS) fail("snapshot parser maximum is invalid");
  if (values.length < 1 || values.length > maximum) fail(`snapshot payload must contain 1..${maximum} snapshots`);
  return values.map((value, index) => snapshot(value, `snapshot payload.snapshots[${index}]`));
}

function health(value: unknown, path: string): ResearchHealth {
  const item = object(value, path, ["schemaVersion", "ok", "service", "storage", "rawDataPersistence", "onlineCapture", "behaviorScope", "participantIdentityInferred", "probabilitiesProduced", "executionBoundary", "limits", "registry"]);
  literal(item.schemaVersion, ORDER_BOOK_ML_RESEARCH_SCHEMA, `${path}.schemaVersion`);
  literal(item.ok, true, `${path}.ok`);
  literal(item.service, "order-book-ml-research", `${path}.service`);
  literal(item.storage, "bounded-ephemeral-memory", `${path}.storage`);
  literal(item.rawDataPersistence, false, `${path}.rawDataPersistence`);
  literal(item.behaviorScope, "anonymous-aggregate-liquidity", `${path}.behaviorScope`);
  literal(item.participantIdentityInferred, false, `${path}.participantIdentityInferred`);
  literal(item.probabilitiesProduced, false, `${path}.probabilitiesProduced`);
  const limits = object(item.limits, `${path}.limits`, ["maxSessions", "maxSnapshotsPerSession", "maxModelsPerSession", "sessionTtlMs", "operationBudgetMs"]);
  const registry = object(item.registry, `${path}.registry`, ["sessions", "snapshots", "models"]);
  return {
    schemaVersion: ORDER_BOOK_ML_RESEARCH_SCHEMA,
    ok: true,
    service: "order-book-ml-research",
    storage: "bounded-ephemeral-memory",
    rawDataPersistence: false,
    onlineCapture: onlineCapture(item.onlineCapture, `${path}.onlineCapture`),
    behaviorScope: "anonymous-aggregate-liquidity",
    participantIdentityInferred: false,
    probabilitiesProduced: false,
    executionBoundary: executionBoundary(item.executionBoundary, `${path}.executionBoundary`),
    limits: {
      maxSessions: integer(limits.maxSessions, `${path}.limits.maxSessions`, 1),
      maxSnapshotsPerSession: integer(limits.maxSnapshotsPerSession, `${path}.limits.maxSnapshotsPerSession`, 1),
      maxModelsPerSession: integer(limits.maxModelsPerSession, `${path}.limits.maxModelsPerSession`, 1),
      sessionTtlMs: integer(limits.sessionTtlMs, `${path}.limits.sessionTtlMs`, 1),
      operationBudgetMs: integer(limits.operationBudgetMs, `${path}.limits.operationBudgetMs`, 1)
    },
    registry: { sessions: integer(registry.sessions, `${path}.registry.sessions`, 0), snapshots: integer(registry.snapshots, `${path}.registry.snapshots`, 0), models: integer(registry.models, `${path}.registry.models`, 0) }
  };
}

function sessions(value: unknown, path: string): ResearchSession[] {
  return array(value, path).map((item, index) => session(item, `${path}[${index}]`));
}

function session(value: unknown, path: string): ResearchSession {
  const item = object(value, path, [
    "schemaVersion",
    "id",
    "name",
    "createdAt",
    "expiresAt",
    "storage",
    "rawDataPersistence",
    "captureMode",
    "onlineCapture",
    "behaviorScope",
    "participantIdentityInferred",
    "probabilitiesProduced",
    "executionBoundary",
    "qualityPolicy",
    "labelPolicy",
    "quality",
    "predictions",
    "snapshotCount",
    "provenance",
    "dataset",
    "models"
  ]);
  literal(item.schemaVersion, ORDER_BOOK_ML_RESEARCH_SCHEMA, `${path}.schemaVersion`);
  literal(item.storage, "bounded-ephemeral-memory", `${path}.storage`);
  literal(item.rawDataPersistence, false, `${path}.rawDataPersistence`);
  literal(item.captureMode, "uploaded-sequenced-l2", `${path}.captureMode`);
  literal(item.behaviorScope, "anonymous-aggregate-liquidity", `${path}.behaviorScope`);
  literal(item.participantIdentityInferred, false, `${path}.participantIdentityInferred`);
  literal(item.probabilitiesProduced, false, `${path}.probabilitiesProduced`);
  const policy = object(item.qualityPolicy, `${path}.qualityPolicy`, ["schemaVersion", "maximumAgeMs", "maximumFutureSkewMs", "maximumInputDepth", "normalizedDepth"]);
  literal(policy.schemaVersion, ORDER_BOOK_QUALITY_POLICY_SCHEMA, `${path}.qualityPolicy.schemaVersion`);
  const labelPolicy = object(item.labelPolicy, `${path}.labelPolicy`, ["horizonsMs", "maximumAlignmentDelayMs"]);
  const horizonsMs = array(labelPolicy.horizonsMs, `${path}.labelPolicy.horizonsMs`).map((entry, index) => integer(entry, `${path}.labelPolicy.horizonsMs[${index}]`, 1));
  if (horizonsMs.length < 1 || horizonsMs.length > 3 || horizonsMs.some((entry, index) => index > 0 && entry <= horizonsMs[index - 1]!)) fail(`${path}.labelPolicy.horizonsMs is invalid`);
  const predictions = object(item.predictions, `${path}.predictions`, ["attempted", "accepted", "rejected"]);
  const models = array(item.models, `${path}.models`).map((entry, index) => modelSummary(entry, `${path}.models[${index}]`));
  const parsed: ResearchSession = {
    schemaVersion: ORDER_BOOK_ML_RESEARCH_SCHEMA,
    id: uuid(item.id, `${path}.id`),
    createdAt: integer(item.createdAt, `${path}.createdAt`, 1),
    expiresAt: integer(item.expiresAt, `${path}.expiresAt`, 1),
    storage: "bounded-ephemeral-memory",
    rawDataPersistence: false,
    captureMode: "uploaded-sequenced-l2",
    onlineCapture: onlineCapture(item.onlineCapture, `${path}.onlineCapture`),
    behaviorScope: "anonymous-aggregate-liquidity",
    participantIdentityInferred: false,
    probabilitiesProduced: false,
    executionBoundary: executionBoundary(item.executionBoundary, `${path}.executionBoundary`),
    qualityPolicy: {
      schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA,
      maximumAgeMs: integer(policy.maximumAgeMs, `${path}.qualityPolicy.maximumAgeMs`, 0),
      maximumFutureSkewMs: integer(policy.maximumFutureSkewMs, `${path}.qualityPolicy.maximumFutureSkewMs`, 0),
      maximumInputDepth: integer(policy.maximumInputDepth, `${path}.qualityPolicy.maximumInputDepth`, 10, 100),
      normalizedDepth: integer(policy.normalizedDepth, `${path}.qualityPolicy.normalizedDepth`, 10, 100)
    },
    labelPolicy: { horizonsMs, maximumAlignmentDelayMs: integer(labelPolicy.maximumAlignmentDelayMs, `${path}.labelPolicy.maximumAlignmentDelayMs`, 0) },
    quality: quality(item.quality, `${path}.quality`),
    predictions: { attempted: integer(predictions.attempted, `${path}.predictions.attempted`, 0), accepted: integer(predictions.accepted, `${path}.predictions.accepted`, 0), rejected: integer(predictions.rejected, `${path}.predictions.rejected`, 0) },
    snapshotCount: integer(item.snapshotCount, `${path}.snapshotCount`, 0),
    provenance: item.provenance === null ? null : provenance(item.provenance, `${path}.provenance`),
    dataset: item.dataset === null ? null : dataset(item.dataset, `${path}.dataset`),
    models
  };
  if (item.name !== undefined) parsed.name = text(item.name, `${path}.name`, 80);
  if (parsed.qualityPolicy.normalizedDepth > parsed.qualityPolicy.maximumInputDepth) fail(`${path}.qualityPolicy normalized depth exceeds input depth`);
  if (parsed.expiresAt <= parsed.createdAt) fail(`${path}.expiresAt must be later than createdAt`);
  if (parsed.quality.acceptedSnapshots !== parsed.snapshotCount || parsed.quality.submittedSnapshots !== parsed.quality.acceptedSnapshots + parsed.quality.rejectedSnapshots + parsed.quality.discardedSnapshots) fail(`${path}.quality counters are inconsistent`);
  if (parsed.predictions.attempted !== parsed.predictions.accepted + parsed.predictions.rejected) fail(`${path}.prediction counters are inconsistent`);
  if ((parsed.provenance === null) !== (parsed.snapshotCount === 0)) fail(`${path}.provenance does not match its snapshot count`);
  if (new Set(parsed.models.map((model) => model.modelId)).size !== parsed.models.length) fail(`${path}.models contains duplicate identities`);
  return parsed;
}

function modelSummary(value: unknown, path: string): ResearchModelSummary {
  const item = object(value, path, ["modelId", "schemaVersion", "algorithm", "target", "trainedAt", "trainingWindow", "metrics", "executionBoundary"]);
  return modelCommon(item, path);
}

function modelArtifact(value: unknown, path: string): ResearchModelSummary {
  const item = object(value, path, ["schemaVersion", "modelId", "algorithm", "target", "scope", "features", "parameters", "decisionPolicy", "trainedAt", "trainingWindow", "metrics", "executionBoundary"]);
  const scope = object(item.scope, `${path}.scope`, ["venue", "market", "instrumentId", "symbol", "normalizerVersion", "exchangeTimestampSource", "behaviorScope", "participantIdentityInferred"]);
  for (const key of ["venue", "market", "instrumentId", "symbol", "normalizerVersion"] as const) text(scope[key], `${path}.scope.${key}`);
  oneOf(scope.exchangeTimestampSource, ["event-time", "matching-engine-time"] as const, `${path}.scope.exchangeTimestampSource`);
  literal(scope.behaviorScope, "anonymous-aggregate-liquidity", `${path}.scope.behaviorScope`);
  literal(scope.participantIdentityInferred, false, `${path}.scope.participantIdentityInferred`);
  const features = object(item.features, `${path}.features`, ["schemaVersion", "names", "means", "scales"]);
  literal(features.schemaVersion, "orderbook-feature-v1", `${path}.features.schemaVersion`);
  const names = array(features.names, `${path}.features.names`).map((entry, index) => text(entry, `${path}.features.names[${index}]`));
  const means = finiteArray(features.means, `${path}.features.means`);
  const scales = finiteArray(features.scales, `${path}.features.scales`);
  const parameters = object(item.parameters, `${path}.parameters`, ["intercept", "coefficients", "ridgeLambda"]);
  const coefficients = finiteArray(parameters.coefficients, `${path}.parameters.coefficients`);
  if (names.length < 1 || names.length > 128 || new Set(names).size !== names.length || means.length !== names.length || scales.length !== names.length || coefficients.length !== names.length || scales.some((entry) => entry <= 0)) fail(`${path}.features dimensions are invalid`);
  finite(parameters.intercept, `${path}.parameters.intercept`);
  finite(parameters.ridgeLambda, `${path}.parameters.ridgeLambda`, Number.MIN_VALUE);
  const decision = object(item.decisionPolicy, `${path}.decisionPolicy`, ["flatThresholdBps", "outOfDistributionZScore"]);
  finite(decision.flatThresholdBps, `${path}.decisionPolicy.flatThresholdBps`, 0);
  finite(decision.outOfDistributionZScore, `${path}.decisionPolicy.outOfDistributionZScore`, 1);
  return modelCommon(item, path);
}

function modelCommon(item: Record<string, unknown>, path: string): ResearchModelSummary {
  literal(item.schemaVersion, "orderbook-ridge-model-v1", `${path}.schemaVersion`);
  literal(item.algorithm, "ridge-linear-regression", `${path}.algorithm`);
  const target = object(item.target, `${path}.target`, ["schemaVersion", "horizonMs", "unit"]);
  literal(target.schemaVersion, "future-mid-return-v1", `${path}.target.schemaVersion`);
  literal(target.unit, "basis-points", `${path}.target.unit`);
  const metricsRecord = object(item.metrics, `${path}.metrics`, ["train", "validation", "test"]);
  return {
    modelId: modelId(item.modelId, `${path}.modelId`),
    schemaVersion: "orderbook-ridge-model-v1",
    algorithm: "ridge-linear-regression",
    target: { schemaVersion: "future-mid-return-v1", horizonMs: integer(target.horizonMs, `${path}.target.horizonMs`, 1), unit: "basis-points" },
    trainedAt: integer(item.trainedAt, `${path}.trainedAt`, 1),
    trainingWindow: trainingWindow(item.trainingWindow, `${path}.trainingWindow`),
    metrics: { train: metrics(metricsRecord.train, `${path}.metrics.train`), validation: metrics(metricsRecord.validation, `${path}.metrics.validation`), test: metrics(metricsRecord.test, `${path}.metrics.test`) },
    executionBoundary: executionBoundary(item.executionBoundary, `${path}.executionBoundary`)
  };
}

function trainingWindow(value: unknown, path: string): ResearchTrainingWindow {
  const item = object(value, path, ["firstExchangeTs", "lastExchangeTs", "connectionGenerations", "trainRows", "validationRows", "testRows", "purgedTrainRows", "purgedValidationRows"]);
  const connectionGenerations = array(item.connectionGenerations, `${path}.connectionGenerations`).map((entry, index) => integer(entry, `${path}.connectionGenerations[${index}]`, 1));
  if (connectionGenerations.length < 1 || new Set(connectionGenerations).size !== connectionGenerations.length) fail(`${path}.connectionGenerations is invalid`);
  const parsed = {
    firstExchangeTs: integer(item.firstExchangeTs, `${path}.firstExchangeTs`, 1),
    lastExchangeTs: integer(item.lastExchangeTs, `${path}.lastExchangeTs`, 1),
    connectionGenerations,
    trainRows: integer(item.trainRows, `${path}.trainRows`, 1),
    validationRows: integer(item.validationRows, `${path}.validationRows`, 1),
    testRows: integer(item.testRows, `${path}.testRows`, 1),
    purgedTrainRows: integer(item.purgedTrainRows, `${path}.purgedTrainRows`, 0),
    purgedValidationRows: integer(item.purgedValidationRows, `${path}.purgedValidationRows`, 0)
  };
  if (parsed.firstExchangeTs > parsed.lastExchangeTs) fail(`${path} timestamps are reversed`);
  return parsed;
}

function metrics(value: unknown, path: string): ResearchModelMetrics {
  const item = object(value, path, ["rows", "meanActualBps", "meanPredictionBps", "maeBps", "rmseBps", "directionalAccuracy", "correlation"]);
  return {
    rows: integer(item.rows, `${path}.rows`, 1),
    meanActualBps: finite(item.meanActualBps, `${path}.meanActualBps`),
    meanPredictionBps: finite(item.meanPredictionBps, `${path}.meanPredictionBps`),
    maeBps: finite(item.maeBps, `${path}.maeBps`, 0),
    rmseBps: finite(item.rmseBps, `${path}.rmseBps`, 0),
    directionalAccuracy: finite(item.directionalAccuracy, `${path}.directionalAccuracy`, 0, 1),
    correlation: finite(item.correlation, `${path}.correlation`, -1, 1)
  };
}

function quality(value: unknown, path: string): ResearchQualityCounters {
  const item = object(value, path, ["submittedSnapshots", "acceptedSnapshots", "rejectedSnapshots", "discardedSnapshots", "acceptedBatches", "rejectedBatches", "issuesByCode"]);
  const issues = object(item.issuesByCode, `${path}.issuesByCode`);
  const issuesByCode = Object.fromEntries(Object.entries(issues).map(([key, count]) => [key, integer(count, `${path}.issuesByCode.${key}`, 0)]));
  return {
    submittedSnapshots: integer(item.submittedSnapshots, `${path}.submittedSnapshots`, 0),
    acceptedSnapshots: integer(item.acceptedSnapshots, `${path}.acceptedSnapshots`, 0),
    rejectedSnapshots: integer(item.rejectedSnapshots, `${path}.rejectedSnapshots`, 0),
    discardedSnapshots: integer(item.discardedSnapshots, `${path}.discardedSnapshots`, 0),
    acceptedBatches: integer(item.acceptedBatches, `${path}.acceptedBatches`, 0),
    rejectedBatches: integer(item.rejectedBatches, `${path}.rejectedBatches`, 0),
    issuesByCode
  };
}

function provenance(value: unknown, path: string): ResearchSessionProvenance {
  const item = object(value, path, ["venue", "market", "instrumentId", "symbol", "normalizerVersion", "connectionGeneration", "firstSequence", "lastSequence", "firstExchangeTs", "lastExchangeTs", "exchangeTimestampSource", "checksumVerifiedForEverySnapshot"]);
  const parsed = {
    venue: text(item.venue, `${path}.venue`),
    market: text(item.market, `${path}.market`),
    instrumentId: text(item.instrumentId, `${path}.instrumentId`),
    symbol: text(item.symbol, `${path}.symbol`),
    normalizerVersion: text(item.normalizerVersion, `${path}.normalizerVersion`),
    connectionGeneration: integer(item.connectionGeneration, `${path}.connectionGeneration`, 1),
    firstSequence: integer(item.firstSequence, `${path}.firstSequence`, 0),
    lastSequence: integer(item.lastSequence, `${path}.lastSequence`, 0),
    firstExchangeTs: integer(item.firstExchangeTs, `${path}.firstExchangeTs`, 1),
    lastExchangeTs: integer(item.lastExchangeTs, `${path}.lastExchangeTs`, 1),
    exchangeTimestampSource: oneOf(item.exchangeTimestampSource, ["event-time", "matching-engine-time"] as const, `${path}.exchangeTimestampSource`),
    checksumVerifiedForEverySnapshot: boolean(item.checksumVerifiedForEverySnapshot, `${path}.checksumVerifiedForEverySnapshot`)
  };
  if (parsed.firstSequence > parsed.lastSequence || parsed.firstExchangeTs > parsed.lastExchangeTs) fail(`${path} range is reversed`);
  return parsed;
}

function dataset(value: unknown, path: string) {
  const item = object(value, path, ["builtAt", "rows", "horizonMs"]);
  return { builtAt: integer(item.builtAt, `${path}.builtAt`, 1), rows: integer(item.rows, `${path}.rows`, 0), horizonMs: integer(item.horizonMs, `${path}.horizonMs`, 1) };
}

function split(value: unknown, path: string): ResearchSplitSummary {
  const item = object(value, path, ["trainRows", "validationRows", "testRows", "excludedMissingLabel", "purgedTrainRows", "purgedValidationRows", "validationStartsAt", "testStartsAt"]);
  return {
    trainRows: integer(item.trainRows, `${path}.trainRows`, 1),
    validationRows: integer(item.validationRows, `${path}.validationRows`, 1),
    testRows: integer(item.testRows, `${path}.testRows`, 1),
    excludedMissingLabel: integer(item.excludedMissingLabel, `${path}.excludedMissingLabel`, 0),
    purgedTrainRows: integer(item.purgedTrainRows, `${path}.purgedTrainRows`, 0),
    purgedValidationRows: integer(item.purgedValidationRows, `${path}.purgedValidationRows`, 0),
    validationStartsAt: integer(item.validationStartsAt, `${path}.validationStartsAt`, 1),
    testStartsAt: integer(item.testStartsAt, `${path}.testStartsAt`, 1)
  };
}

function snapshot(value: unknown, path: string): SequencedL2SnapshotInput {
  const item = object(value, path, [
    "schemaVersion",
    "venue",
    "market",
    "instrumentId",
    "symbol",
    "bids",
    "asks",
    "sequenceStart",
    "sequence",
    "previousSequence",
    "sequenceVerified",
    "exchangeTs",
    "exchangeTimestampSource",
    "receivedAt",
    "connectionGeneration",
    "source",
    "retainedDepth",
    "normalizerVersion",
    "checksumVerified"
  ]);
  literal(item.schemaVersion, SEQUENCED_L2_SNAPSHOT_SCHEMA, `${path}.schemaVersion`);
  literal(item.sequenceVerified, true, `${path}.sequenceVerified`);
  literal(item.source, "websocket-reconstructed", `${path}.source`);
  const parsed: SequencedL2SnapshotInput = {
    schemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA,
    venue: text(item.venue, `${path}.venue`),
    market: text(item.market, `${path}.market`),
    instrumentId: text(item.instrumentId, `${path}.instrumentId`),
    symbol: text(item.symbol, `${path}.symbol`),
    bids: levels(item.bids, `${path}.bids`),
    asks: levels(item.asks, `${path}.asks`),
    sequenceStart: integer(item.sequenceStart, `${path}.sequenceStart`, 0),
    sequence: integer(item.sequence, `${path}.sequence`, 0),
    previousSequence: item.previousSequence === null ? null : integer(item.previousSequence, `${path}.previousSequence`, 0),
    sequenceVerified: true,
    exchangeTs: integer(item.exchangeTs, `${path}.exchangeTs`, 1),
    exchangeTimestampSource: oneOf(item.exchangeTimestampSource, ["event-time", "matching-engine-time"] as const, `${path}.exchangeTimestampSource`),
    receivedAt: integer(item.receivedAt, `${path}.receivedAt`, 1),
    connectionGeneration: integer(item.connectionGeneration, `${path}.connectionGeneration`, 1),
    source: "websocket-reconstructed",
    retainedDepth: integer(item.retainedDepth, `${path}.retainedDepth`, 1, 5_000),
    normalizerVersion: text(item.normalizerVersion, `${path}.normalizerVersion`)
  };
  if (item.checksumVerified !== undefined) parsed.checksumVerified = boolean(item.checksumVerified, `${path}.checksumVerified`);
  return parsed;
}

function levels(value: unknown, path: string): Array<readonly [number, number]> {
  const values = array(value, path);
  if (values.length < 10 || values.length > 100) fail(`${path} must contain 10..100 levels`);
  return values.map((entry, index) => {
    const level = array(entry, `${path}[${index}]`);
    if (level.length !== 2) fail(`${path}[${index}] must be a [price, quantity] pair`);
    return [finite(level[0], `${path}[${index}][0]`, Number.MIN_VALUE), finite(level[1], `${path}[${index}][1]`, Number.MIN_VALUE)] as const;
  });
}

function envelope(value: unknown, path: string, payloadKeys: readonly string[]) {
  const item = object(value, path, [...ENVELOPE_KEYS, ...payloadKeys]);
  literal(item.schemaVersion, ORDER_BOOK_ML_RESEARCH_SCHEMA, `${path}.schemaVersion`);
  literal(item.researchOnly, true, `${path}.researchOnly`);
  literal(item.participantIdentityInferred, false, `${path}.participantIdentityInferred`);
  literal(item.probabilitiesProduced, false, `${path}.probabilitiesProduced`);
  executionBoundary(item.executionBoundary, `${path}.executionBoundary`);
  return item;
}

function onlineCapture(value: unknown, path: string): ResearchOnlineCapture {
  const item = object(value, path, ["available", "mode", "reason"]);
  literal(item.available, false, `${path}.available`);
  literal(item.mode, "upload-only", `${path}.mode`);
  return { available: false, mode: "upload-only", reason: text(item.reason, `${path}.reason`, 2_000) };
}

function executionBoundary(value: unknown, path: string): ResearchExecutionBoundary {
  const item = object(value, path, BOUNDARY_KEYS);
  literal(item.researchOnly, true, `${path}.researchOnly`);
  literal(item.paperOrders, false, `${path}.paperOrders`);
  literal(item.liveOrders, false, `${path}.liveOrders`);
  return { researchOnly: true, paperOrders: false, liveOrders: false };
}

function object(value: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  if (keys) {
    const allowed = new Set(keys);
    const unknown = Object.keys(item).filter((key) => !allowed.has(key));
    if (unknown.length) fail(`${path} contains unsupported field ${unknown[0]}`);
  }
  return item;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function finiteArray(value: unknown, path: string): number[] {
  return array(value, path).map((entry, index) => finite(entry, `${path}[${index}]`));
}

function text(value: unknown, path: string, maximum = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(`${path} must be a non-empty string up to ${maximum} characters`);
  return value;
}

function finite(value: unknown, path: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`${path} must be a finite number within ${minimum}..${maximum}`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(`${path} must be an integer within ${minimum}..${maximum}`);
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function uuid(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) fail(`${path} must be a UUID`);
  return parsed;
}

function modelId(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!/^ob-ridge:[a-f0-9]{64}$/.test(parsed)) fail(`${path} is invalid`);
  return parsed;
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) fail(`${path} must equal ${String(expected)}`);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${path} is invalid`);
  return value as T[number];
}

function fail(message: string): never {
  throw new Error(`Invalid order-book ML research data: ${message}`);
}
