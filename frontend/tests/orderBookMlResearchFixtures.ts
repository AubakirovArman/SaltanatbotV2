import type { SequencedL2SnapshotInput } from "../src/arbitrage/orderBookMlResearchTypes";

export const SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const MODEL_ID = `ob-ridge:${"a".repeat(64)}`;
export const EXECUTION_BOUNDARY = { researchOnly: true, paperOrders: false, liveOrders: false } as const;
export const ENVELOPE_BOUNDARY = {
  schemaVersion: "orderbook-ml-research-api-v1",
  researchOnly: true,
  participantIdentityInferred: false,
  probabilitiesProduced: false,
  executionBoundary: EXECUTION_BOUNDARY
} as const;

export const METRICS = {
  rows: 30,
  meanActualBps: 0.1,
  meanPredictionBps: 0.08,
  maeBps: 0.2,
  rmseBps: 0.3,
  directionalAccuracy: 0.6,
  correlation: 0.25
};

export const MODEL_SUMMARY = {
  modelId: MODEL_ID,
  schemaVersion: "orderbook-ridge-model-v1",
  algorithm: "ridge-linear-regression",
  target: { schemaVersion: "future-mid-return-v1", horizonMs: 1_000, unit: "basis-points" },
  trainedAt: 2_000,
  trainingWindow: {
    firstExchangeTs: 1_000,
    lastExchangeTs: 1_900,
    connectionGenerations: [1],
    trainRows: 30,
    validationRows: 30,
    testRows: 30,
    purgedTrainRows: 1,
    purgedValidationRows: 1
  },
  metrics: { train: METRICS, validation: METRICS, test: METRICS },
  executionBoundary: EXECUTION_BOUNDARY
} as const;

export const MODEL_ARTIFACT = {
  ...MODEL_SUMMARY,
  scope: {
    venue: "test-venue",
    market: "spot",
    instrumentId: "test-venue:spot:BTCUSDT",
    symbol: "BTCUSDT",
    normalizerVersion: "test-l2-v1",
    exchangeTimestampSource: "matching-engine-time",
    behaviorScope: "anonymous-aggregate-liquidity",
    participantIdentityInferred: false
  },
  features: { schemaVersion: "orderbook-feature-v1", names: ["spreadBps"], means: [1], scales: [0.5] },
  parameters: { intercept: 0.01, coefficients: [0.2], ridgeLambda: 0.1 },
  decisionPolicy: { flatThresholdBps: 0.05, outOfDistributionZScore: 6 }
} as const;

export const HEALTH = {
  schemaVersion: "orderbook-ml-research-api-v1",
  ok: true,
  service: "order-book-ml-research",
  storage: "bounded-ephemeral-memory",
  rawDataPersistence: false,
  onlineCapture: { available: false, mode: "upload-only", reason: "verified online capture is unavailable" },
  behaviorScope: "anonymous-aggregate-liquidity",
  participantIdentityInferred: false,
  probabilitiesProduced: false,
  executionBoundary: EXECUTION_BOUNDARY,
  limits: { maxSessions: 4, maxSnapshotsPerSession: 2_000, maxModelsPerSession: 3, sessionTtlMs: 1_800_000, operationBudgetMs: 2_000 },
  registry: { sessions: 1, snapshots: 120, models: 1 }
} as const;

export const SESSION = {
  schemaVersion: "orderbook-ml-research-api-v1",
  id: SESSION_ID,
  name: "BTC anonymous liquidity",
  createdAt: 1_000,
  expiresAt: 1_801_000,
  storage: "bounded-ephemeral-memory",
  rawDataPersistence: false,
  captureMode: "uploaded-sequenced-l2",
  onlineCapture: HEALTH.onlineCapture,
  behaviorScope: "anonymous-aggregate-liquidity",
  participantIdentityInferred: false,
  probabilitiesProduced: false,
  executionBoundary: EXECUTION_BOUNDARY,
  qualityPolicy: { schemaVersion: "orderbook-quality-policy-v1", maximumAgeMs: 5_000, maximumFutureSkewMs: 500, maximumInputDepth: 50, normalizedDepth: 10 },
  labelPolicy: { horizonsMs: [1_000], maximumAlignmentDelayMs: 250 },
  quality: { submittedSnapshots: 121, acceptedSnapshots: 120, rejectedSnapshots: 1, discardedSnapshots: 0, acceptedBatches: 1, rejectedBatches: 1, issuesByCode: { "sequence-gap": 1 } },
  predictions: { attempted: 1, accepted: 1, rejected: 0 },
  snapshotCount: 120,
  provenance: {
    venue: "test-venue",
    market: "spot",
    instrumentId: "test-venue:spot:BTCUSDT",
    symbol: "BTCUSDT",
    normalizerVersion: "test-l2-v1",
    connectionGeneration: 1,
    firstSequence: 1,
    lastSequence: 120,
    firstExchangeTs: 1_000,
    lastExchangeTs: 1_900,
    exchangeTimestampSource: "matching-engine-time",
    checksumVerifiedForEverySnapshot: false
  },
  dataset: { builtAt: 2_000, rows: 119, horizonMs: 1_000 },
  models: [MODEL_SUMMARY]
} as const;

export const STATUS_RESPONSE = { ...ENVELOPE_BOUNDARY, health: HEALTH, sessions: [SESSION] } as const;

export function snapshot(sequence = 1, exchangeTs = Date.now() - 10): SequencedL2SnapshotInput {
  return {
    schemaVersion: "sequenced-l2-snapshot-v1",
    venue: "test-venue",
    market: "spot",
    instrumentId: "test-venue:spot:BTCUSDT",
    symbol: "BTCUSDT",
    bids: levels(100, -0.1),
    asks: levels(101, 0.1),
    sequenceStart: sequence,
    sequence,
    previousSequence: sequence === 1 ? null : sequence - 1,
    sequenceVerified: true,
    exchangeTs,
    exchangeTimestampSource: "matching-engine-time",
    receivedAt: exchangeTs + 1,
    connectionGeneration: 1,
    source: "websocket-reconstructed",
    retainedDepth: 10,
    normalizerVersion: "test-l2-v1"
  };
}

function levels(start: number, step: number): Array<readonly [number, number]> {
  return Array.from({ length: 10 }, (_, index) => [start + index * step, 1 + index * 0.01] as const);
}
