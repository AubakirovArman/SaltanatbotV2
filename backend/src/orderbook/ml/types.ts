export const SEQUENCED_L2_SNAPSHOT_SCHEMA_V1 = "sequenced-l2-snapshot-v1" as const;
export const ORDER_BOOK_NORMALIZATION_SCHEMA_V1 = "orderbook-normalization-v1" as const;
export const ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1 = "orderbook-quality-policy-v1" as const;
export const ORDER_BOOK_FEATURE_SCHEMA_V1 = "orderbook-feature-v1" as const;
export const ORDER_BOOK_LABEL_SCHEMA_V1 = "future-mid-return-v1" as const;
export const ORDER_BOOK_DATASET_ROW_SCHEMA_V1 = "orderbook-dataset-row-v1" as const;

export const MAX_L2_INPUT_LEVELS = 5_000;
export const MAX_TRADE_WINDOW_EVENTS = 10_000;

export type ReadonlyL2Level = readonly [price: number, quantity: number];

/**
 * Capture boundary for ML/research. This is intentionally stricter than the
 * browser-facing full-snapshot contract: sequence continuity, source identity,
 * generation and normalizer provenance must already be known.
 */
export interface SequencedL2SnapshotV1 {
  schemaVersion: typeof SEQUENCED_L2_SNAPSHOT_SCHEMA_V1;
  venue: string;
  market: string;
  instrumentId: string;
  symbol: string;
  bids: readonly ReadonlyL2Level[];
  asks: readonly ReadonlyL2Level[];
  /** First source update represented by this publication. */
  sequenceStart: number;
  /** Last source update represented by this publication. */
  sequence: number;
  /** Last source update of the immediately preceding captured publication. */
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

export interface SnapshotQualityPolicyV1 {
  schemaVersion: typeof ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1;
  maximumAgeMs: number;
  maximumFutureSkewMs: number;
  maximumInputDepth: number;
  normalizedDepth: number;
}

export type SnapshotQualityIssueCode =
  | "invalid-envelope"
  | "unverified-sequence"
  | "invalid-sequence"
  | "sequence-gap"
  | "stream-identity-changed"
  | "generation-changed"
  | "timestamp-regression"
  | "timestamp-future"
  | "stale"
  | "empty-side"
  | "depth-bound-exceeded"
  | "insufficient-depth"
  | "invalid-level"
  | "unsorted-levels"
  | "crossed-or-locked"
  | "retained-depth-invalid";

export interface SnapshotQualityIssue {
  code: SnapshotQualityIssueCode;
  message: string;
}

export interface SnapshotQualityEvidenceV1 {
  policy: SnapshotQualityPolicyV1;
  evaluatedAt: number;
  receiveAgeMs: number;
  exchangeAgeMs: number;
  effectiveAgeMs: number;
  transportLagMs: number;
  sequenceContinuous: true;
  sorted: true;
  positive: true;
  uncrossed: true;
  fresh: true;
}

export interface NormalizedL2SnapshotV1 extends Omit<SequencedL2SnapshotV1, "bids" | "asks"> {
  bids: readonly ReadonlyL2Level[];
  asks: readonly ReadonlyL2Level[];
  normalization: {
    schemaVersion: typeof ORDER_BOOK_NORMALIZATION_SCHEMA_V1;
    depth: number;
    sourceBidDepth: number;
    sourceAskDepth: number;
  };
  quality: SnapshotQualityEvidenceV1;
}

export interface AggressiveTradeV1 {
  id: string;
  price: number;
  quantity: number;
  /** Aggressor side, not resting-order ownership or participant identity. */
  side: "buy" | "sell";
  exchangeTs: number;
}

export interface TradeFlowWindowV1 {
  /** Trades must be strictly newer than this boundary. */
  startExclusiveExchangeTs: number;
  /** Trades may equal this boundary; it may not exceed the feature timestamp. */
  endInclusiveExchangeTs: number;
  trades: readonly AggressiveTradeV1[];
}

export interface OrderBookFeatureVectorV1 {
  schemaVersion: typeof ORDER_BOOK_FEATURE_SCHEMA_V1;
  names: readonly string[];
  values: readonly number[];
  byName: Readonly<Record<string, number>>;
  anchorSequence: number;
  anchorExchangeTs: number;
  previousSequence: number | null;
  latestFeatureInputExchangeTs: number;
}

export interface FutureMidReturnLabelV1 {
  schemaVersion: typeof ORDER_BOOK_LABEL_SCHEMA_V1;
  horizonMs: number;
  targetExchangeTs: number;
  observedExchangeTs: number;
  alignmentDelayMs: number;
  anchorSequence: number;
  futureSequence: number;
  returnBps: number;
}

export interface LabelPolicyV1 {
  horizonsMs: readonly number[];
  maximumAlignmentDelayMs: number;
}

export interface SnapshotLabelsV1 {
  anchorSequence: number;
  anchorExchangeTs: number;
  labels: readonly FutureMidReturnLabelV1[];
}

export interface OrderBookDatasetRowV1 {
  schemaVersion: typeof ORDER_BOOK_DATASET_ROW_SCHEMA_V1;
  rowId: string;
  features: {
    schemaVersion: typeof ORDER_BOOK_FEATURE_SCHEMA_V1;
    names: readonly string[];
    values: readonly number[];
  };
  labels: readonly FutureMidReturnLabelV1[];
  provenance: {
    snapshotSchemaVersion: typeof SEQUENCED_L2_SNAPSHOT_SCHEMA_V1;
    normalizationSchemaVersion: typeof ORDER_BOOK_NORMALIZATION_SCHEMA_V1;
    featureSchemaVersion: typeof ORDER_BOOK_FEATURE_SCHEMA_V1;
    labelSchemaVersion: typeof ORDER_BOOK_LABEL_SCHEMA_V1;
    venue: string;
    market: string;
    instrumentId: string;
    symbol: string;
    source: "websocket-reconstructed";
    normalizerVersion: string;
    connectionGeneration: number;
    sequenceStart: number;
    sequence: number;
    previousSequence: number | null;
    exchangeTs: number;
    receivedAt: number;
    exchangeTimestampSource: "event-time" | "matching-engine-time";
    checksumVerified?: boolean;
    qualityPolicy: SnapshotQualityPolicyV1;
    qualityEvidence: {
      evaluatedAt: number;
      receiveAgeMs: number;
      exchangeAgeMs: number;
      effectiveAgeMs: number;
      transportLagMs: number;
      sequenceContinuous: true;
      sorted: true;
      positive: true;
      uncrossed: true;
      fresh: true;
    };
    normalizedDepth: number;
    featureInput: {
      firstSequence: number;
      lastSequence: number;
      maximumExchangeTs: number;
    };
    labelInputs: readonly {
      horizonMs: number;
      targetExchangeTs: number;
      observedExchangeTs: number;
      futureSequence: number;
    }[];
    tradeFlowInput:
      | { available: false }
      | {
          available: true;
          startExclusiveExchangeTs: number;
          endInclusiveExchangeTs: number;
          eventCount: number;
        };
    behaviorScope: "anonymous-aggregate-liquidity";
    participantIdentityInferred: false;
  };
}
