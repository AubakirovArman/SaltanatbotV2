export const ORDER_BOOK_ML_RESEARCH_SCHEMA = "orderbook-ml-research-api-v1" as const;
export const SEQUENCED_L2_SNAPSHOT_SCHEMA = "sequenced-l2-snapshot-v1" as const;
export const ORDER_BOOK_QUALITY_POLICY_SCHEMA = "orderbook-quality-policy-v1" as const;

export interface ResearchExecutionBoundary {
  researchOnly: true;
  paperOrders: false;
  liveOrders: false;
}

export interface ResearchOnlineCapture {
  available: false;
  mode: "upload-only";
  reason: string;
}

export interface ResearchHealth {
  schemaVersion: typeof ORDER_BOOK_ML_RESEARCH_SCHEMA;
  ok: true;
  service: "order-book-ml-research";
  storage: "bounded-ephemeral-memory";
  rawDataPersistence: false;
  onlineCapture: ResearchOnlineCapture;
  behaviorScope: "anonymous-aggregate-liquidity";
  participantIdentityInferred: false;
  probabilitiesProduced: false;
  executionBoundary: ResearchExecutionBoundary;
  limits: {
    maxSessions: number;
    maxSnapshotsPerSession: number;
    maxModelsPerSession: number;
    sessionTtlMs: number;
    operationBudgetMs: number;
  };
  registry: { sessions: number; snapshots: number; models: number };
}

export interface ResearchQualityPolicy {
  schemaVersion: typeof ORDER_BOOK_QUALITY_POLICY_SCHEMA;
  maximumAgeMs: number;
  maximumFutureSkewMs: number;
  maximumInputDepth: number;
  normalizedDepth: number;
}

export interface ResearchLabelPolicy {
  horizonsMs: number[];
  maximumAlignmentDelayMs: number;
}

export interface ResearchQualityCounters {
  submittedSnapshots: number;
  acceptedSnapshots: number;
  rejectedSnapshots: number;
  discardedSnapshots: number;
  acceptedBatches: number;
  rejectedBatches: number;
  issuesByCode: Record<string, number>;
}

export interface ResearchModelMetrics {
  rows: number;
  meanActualBps: number;
  meanPredictionBps: number;
  maeBps: number;
  rmseBps: number;
  directionalAccuracy: number;
  correlation: number;
}

export interface ResearchTrainingWindow {
  firstExchangeTs: number;
  lastExchangeTs: number;
  connectionGenerations: number[];
  trainRows: number;
  validationRows: number;
  testRows: number;
  purgedTrainRows: number;
  purgedValidationRows: number;
}

export interface ResearchModelSummary {
  modelId: string;
  schemaVersion: "orderbook-ridge-model-v1";
  algorithm: "ridge-linear-regression";
  target: { schemaVersion: "future-mid-return-v1"; horizonMs: number; unit: "basis-points" };
  trainedAt: number;
  trainingWindow: ResearchTrainingWindow;
  metrics: { train: ResearchModelMetrics; validation: ResearchModelMetrics; test: ResearchModelMetrics };
  executionBoundary: ResearchExecutionBoundary;
}

export interface ResearchSessionProvenance {
  venue: string;
  market: string;
  instrumentId: string;
  symbol: string;
  normalizerVersion: string;
  connectionGeneration: number;
  firstSequence: number;
  lastSequence: number;
  firstExchangeTs: number;
  lastExchangeTs: number;
  exchangeTimestampSource: "event-time" | "matching-engine-time";
  checksumVerifiedForEverySnapshot: boolean;
}

export interface ResearchSession {
  schemaVersion: typeof ORDER_BOOK_ML_RESEARCH_SCHEMA;
  id: string;
  name?: string;
  createdAt: number;
  expiresAt: number;
  storage: "bounded-ephemeral-memory";
  rawDataPersistence: false;
  captureMode: "uploaded-sequenced-l2";
  onlineCapture: ResearchOnlineCapture;
  behaviorScope: "anonymous-aggregate-liquidity";
  participantIdentityInferred: false;
  probabilitiesProduced: false;
  executionBoundary: ResearchExecutionBoundary;
  qualityPolicy: ResearchQualityPolicy;
  labelPolicy: ResearchLabelPolicy;
  quality: ResearchQualityCounters;
  predictions: { attempted: number; accepted: number; rejected: number };
  snapshotCount: number;
  provenance: ResearchSessionProvenance | null;
  dataset: { builtAt: number; rows: number; horizonMs: number } | null;
  models: ResearchModelSummary[];
}

export interface ResearchStatus {
  health: ResearchHealth;
  sessions: ResearchSession[];
}

export interface SequencedL2SnapshotInput {
  schemaVersion: typeof SEQUENCED_L2_SNAPSHOT_SCHEMA;
  venue: string;
  market: string;
  instrumentId: string;
  symbol: string;
  bids: Array<readonly [number, number]>;
  asks: Array<readonly [number, number]>;
  sequenceStart: number;
  sequence: number;
  previousSequence: number | null;
  sequenceVerified: true;
  exchangeTs: number;
  exchangeTimestampSource: "event-time" | "matching-engine-time";
  receivedAt: number;
  connectionGeneration: number;
  source: "websocket-reconstructed";
  retainedDepth: number;
  normalizerVersion: string;
  checksumVerified?: boolean;
}

export interface CreateResearchSessionInput {
  name?: string;
  qualityPolicy: ResearchQualityPolicy;
  labelPolicy: ResearchLabelPolicy;
}

export interface TrainResearchModelInput {
  horizonMs: number;
  ridgeLambda?: number;
  trainFraction?: number;
  validationFraction?: number;
  minimumRowsPerSplit: number;
  flatThresholdBps?: number;
  outOfDistributionZScore?: number;
}

export interface ResearchSplitSummary {
  trainRows: number;
  validationRows: number;
  testRows: number;
  excludedMissingLabel: number;
  purgedTrainRows: number;
  purgedValidationRows: number;
  validationStartsAt: number;
  testStartsAt: number;
}

export interface ResearchTrainingResult {
  model: ResearchModelSummary;
  dataset: { builtAt: number; rows: number; horizonMs: number };
  split: ResearchSplitSummary;
}

export interface ResearchPrediction {
  schemaVersion: "orderbook-prediction-v1";
  modelId: string;
  instrumentId: string;
  symbol: string;
  horizonMs: number;
  anchorSequence: number;
  anchorExchangeTs: number;
  predictedReturnBps: number;
  direction: "up" | "down" | "flat";
  signalToNoise: number;
  distribution: {
    status: "within-training-range" | "out-of-distribution";
    maximumAbsoluteZScore: number;
    threshold: number;
  };
  contributions: Array<{ feature: string; standardizedValue: number; contributionBps: number }>;
  behaviorScope: "anonymous-aggregate-liquidity";
  participantIdentityInferred: false;
  executionBoundary: ResearchExecutionBoundary;
}

export interface ResearchPredictionResult {
  prediction: ResearchPrediction;
  provenance: {
    captureMode: "caller-uploaded-fresh-sequenced-l2";
    snapshots: number;
    featureSchemaVersion: "orderbook-feature-v1";
    normalizerVersion: string;
    qualityEvaluatedAt: number;
  };
}
