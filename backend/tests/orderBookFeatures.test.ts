import { describe, expect, it } from "vitest";
import {
  ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
  SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
  assessAndNormalizeSnapshotV1,
  buildFutureMidReturnLabelsV1,
  buildOrderBookDatasetRowsV1,
  extractOrderBookFeaturesV1,
  normalizeSnapshotOrThrowV1,
  type NormalizedL2SnapshotV1,
  type SequencedL2SnapshotV1,
  type SnapshotQualityPolicyV1
} from "../src/orderbook/ml/index.js";

const POLICY: SnapshotQualityPolicyV1 = {
  schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
  maximumAgeMs: 1_000,
  maximumFutureSkewMs: 5,
  maximumInputDepth: 20,
  normalizedDepth: 10
};

describe("order-book ML feature foundation", () => {
  it("normalizes bounded strict depth and calculates deterministic v1 feature math", () => {
    const previousRaw = rawSnapshot(1, 1_000);
    const currentRaw = rawSnapshot(2, 1_010, 101, { bidQuantities: [3, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    const previous = normalizeSnapshotOrThrowV1(previousRaw, { now: 1_001, policy: POLICY });
    const current = normalizeSnapshotOrThrowV1(currentRaw, { now: 1_011, policy: POLICY, previous: previousRaw });
    const before = JSON.stringify({ previousRaw, currentRaw });
    const input = {
      current,
      previous,
      tradeFlow: {
        startExclusiveExchangeTs: 1_000,
        endInclusiveExchangeTs: 1_010,
        trades: [
          { id: "buy", price: 102, quantity: 2, side: "buy" as const, exchangeTs: 1_005 },
          { id: "sell", price: 100, quantity: 1, side: "sell" as const, exchangeTs: 1_008 }
        ]
      }
    };

    const features = extractOrderBookFeaturesV1(input);
    expect(features.byName.mid_price).toBe(101);
    expect(features.byName.spread_bps).toBeCloseTo((2 / 101) * 10_000, 12);
    expect(features.byName.microprice).toBe(101.5);
    expect(features.byName.microprice_offset_bps).toBeCloseTo((0.5 / 101) * 10_000, 12);
    expect(features.byName.bid_ask_imbalance_l1).toBe(0.5);
    expect(features.byName.bid_ask_imbalance_l5).toBeCloseTo(1 / 6, 12);
    expect(features.byName.bid_ask_imbalance_l10).toBeCloseTo(1 / 11, 12);
    expect(features.byName.order_flow_imbalance_l1).toBeCloseTo(2 / 3, 12);
    expect(features.byName.bid_depth_concentration_l1_l10).toBe(0.25);
    expect(features.byName.ask_depth_concentration_l1_l10).toBe(0.1);
    expect(features.byName.bid_slope_bps_per_level_l10).toBeCloseTo((1 / 101) * 10_000, 12);
    expect(features.byName.ask_slope_bps_per_level_l10).toBeCloseTo((1 / 101) * 10_000, 12);
    expect(features.byName.bid_refill_ratio_l10).toBe(0.2);
    expect(features.byName.anonymous_liquidity_net_imbalance_l10).toBe(0.1);
    expect(features.byName.trade_flow_available).toBe(1);
    expect(features.byName.aggressive_buy_quantity).toBe(2);
    expect(features.byName.aggressive_sell_quantity).toBe(1);
    expect(features.byName.trade_flow_imbalance).toBeCloseTo(1 / 3, 12);
    expect(features.byName.cvd_window_quantity).toBe(1);
    expect(features.byName.cvd_window_depth_normalized).toBeCloseTo(1 / 11, 12);
    expect(features.names).toHaveLength(features.values.length);
    expect(extractOrderBookFeaturesV1(input)).toEqual(features);
    expect(JSON.stringify({ previousRaw, currentRaw })).toBe(before);
  });

  it("fails closed on gaps, stale/crossed/unsorted/non-positive data and insufficient depth", () => {
    const previous = rawSnapshot(1, 1_000);
    const cases: Array<{ input: SequencedL2SnapshotV1; now: number; previous?: SequencedL2SnapshotV1; code: string }> = [
      {
        input: rawSnapshot(3, 1_010, 101, { sequenceStart: 3, previousSequence: 1 }),
        now: 1_011,
        previous,
        code: "sequence-gap"
      },
      {
        input: rawSnapshot(2, 1_010, 101, { exchangeTimestampSource: "event-time" }),
        now: 1_011,
        previous,
        code: "stream-identity-changed"
      },
      { input: rawSnapshot(1, 1_000), now: 2_001, code: "stale" },
      {
        input: rawSnapshot(1, 1_000, 101, { bids: [[103, 1], ...levels(99, -1, 9)] }),
        now: 1_001,
        code: "crossed-or-locked"
      },
      {
        input: rawSnapshot(1, 1_000, 101, { bids: [[99, 1], [100, 1], ...levels(98, -1, 8)] }),
        now: 1_001,
        code: "unsorted-levels"
      },
      {
        input: rawSnapshot(1, 1_000, 101, { bids: [[100, 0], ...levels(99, -1, 9)] }),
        now: 1_001,
        code: "invalid-level"
      },
      {
        input: rawSnapshot(1, 1_000, 101, { bids: levels(100, -1, 9), asks: levels(102, 1, 9) }),
        now: 1_001,
        code: "insufficient-depth"
      }
    ];

    for (const testCase of cases) {
      const result = assessAndNormalizeSnapshotV1(testCase.input, { now: testCase.now, policy: POLICY, previous: testCase.previous });
      expect(result.accepted, testCase.code).toBe(false);
      if (!result.accepted)
        expect(
          result.issues.map((issue) => issue.code),
          testCase.code
        ).toContain(testCase.code);
    }
  });

  it("truncates accepted source depth without sorting, padding or mutating it", () => {
    const input = rawSnapshot(1, 1_000, 101, {
      bids: levels(100, -1, 12),
      asks: levels(102, 1, 12),
      retainedDepth: 200
    });
    const result = normalizeSnapshotOrThrowV1(input, { now: 1_001, policy: POLICY });
    expect(result.bids).toHaveLength(10);
    expect(result.asks).toHaveLength(10);
    expect(result.normalization).toMatchObject({ depth: 10, sourceBidDepth: 12, sourceAskDepth: 12 });
    expect(input.bids).toHaveLength(12);
    expect(input.asks).toHaveLength(12);
  });

  it("builds horizon labels only from future observations and keeps future values out of features", () => {
    const base = normalizeSeries([rawSnapshot(1, 1_000, 101), rawSnapshot(2, 1_050, 106), rawSnapshot(3, 1_100, 111), rawSnapshot(4, 1_200, 121)]);
    const labelPolicy = { horizonsMs: [100], maximumAlignmentDelayMs: 0 } as const;
    const labels = buildFutureMidReturnLabelsV1(base, labelPolicy);
    expect(labels[0]!.labels[0]).toMatchObject({
      anchorSequence: 1,
      futureSequence: 3,
      targetExchangeTs: 1_100,
      observedExchangeTs: 1_100,
      alignmentDelayMs: 0
    });
    expect(labels[0]!.labels[0]!.returnBps).toBeCloseTo((111 / 101 - 1) * 10_000, 12);
    expect(labels[1]!.labels).toEqual([]);
    expect(labels[3]!.labels).toEqual([]);

    const rows = buildOrderBookDatasetRowsV1({ snapshots: base, labelPolicy });
    const first = rows.find((row) => row.provenance.sequence === 1)!;
    expect(first.provenance.featureInput.maximumExchangeTs).toBe(1_000);
    expect(first.provenance.labelInputs[0]!.observedExchangeTs).toBe(1_100);
    expect(first.provenance.participantIdentityInferred).toBe(false);
    expect(first.provenance.behaviorScope).toBe("anonymous-aggregate-liquidity");

    const changedFuture = normalizeSeries([rawSnapshot(1, 1_000, 101), rawSnapshot(2, 1_050, 106), rawSnapshot(3, 1_100, 151), rawSnapshot(4, 1_200, 121)]);
    const changedFirst = buildOrderBookDatasetRowsV1({ snapshots: changedFuture, labelPolicy }).find((row) => row.provenance.sequence === 1)!;
    expect(changedFirst.features).toEqual(first.features);
    expect(changedFirst.labels[0]!.returnBps).not.toBe(first.labels[0]!.returnBps);
    expect(buildOrderBookDatasetRowsV1({ snapshots: base, labelPolicy })).toEqual(rows);

    const aligned = buildFutureMidReturnLabelsV1(base, { horizonsMs: [100], maximumAlignmentDelayMs: 50 });
    expect(aligned[1]!.labels[0]).toMatchObject({ futureSequence: 4, targetExchangeTs: 1_150, observedExchangeTs: 1_200, alignmentDelayMs: 50 });
  });

  it("rejects forged gaps and trade-flow lookahead even after normalization", () => {
    const series = normalizeSeries([rawSnapshot(1, 1_000), rawSnapshot(2, 1_010)]);
    const forged = [{ ...series[0]! }, { ...series[1]!, previousSequence: 999 }];
    expect(() => buildFutureMidReturnLabelsV1(forged, { horizonsMs: [1], maximumAlignmentDelayMs: 20 })).toThrow(/sequence gap/);
    expect(() =>
      extractOrderBookFeaturesV1({
        current: series[1]!,
        previous: series[0]!,
        tradeFlow: { startExclusiveExchangeTs: 1_000, endInclusiveExchangeTs: 1_011, trades: [] }
      })
    ).toThrow(/lookahead/);
  });
});

function normalizeSeries(raw: readonly SequencedL2SnapshotV1[]): NormalizedL2SnapshotV1[] {
  return raw.map((snapshot, index) =>
    normalizeSnapshotOrThrowV1(snapshot, {
      now: snapshot.receivedAt,
      policy: POLICY,
      ...(index === 0 ? {} : { previous: raw[index - 1] })
    })
  );
}

interface SnapshotOverrides {
  bids?: readonly (readonly [number, number])[];
  asks?: readonly (readonly [number, number])[];
  bidQuantities?: readonly number[];
  askQuantities?: readonly number[];
  sequenceStart?: number;
  previousSequence?: number | null;
  retainedDepth?: number;
  exchangeTimestampSource?: SequencedL2SnapshotV1["exchangeTimestampSource"];
}

function rawSnapshot(sequence: number, exchangeTs: number, mid = 101, overrides: SnapshotOverrides = {}): SequencedL2SnapshotV1 {
  const bids = overrides.bids ?? levels(mid - 1, -1, 10, overrides.bidQuantities);
  const asks = overrides.asks ?? levels(mid + 1, 1, 10, overrides.askQuantities);
  return {
    schemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
    venue: "test-venue",
    market: "spot",
    instrumentId: "test-venue:spot:BTCUSDT",
    symbol: "BTCUSDT",
    bids,
    asks,
    sequenceStart: overrides.sequenceStart ?? sequence,
    sequence,
    previousSequence: overrides.previousSequence === undefined ? (sequence === 1 ? null : sequence - 1) : overrides.previousSequence,
    sequenceVerified: true,
    exchangeTs,
    exchangeTimestampSource: overrides.exchangeTimestampSource ?? "matching-engine-time",
    receivedAt: exchangeTs + 1,
    connectionGeneration: 1,
    source: "websocket-reconstructed",
    retainedDepth: overrides.retainedDepth ?? 20,
    normalizerVersion: "test-l2-v1"
  };
}

function levels(start: number, step: number, count: number, quantities: readonly number[] = []): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_, index) => [start + step * index, quantities[index] ?? 1] as const);
}
