import { assertAdjacent, midPrice } from "./features.js";
import {
  ORDER_BOOK_LABEL_SCHEMA_V1,
  type FutureMidReturnLabelV1,
  type LabelPolicyV1,
  type NormalizedL2SnapshotV1,
  type SnapshotLabelsV1
} from "./types.js";

/**
 * Builds offline labels from the first observation at/after each future target.
 * Candidate search always begins at anchor + 1; no current/past sample can be a label.
 */
export function buildFutureMidReturnLabelsV1(snapshots: readonly NormalizedL2SnapshotV1[], policy: LabelPolicyV1): readonly SnapshotLabelsV1[] {
  assertLabelPolicy(policy);
  assertContinuousSeries(snapshots);
  return snapshots.map((anchor, anchorIndex) => {
    const anchorMid = midPrice(anchor);
    const labels: FutureMidReturnLabelV1[] = [];
    let candidateIndex = anchorIndex + 1;
    for (const horizonMs of policy.horizonsMs) {
      const targetExchangeTs = anchor.exchangeTs + horizonMs;
      while (candidateIndex < snapshots.length && snapshots[candidateIndex]!.exchangeTs < targetExchangeTs) candidateIndex += 1;
      const future = snapshots[candidateIndex];
      if (!future) continue;
      const alignmentDelayMs = future.exchangeTs - targetExchangeTs;
      if (alignmentDelayMs > policy.maximumAlignmentDelayMs) continue;
      if (candidateIndex <= anchorIndex || future.exchangeTs <= anchor.exchangeTs) throw new Error("Label builder attempted to use a non-future observation");
      labels.push({
        schemaVersion: ORDER_BOOK_LABEL_SCHEMA_V1,
        horizonMs,
        targetExchangeTs,
        observedExchangeTs: future.exchangeTs,
        alignmentDelayMs,
        anchorSequence: anchor.sequence,
        futureSequence: future.sequence,
        returnBps: (midPrice(future) / anchorMid - 1) * 10_000
      });
    }
    return { anchorSequence: anchor.sequence, anchorExchangeTs: anchor.exchangeTs, labels };
  });
}

export function assertContinuousSeries(snapshots: readonly NormalizedL2SnapshotV1[]) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) throw new Error("Label input must contain at least one normalized snapshot");
  for (let index = 0; index < snapshots.length; index += 1) {
    const current = snapshots[index]!;
    const previous = index === 0 ? undefined : snapshots[index - 1];
    assertAdjacent(current, previous);
    if (index > 0 && current.exchangeTs < snapshots[index - 1]!.exchangeTs) throw new Error("Label timestamps must not regress");
  }
}

function assertLabelPolicy(policy: LabelPolicyV1) {
  if (!policy || !Array.isArray(policy.horizonsMs) || policy.horizonsMs.length === 0) throw new RangeError("At least one label horizon is required");
  if (!Number.isSafeInteger(policy.maximumAlignmentDelayMs) || policy.maximumAlignmentDelayMs < 0) throw new RangeError("maximumAlignmentDelayMs must be a non-negative safe integer");
  let previous = 0;
  for (const horizon of policy.horizonsMs) {
    if (!Number.isSafeInteger(horizon) || horizon <= previous) throw new RangeError("Label horizons must be strictly increasing positive safe integers");
    previous = horizon;
  }
}
