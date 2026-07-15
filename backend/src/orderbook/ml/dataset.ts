import { extractOrderBookFeaturesV1 } from "./features.js";
import { buildFutureMidReturnLabelsV1 } from "./labels.js";
import {
  ORDER_BOOK_DATASET_ROW_SCHEMA_V1,
  ORDER_BOOK_FEATURE_SCHEMA_V1,
  ORDER_BOOK_LABEL_SCHEMA_V1,
  ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
  SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
  type LabelPolicyV1,
  type NormalizedL2SnapshotV1,
  type OrderBookDatasetRowV1,
  type TradeFlowWindowV1
} from "./types.js";

export interface DatasetBuildInputV1 {
  snapshots: readonly NormalizedL2SnapshotV1[];
  labelPolicy: LabelPolicyV1;
  /** Same-index optional windows; every supplied window is validated as past-only. */
  tradeFlowWindows?: readonly (TradeFlowWindowV1 | undefined)[];
  /** Supervised rows normally require every configured horizon. */
  requireAllHorizons?: boolean;
}

/** Builds deterministic in-memory rows; persistence and dataset splitting are separate concerns. */
export function buildOrderBookDatasetRowsV1(input: DatasetBuildInputV1): readonly OrderBookDatasetRowV1[] {
  if (input.tradeFlowWindows && input.tradeFlowWindows.length !== input.snapshots.length) throw new Error("Trade-flow windows must align one-to-one with snapshots");
  const labelSets = buildFutureMidReturnLabelsV1(input.snapshots, input.labelPolicy);
  const requiredLabels = input.requireAllHorizons === false ? 1 : input.labelPolicy.horizonsMs.length;
  const rows: OrderBookDatasetRowV1[] = [];
  for (let index = 0; index < input.snapshots.length; index += 1) {
    const current = input.snapshots[index]!;
    const previous = index === 0 ? undefined : input.snapshots[index - 1];
    const tradeFlow = input.tradeFlowWindows?.[index];
    const labels = labelSets[index]!.labels;
    if (labels.length < requiredLabels) continue;
    const feature = extractOrderBookFeaturesV1({ current, previous, tradeFlow });
    rows.push({
      schemaVersion: ORDER_BOOK_DATASET_ROW_SCHEMA_V1,
      rowId: JSON.stringify([current.venue, current.market, current.instrumentId, current.connectionGeneration, current.sequence]),
      features: {
        schemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
        names: [...feature.names],
        values: [...feature.values]
      },
      labels: labels.map((label) => ({ ...label })),
      provenance: {
        snapshotSchemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
        normalizationSchemaVersion: ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
        featureSchemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
        labelSchemaVersion: ORDER_BOOK_LABEL_SCHEMA_V1,
        venue: current.venue,
        market: current.market,
        instrumentId: current.instrumentId,
        symbol: current.symbol,
        source: current.source,
        normalizerVersion: current.normalizerVersion,
        connectionGeneration: current.connectionGeneration,
        sequenceStart: current.sequenceStart,
        sequence: current.sequence,
        previousSequence: current.previousSequence,
        exchangeTs: current.exchangeTs,
        receivedAt: current.receivedAt,
        exchangeTimestampSource: current.exchangeTimestampSource,
        ...(current.checksumVerified === undefined ? {} : { checksumVerified: current.checksumVerified }),
        qualityPolicy: { ...current.quality.policy },
        qualityEvidence: {
          evaluatedAt: current.quality.evaluatedAt,
          receiveAgeMs: current.quality.receiveAgeMs,
          exchangeAgeMs: current.quality.exchangeAgeMs,
          effectiveAgeMs: current.quality.effectiveAgeMs,
          transportLagMs: current.quality.transportLagMs,
          sequenceContinuous: true,
          sorted: true,
          positive: true,
          uncrossed: true,
          fresh: true
        },
        normalizedDepth: current.normalization.depth,
        featureInput: {
          firstSequence: previous?.sequence ?? current.sequence,
          lastSequence: current.sequence,
          maximumExchangeTs: feature.latestFeatureInputExchangeTs
        },
        labelInputs: labels.map((label) => ({
          horizonMs: label.horizonMs,
          targetExchangeTs: label.targetExchangeTs,
          observedExchangeTs: label.observedExchangeTs,
          futureSequence: label.futureSequence
        })),
        tradeFlowInput: tradeFlow
          ? {
              available: true,
              startExclusiveExchangeTs: tradeFlow.startExclusiveExchangeTs,
              endInclusiveExchangeTs: tradeFlow.endInclusiveExchangeTs,
              eventCount: tradeFlow.trades.length
            }
          : { available: false },
        behaviorScope: "anonymous-aggregate-liquidity",
        participantIdentityInferred: false
      }
    });
  }
  return rows;
}
