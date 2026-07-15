import { MAX_L2_INPUT_LEVELS, ORDER_BOOK_NORMALIZATION_SCHEMA_V1, SEQUENCED_L2_SNAPSHOT_SCHEMA_V1, type NormalizedL2SnapshotV1, type ReadonlyL2Level, type SequencedL2SnapshotV1, type SnapshotQualityIssue, type SnapshotQualityPolicyV1 } from "./types.js";

export type SnapshotQualityAssessmentV1 = { accepted: true; snapshot: NormalizedL2SnapshotV1 } | { accepted: false; issues: readonly SnapshotQualityIssue[] };

export class OrderBookQualityError extends Error {
  constructor(readonly issues: readonly SnapshotQualityIssue[]) {
    super(`Order-book snapshot rejected: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
    this.name = "OrderBookQualityError";
  }
}

export interface SnapshotQualityContextV1 {
  now: number;
  policy: SnapshotQualityPolicyV1;
  previous?: unknown;
}

/** Returns a bounded immutable copy or fails closed with stable reason codes. */
export function assessAndNormalizeSnapshotV1(input: unknown, context: SnapshotQualityContextV1): SnapshotQualityAssessmentV1 {
  assertPolicy(context.policy);
  if (!positiveSafeInteger(context.now)) throw new RangeError("Order-book quality evaluation time must be a positive safe integer");

  const issues: SnapshotQualityIssue[] = [];
  const current = parseEnvelope(input, context.policy.maximumInputDepth, issues, "current");
  const previousIssues: SnapshotQualityIssue[] = [];
  const previous = context.previous === undefined ? undefined : parseEnvelope(context.previous, context.policy.maximumInputDepth, previousIssues, "previous");
  issues.push(...previousIssues);
  if (!current || (context.previous !== undefined && !previous)) return { accepted: false, issues };

  assessDepth(current, context.policy.normalizedDepth, issues, "current");
  if (previous) assessDepth(previous, context.policy.normalizedDepth, issues, "previous");
  assessFreshness(current, context.now, context.policy, issues, "current");
  if (previous) assessFreshness(previous, context.now, context.policy, issues, "previous");
  assessContinuity(current, previous, issues);
  if (issues.length > 0) return { accepted: false, issues };

  const receiveAgeMs = Math.max(0, context.now - current.receivedAt);
  const exchangeAgeMs = Math.max(0, context.now - current.exchangeTs);
  const snapshot: NormalizedL2SnapshotV1 = {
    ...current,
    bids: copyLevels(current.bids, context.policy.normalizedDepth),
    asks: copyLevels(current.asks, context.policy.normalizedDepth),
    normalization: {
      schemaVersion: ORDER_BOOK_NORMALIZATION_SCHEMA_V1,
      depth: context.policy.normalizedDepth,
      sourceBidDepth: current.bids.length,
      sourceAskDepth: current.asks.length
    },
    quality: {
      policy: copyPolicy(context.policy),
      evaluatedAt: context.now,
      receiveAgeMs,
      exchangeAgeMs,
      effectiveAgeMs: Math.max(receiveAgeMs, exchangeAgeMs),
      transportLagMs: current.receivedAt - current.exchangeTs,
      sequenceContinuous: true,
      sorted: true,
      positive: true,
      uncrossed: true,
      fresh: true
    }
  };
  return { accepted: true, snapshot };
}

function assessDepth(snapshot: SequencedL2SnapshotV1, requiredDepth: number, issues: SnapshotQualityIssue[], label: string) {
  if (snapshot.bids.length < requiredDepth || snapshot.asks.length < requiredDepth) {
    add(issues, "insufficient-depth", `${label} snapshot has fewer than ${requiredDepth} levels on at least one side`);
  }
}

export function normalizeSnapshotOrThrowV1(input: unknown, context: SnapshotQualityContextV1): NormalizedL2SnapshotV1 {
  const result = assessAndNormalizeSnapshotV1(input, context);
  if (!result.accepted) throw new OrderBookQualityError(result.issues);
  return result.snapshot;
}

function parseEnvelope(input: unknown, maximumInputDepth: number, issues: SnapshotQualityIssue[], label: string): SequencedL2SnapshotV1 | undefined {
  if (!record(input)) {
    add(issues, "invalid-envelope", `${label} snapshot must be an object`);
    return undefined;
  }
  const stringFields = ["venue", "market", "instrumentId", "symbol", "normalizerVersion"] as const;
  for (const field of stringFields) {
    if (!boundedText(input[field])) add(issues, "invalid-envelope", `${label}.${field} must be a non-empty bounded string`);
  }
  if (input.schemaVersion !== SEQUENCED_L2_SNAPSHOT_SCHEMA_V1) add(issues, "invalid-envelope", `${label}.schemaVersion is unsupported`);
  if (input.source !== "websocket-reconstructed") add(issues, "invalid-envelope", `${label}.source must be websocket-reconstructed`);
  if (input.exchangeTimestampSource !== "event-time" && input.exchangeTimestampSource !== "matching-engine-time") {
    add(issues, "invalid-envelope", `${label}.exchangeTimestampSource is unsupported`);
  }
  if (input.sequenceVerified !== true) add(issues, "unverified-sequence", `${label}.sequenceVerified must be true`);

  const sequenceStart = safeInteger(input.sequenceStart);
  const sequence = safeInteger(input.sequence);
  const previousSequence = input.previousSequence === null ? null : safeInteger(input.previousSequence);
  if (sequenceStart === undefined || sequence === undefined || sequenceStart > sequence || previousSequence === undefined || (previousSequence !== null && previousSequence >= sequence)) {
    add(issues, "invalid-sequence", `${label} sequence range/predecessor is invalid`);
  }

  const exchangeTs = positiveInteger(input.exchangeTs);
  const receivedAt = positiveInteger(input.receivedAt);
  const connectionGeneration = positiveInteger(input.connectionGeneration);
  if (exchangeTs === undefined || receivedAt === undefined || connectionGeneration === undefined) {
    add(issues, "invalid-envelope", `${label} timestamps and connectionGeneration must be positive safe integers`);
  }

  const retainedDepth = positiveInteger(input.retainedDepth);
  if (retainedDepth === undefined || retainedDepth > MAX_L2_INPUT_LEVELS) {
    add(issues, "retained-depth-invalid", `${label}.retainedDepth must be within 1..${MAX_L2_INPUT_LEVELS}`);
  }
  if (input.checksumVerified !== undefined && typeof input.checksumVerified !== "boolean") {
    add(issues, "invalid-envelope", `${label}.checksumVerified must be boolean when present`);
  }

  const bids = parseLevels(input.bids, "bid", maximumInputDepth, issues, label);
  const asks = parseLevels(input.asks, "ask", maximumInputDepth, issues, label);
  if (bids && asks && bids.length > 0 && asks.length > 0 && bids[0]![0] >= asks[0]![0]) {
    add(issues, "crossed-or-locked", `${label} best bid must be strictly below best ask`);
  }
  if (retainedDepth !== undefined && bids && asks && retainedDepth < Math.max(bids.length, asks.length)) {
    add(issues, "retained-depth-invalid", `${label}.retainedDepth is smaller than the published side depth`);
  }
  if (!bids || !asks || sequenceStart === undefined || sequence === undefined || previousSequence === undefined || exchangeTs === undefined || receivedAt === undefined || connectionGeneration === undefined || retainedDepth === undefined) {
    return undefined;
  }
  if (issues.some((issue) => issue.message.startsWith(`${label}.`) || issue.message.startsWith(`${label} `))) return undefined;

  return {
    schemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
    venue: input.venue as string,
    market: input.market as string,
    instrumentId: input.instrumentId as string,
    symbol: input.symbol as string,
    bids,
    asks,
    sequenceStart,
    sequence,
    previousSequence,
    sequenceVerified: true,
    exchangeTs,
    exchangeTimestampSource: input.exchangeTimestampSource as SequencedL2SnapshotV1["exchangeTimestampSource"],
    receivedAt,
    connectionGeneration,
    source: "websocket-reconstructed",
    retainedDepth,
    normalizerVersion: input.normalizerVersion as string,
    ...(typeof input.checksumVerified === "boolean" ? { checksumVerified: input.checksumVerified } : {})
  };
}

function parseLevels(input: unknown, side: "bid" | "ask", maximum: number, issues: SnapshotQualityIssue[], label: string): ReadonlyL2Level[] | undefined {
  if (!Array.isArray(input)) {
    add(issues, "invalid-envelope", `${label}.${side}s must be an array`);
    return undefined;
  }
  if (input.length === 0) add(issues, "empty-side", `${label}.${side}s must not be empty`);
  if (input.length > maximum) add(issues, "depth-bound-exceeded", `${label}.${side}s exceed the configured input bound ${maximum}`);

  const levels: ReadonlyL2Level[] = [];
  let priorPrice: number | undefined;
  for (let index = 0; index < input.length && index < maximum + 1; index += 1) {
    const row = input[index];
    if (!Array.isArray(row) || row.length !== 2 || !positiveFinite(row[0]) || !positiveFinite(row[1])) {
      add(issues, "invalid-level", `${label}.${side}s[${index}] must contain finite positive price and quantity`);
      continue;
    }
    const price = row[0] as number;
    const quantity = row[1] as number;
    if (priorPrice !== undefined && (side === "bid" ? price >= priorPrice : price <= priorPrice)) {
      add(issues, "unsorted-levels", `${label}.${side}s must be strictly ${side === "bid" ? "descending" : "ascending"} with unique prices`);
    }
    priorPrice = price;
    levels.push([price, quantity]);
  }
  return levels;
}

function assessFreshness(snapshot: SequencedL2SnapshotV1, now: number, policy: SnapshotQualityPolicyV1, issues: SnapshotQualityIssue[], label: string) {
  if (snapshot.receivedAt > now + policy.maximumFutureSkewMs || snapshot.exchangeTs > now + policy.maximumFutureSkewMs) {
    add(issues, "timestamp-future", `${label} timestamp exceeds the configured future-skew allowance`);
  }
  const age = Math.max(0, now - snapshot.receivedAt, now - snapshot.exchangeTs);
  if (age > policy.maximumAgeMs) add(issues, "stale", `${label} effective age ${age}ms exceeds ${policy.maximumAgeMs}ms`);
}

function assessContinuity(current: SequencedL2SnapshotV1, previous: SequencedL2SnapshotV1 | undefined, issues: SnapshotQualityIssue[]) {
  if (!previous) {
    if (current.previousSequence !== null) add(issues, "sequence-gap", "current snapshot references a predecessor that was not supplied");
    return;
  }
  if (current.venue !== previous.venue || current.market !== previous.market || current.instrumentId !== previous.instrumentId || current.symbol !== previous.symbol || current.normalizerVersion !== previous.normalizerVersion || current.exchangeTimestampSource !== previous.exchangeTimestampSource) {
    add(issues, "stream-identity-changed", "adjacent snapshots must have identical source/instrument identity");
  }
  if (current.connectionGeneration !== previous.connectionGeneration) add(issues, "generation-changed", "adjacent snapshots cross a connection generation boundary");
  if (current.previousSequence !== previous.sequence || current.sequence <= previous.sequence || current.sequenceStart > previous.sequence + 1) {
    add(issues, "sequence-gap", `expected a range continuous from sequence ${previous.sequence}, received ${current.sequenceStart}..${current.sequence}`);
  }
  if (current.exchangeTs < previous.exchangeTs || current.receivedAt < previous.receivedAt) {
    add(issues, "timestamp-regression", "adjacent snapshot timestamps must not regress");
  }
}

function assertPolicy(policy: SnapshotQualityPolicyV1) {
  if (policy.schemaVersion !== "orderbook-quality-policy-v1") throw new RangeError("Unsupported order-book quality policy");
  if (!safeNonNegativeInteger(policy.maximumAgeMs) || !safeNonNegativeInteger(policy.maximumFutureSkewMs)) throw new RangeError("Order-book freshness limits must be non-negative safe integers");
  if (!positiveSafeInteger(policy.maximumInputDepth) || policy.maximumInputDepth > MAX_L2_INPUT_LEVELS) throw new RangeError(`maximumInputDepth must be within 1..${MAX_L2_INPUT_LEVELS}`);
  if (!positiveSafeInteger(policy.normalizedDepth) || policy.normalizedDepth > policy.maximumInputDepth) throw new RangeError("normalizedDepth must be within the configured input bound");
}

function copyPolicy(policy: SnapshotQualityPolicyV1): SnapshotQualityPolicyV1 {
  return { ...policy };
}

function copyLevels(levels: readonly ReadonlyL2Level[], depth: number): ReadonlyL2Level[] {
  return levels.slice(0, depth).map(([price, quantity]) => [price, quantity] as const);
}

function add(issues: SnapshotQualityIssue[], code: SnapshotQualityIssue["code"], message: string) {
  if (!issues.some((issue) => issue.code === code && issue.message === message)) issues.push({ code, message });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return positiveSafeInteger(value) ? value : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
