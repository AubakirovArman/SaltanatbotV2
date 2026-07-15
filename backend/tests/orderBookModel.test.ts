import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ORDER_BOOK_DATASET_ROW_SCHEMA_V1,
  ORDER_BOOK_FEATURE_SCHEMA_V1,
  ORDER_BOOK_LABEL_SCHEMA_V1,
  ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
  ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
  SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
  MAX_SIGNAL_TO_NOISE_V1,
  predictOrderBookReturnV1,
  splitOrderBookRowsChronologicallyV1,
  trainOrderBookRidgeModelV1,
  type NormalizedL2SnapshotV1,
  type OrderBookDatasetRowV1,
  type OrderBookFeatureVectorV1,
  type OrderBookRidgeModelV1
} from "../src/orderbook/ml/index.js";

const HORIZON_MS = 100;
const TRAINED_AT = 100_000;

describe("order-book ridge baseline", () => {
  it("purges labels crossing chronological split boundaries and fits scaler only on train", () => {
    const rows = dataset(120);
    const config = {
      horizonMs: HORIZON_MS,
      trainedAt: TRAINED_AT,
      ridgeLambda: 0.001,
      minimumRowsPerSplit: 20
    } as const;
    const split = splitOrderBookRowsChronologicallyV1(rows, config);

    expect(split.purgedTrainRows).toBe(1);
    expect(split.purgedValidationRows).toBe(1);
    expect(split.train.every((row) => target(row).observedExchangeTs < split.validationStartsAt)).toBe(true);
    expect(split.validation.every((row) => target(row).observedExchangeTs < split.testStartsAt)).toBe(true);

    const first = trainOrderBookRidgeModelV1(rows, config);
    const second = trainOrderBookRidgeModelV1(rows, config);
    expect(second.model).toEqual(first.model);
    expect(first.model.features.means[0]).toBeCloseTo(mean(split.train.map((row) => row.features.values[0]!)), 12);
    expect(first.model.metrics.test.rmseBps).toBeLessThan(0.1);
    expect(first.model.metrics.test.directionalAccuracy).toBeGreaterThan(0.95);
    expect(first.model.trainingWindow).toMatchObject({ purgedTrainRows: 1, purgedValidationRows: 1 });
    expect(first.model.scope).toMatchObject({
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false
    });
    expect(first.model.executionBoundary).toEqual({ researchOnly: true, paperOrders: false, liveOrders: false });
  });

  it("runs exact-schema inference, exposes contributions and marks OOD without calling it probability", () => {
    const { model } = trainOrderBookRidgeModelV1(dataset(120), {
      horizonMs: HORIZON_MS,
      trainedAt: TRAINED_AT,
      ridgeLambda: 0.001,
      minimumRowsPerSplit: 20,
      outOfDistributionZScore: 4
    });
    const snapshot = normalizedSnapshot(12_100, 121);
    const features = featureVector(121, 12_100, [1.5, -0.25]);
    const prediction = predictOrderBookReturnV1(model, { features, snapshot });

    expect(prediction.predictedReturnBps).toBeCloseTo(3.225, 1);
    expect(prediction.direction).toBe("up");
    expect(prediction.contributions.map((item) => item.feature)).toEqual(expect.arrayContaining(["imbalance", "spread"]));
    expect(prediction).not.toHaveProperty("probability");
    expect(prediction.participantIdentityInferred).toBe(false);
    expect(prediction.executionBoundary.liveOrders).toBe(false);

    const ood = predictOrderBookReturnV1(model, {
      snapshot: normalizedSnapshot(12_200, 122),
      features: featureVector(122, 12_200, [1_000, -1_000])
    });
    expect(ood.distribution.status).toBe("out-of-distribution");

    const extreme = rehashModel({
      ...model,
      parameters: { ...model.parameters, intercept: Number.MAX_VALUE, coefficients: model.parameters.coefficients.map(() => 0) },
      metrics: { ...model.metrics, validation: { ...model.metrics.validation, rmseBps: 0 } }
    });
    const bounded = predictOrderBookReturnV1(extreme, { snapshot, features });
    expect(bounded.signalToNoise).toBe(MAX_SIGNAL_TO_NOISE_V1);
    expect(Number.isFinite(bounded.signalToNoise)).toBe(true);
  });

  it("fails closed on schema, scope, freshness and identity leakage violations", () => {
    const rows = dataset(120);
    const { model } = trainOrderBookRidgeModelV1(rows, {
      horizonMs: HORIZON_MS,
      trainedAt: TRAINED_AT,
      minimumRowsPerSplit: 20
    });
    const snapshot = normalizedSnapshot(12_100, 121);
    const features = featureVector(121, 12_100, [1, 2]);

    expect(() =>
      predictOrderBookReturnV1(model, {
        snapshot,
        features: { ...features, names: ["spread", "imbalance"] }
      })
    ).toThrow(/schema/);
    expect(() =>
      predictOrderBookReturnV1(model, {
        snapshot: { ...snapshot, instrumentId: "test:spot:ETHUSDT" },
        features
      })
    ).toThrow(/scope/);
    expect(() =>
      predictOrderBookReturnV1(model, {
        snapshot: { ...snapshot, exchangeTimestampSource: "event-time" },
        features
      })
    ).toThrow(/scope/);
    expect(() =>
      predictOrderBookReturnV1(model, {
        snapshot: { ...snapshot, quality: { ...snapshot.quality, fresh: false as never } },
        features
      })
    ).toThrow(/quality evidence/);

    const identityLeak = rows.map((row, index) => (index === 10 ? { ...row, provenance: { ...row.provenance, participantIdentityInferred: true as never } } : row));
    expect(() =>
      trainOrderBookRidgeModelV1(identityLeak, {
        horizonMs: HORIZON_MS,
        trainedAt: TRAINED_AT,
        minimumRowsPerSplit: 20
      })
    ).toThrow(/participant identity/);

    const mixedTimestampSource = rows.map((row, index) => (index === 10 ? { ...row, provenance: { ...row.provenance, exchangeTimestampSource: "event-time" as const } } : row));
    expect(() =>
      trainOrderBookRidgeModelV1(mixedTimestampSource, {
        horizonMs: HORIZON_MS,
        trainedAt: TRAINED_AT,
        minimumRowsPerSplit: 20
      })
    ).toThrow(/instrument\/normalizer scope/);
  });

  it("rejects forged label provenance before it can weaken chronological purging", () => {
    const rows = dataset(120);
    const train = (candidate: OrderBookDatasetRowV1[]) =>
      splitOrderBookRowsChronologicallyV1(candidate, {
        horizonMs: HORIZON_MS,
        trainedAt: TRAINED_AT,
        minimumRowsPerSplit: 20
      });
    const tamper = (change: (row: OrderBookDatasetRowV1) => OrderBookDatasetRowV1) => {
      const candidate = [...rows];
      candidate[5] = change(rows[5]!);
      expect(() => train(candidate)).toThrow(/label provenance/);
    };
    tamper((row) => ({ ...row, labels: [{ ...row.labels[0]!, targetExchangeTs: row.labels[0]!.targetExchangeTs + 1 }] }));
    tamper((row) => ({ ...row, labels: [{ ...row.labels[0]!, anchorSequence: row.labels[0]!.anchorSequence + 1 }] }));
    tamper((row) => ({ ...row, labels: [{ ...row.labels[0]!, alignmentDelayMs: 1 }] }));
    tamper((row) => ({ ...row, labels: [{ ...row.labels[0]!, futureSequence: row.labels[0]!.anchorSequence }] }));
    tamper((row) => ({
      ...row,
      provenance: { ...row.provenance, labelInputs: [{ ...row.provenance.labelInputs[0]!, observedExchangeTs: row.provenance.labelInputs[0]!.observedExchangeTs + 1 }] }
    }));
  });

  it("accepts a valid capture stream whose source sequence starts at zero", () => {
    const rows = dataset(120);
    const first = rows[0]!;
    rows[0] = {
      ...first,
      labels: [{ ...first.labels[0]!, anchorSequence: 0, futureSequence: 1 }],
      provenance: {
        ...first.provenance,
        sequenceStart: 0,
        sequence: 0,
        previousSequence: null,
        featureInput: { ...first.provenance.featureInput, firstSequence: 0, lastSequence: 0 },
        labelInputs: [{ ...first.provenance.labelInputs[0]!, futureSequence: 1 }]
      }
    };
    expect(
      splitOrderBookRowsChronologicallyV1(rows, {
        horizonMs: HORIZON_MS,
        trainedAt: TRAINED_AT,
        minimumRowsPerSplit: 20
      }).train.length
    ).toBeGreaterThanOrEqual(20);
  });
});

function rehashModel(model: OrderBookRidgeModelV1): OrderBookRidgeModelV1 {
  const draft = { ...model, modelId: "" };
  return { ...draft, modelId: `ob-ridge:${createHash("sha256").update(JSON.stringify(draft)).digest("hex")}` };
}

function dataset(count: number): OrderBookDatasetRowV1[] {
  return Array.from({ length: count }, (_, index) => {
    const exchangeTs = 100 + index * HORIZON_MS;
    const imbalance = (index - count / 2) / 20;
    const spread = Math.sin(index / 3);
    const returnBps = 0.1 + 2 * imbalance - 0.5 * spread;
    return {
      schemaVersion: ORDER_BOOK_DATASET_ROW_SCHEMA_V1,
      rowId: `row:${index}`,
      features: {
        schemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
        names: ["imbalance", "spread"],
        values: [imbalance, spread]
      },
      labels: [
        {
          schemaVersion: ORDER_BOOK_LABEL_SCHEMA_V1,
          horizonMs: HORIZON_MS,
          targetExchangeTs: exchangeTs + HORIZON_MS,
          observedExchangeTs: exchangeTs + HORIZON_MS,
          alignmentDelayMs: 0,
          anchorSequence: index + 1,
          futureSequence: index + 2,
          returnBps
        }
      ],
      provenance: {
        snapshotSchemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
        normalizationSchemaVersion: ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
        featureSchemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
        labelSchemaVersion: ORDER_BOOK_LABEL_SCHEMA_V1,
        venue: "test",
        market: "spot",
        instrumentId: "test:spot:BTCUSDT",
        symbol: "BTCUSDT",
        source: "websocket-reconstructed",
        normalizerVersion: "test-v1",
        connectionGeneration: 1,
        sequenceStart: index + 1,
        sequence: index + 1,
        previousSequence: index === 0 ? null : index,
        exchangeTs,
        receivedAt: exchangeTs + 1,
        exchangeTimestampSource: "matching-engine-time",
        qualityPolicy: {
          schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
          maximumAgeMs: 1_000,
          maximumFutureSkewMs: 5,
          maximumInputDepth: 20,
          normalizedDepth: 10
        },
        qualityEvidence: {
          evaluatedAt: exchangeTs + 1,
          receiveAgeMs: 0,
          exchangeAgeMs: 1,
          effectiveAgeMs: 1,
          transportLagMs: 1,
          sequenceContinuous: true,
          sorted: true,
          positive: true,
          uncrossed: true,
          fresh: true
        },
        normalizedDepth: 10,
        featureInput: { firstSequence: Math.max(1, index), lastSequence: index + 1, maximumExchangeTs: exchangeTs },
        labelInputs: [{ horizonMs: HORIZON_MS, targetExchangeTs: exchangeTs + HORIZON_MS, observedExchangeTs: exchangeTs + HORIZON_MS, futureSequence: index + 2 }],
        tradeFlowInput: { available: false },
        behaviorScope: "anonymous-aggregate-liquidity",
        participantIdentityInferred: false
      }
    };
  });
}

function target(row: OrderBookDatasetRowV1) {
  return row.labels.find((label) => label.horizonMs === HORIZON_MS)!;
}

function featureVector(sequence: number, exchangeTs: number, values: number[]): OrderBookFeatureVectorV1 {
  return {
    schemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
    names: ["imbalance", "spread"],
    values,
    byName: { imbalance: values[0]!, spread: values[1]! },
    anchorSequence: sequence,
    anchorExchangeTs: exchangeTs,
    previousSequence: sequence - 1,
    latestFeatureInputExchangeTs: exchangeTs
  };
}

function normalizedSnapshot(exchangeTs: number, sequence: number): NormalizedL2SnapshotV1 {
  return {
    schemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
    venue: "test",
    market: "spot",
    instrumentId: "test:spot:BTCUSDT",
    symbol: "BTCUSDT",
    bids: Array.from({ length: 10 }, (_, index) => [100 - index, 1] as const),
    asks: Array.from({ length: 10 }, (_, index) => [102 + index, 1] as const),
    sequenceStart: sequence,
    sequence,
    previousSequence: sequence - 1,
    sequenceVerified: true,
    exchangeTs,
    exchangeTimestampSource: "matching-engine-time",
    receivedAt: exchangeTs + 1,
    connectionGeneration: 1,
    source: "websocket-reconstructed",
    retainedDepth: 20,
    normalizerVersion: "test-v1",
    normalization: {
      schemaVersion: ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
      depth: 10,
      sourceBidDepth: 10,
      sourceAskDepth: 10
    },
    quality: {
      policy: {
        schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
        maximumAgeMs: 1_000,
        maximumFutureSkewMs: 5,
        maximumInputDepth: 20,
        normalizedDepth: 10
      },
      evaluatedAt: exchangeTs + 1,
      receiveAgeMs: 0,
      exchangeAgeMs: 1,
      effectiveAgeMs: 1,
      transportLagMs: 1,
      sequenceContinuous: true,
      sorted: true,
      positive: true,
      uncrossed: true,
      fresh: true
    }
  };
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
