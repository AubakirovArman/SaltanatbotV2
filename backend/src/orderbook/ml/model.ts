import { createHash } from "node:crypto";
import type { NormalizedL2SnapshotV1, OrderBookDatasetRowV1, OrderBookFeatureVectorV1 } from "./types.js";
import { ORDER_BOOK_FEATURE_SCHEMA_V1 } from "./types.js";

export const ORDER_BOOK_RIDGE_MODEL_SCHEMA_V1 = "orderbook-ridge-model-v1" as const;
export const ORDER_BOOK_PREDICTION_SCHEMA_V1 = "orderbook-prediction-v1" as const;
export const MAX_MODEL_TRAINING_ROWS_V1 = 200_000;
export const MAX_MODEL_FEATURES_V1 = 128;
export const MAX_SIGNAL_TO_NOISE_V1 = 1_000_000_000_000;

export interface OrderBookModelTrainingConfigV1 {
  horizonMs: number;
  trainedAt: number;
  ridgeLambda?: number;
  trainFraction?: number;
  validationFraction?: number;
  minimumRowsPerSplit?: number;
  maximumRows?: number;
  flatThresholdBps?: number;
  outOfDistributionZScore?: number;
}

export interface ResolvedOrderBookModelTrainingConfigV1 {
  horizonMs: number;
  trainedAt: number;
  ridgeLambda: number;
  trainFraction: number;
  validationFraction: number;
  minimumRowsPerSplit: number;
  maximumRows: number;
  flatThresholdBps: number;
  outOfDistributionZScore: number;
}

export interface OrderBookModelMetricsV1 {
  rows: number;
  meanActualBps: number;
  meanPredictionBps: number;
  maeBps: number;
  rmseBps: number;
  directionalAccuracy: number;
  correlation: number;
}

export interface OrderBookChronologicalSplitV1 {
  train: OrderBookDatasetRowV1[];
  validation: OrderBookDatasetRowV1[];
  test: OrderBookDatasetRowV1[];
  excludedMissingLabel: number;
  purgedTrainRows: number;
  purgedValidationRows: number;
  validationStartsAt: number;
  testStartsAt: number;
}

export interface OrderBookRidgeModelV1 {
  schemaVersion: typeof ORDER_BOOK_RIDGE_MODEL_SCHEMA_V1;
  modelId: string;
  algorithm: "ridge-linear-regression";
  target: {
    schemaVersion: "future-mid-return-v1";
    horizonMs: number;
    unit: "basis-points";
  };
  scope: {
    venue: string;
    market: string;
    instrumentId: string;
    symbol: string;
    normalizerVersion: string;
    exchangeTimestampSource: "event-time" | "matching-engine-time";
    behaviorScope: "anonymous-aggregate-liquidity";
    participantIdentityInferred: false;
  };
  features: {
    schemaVersion: typeof ORDER_BOOK_FEATURE_SCHEMA_V1;
    names: string[];
    means: number[];
    scales: number[];
  };
  parameters: {
    intercept: number;
    coefficients: number[];
    ridgeLambda: number;
  };
  decisionPolicy: {
    flatThresholdBps: number;
    outOfDistributionZScore: number;
  };
  trainedAt: number;
  trainingWindow: {
    firstExchangeTs: number;
    lastExchangeTs: number;
    connectionGenerations: number[];
    trainRows: number;
    validationRows: number;
    testRows: number;
    purgedTrainRows: number;
    purgedValidationRows: number;
  };
  metrics: {
    train: OrderBookModelMetricsV1;
    validation: OrderBookModelMetricsV1;
    test: OrderBookModelMetricsV1;
  };
  executionBoundary: {
    researchOnly: true;
    paperOrders: false;
    liveOrders: false;
  };
}

export interface OrderBookModelTrainingResultV1 {
  model: OrderBookRidgeModelV1;
  split: OrderBookChronologicalSplitV1;
}

export interface OrderBookInferenceInputV1 {
  features: OrderBookFeatureVectorV1;
  snapshot: NormalizedL2SnapshotV1;
}

export interface OrderBookPredictionV1 {
  schemaVersion: typeof ORDER_BOOK_PREDICTION_SCHEMA_V1;
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
  executionBoundary: {
    researchOnly: true;
    paperOrders: false;
    liveOrders: false;
  };
}

/**
 * Chronological split with a purged boundary: a training label may not observe
 * a snapshot at/after validation start, and a validation label may not observe
 * a snapshot at/after test start.
 */
export function splitOrderBookRowsChronologicallyV1(input: readonly OrderBookDatasetRowV1[], config: OrderBookModelTrainingConfigV1): OrderBookChronologicalSplitV1 {
  const resolved = resolveTrainingConfig(config);
  if (!Array.isArray(input) || input.length > resolved.maximumRows) {
    throw new RangeError(`Order-book model input must contain at most ${resolved.maximumRows} rows`);
  }
  const sourceRows: readonly OrderBookDatasetRowV1[] = input;
  const seen = new Set<string>();
  let excludedMissingLabel = 0;
  const labeled = sourceRows
    .map((row) => {
      assertDatasetRow(row);
      if (seen.has(row.rowId)) throw new Error(`Duplicate order-book dataset row ${row.rowId}`);
      seen.add(row.rowId);
      const labels = row.labels.filter((label) => label.horizonMs === resolved.horizonMs);
      if (labels.length > 1) throw new Error(`Dataset row ${row.rowId} has duplicate target labels`);
      if (labels.length === 0) excludedMissingLabel += 1;
      return labels[0] ? { row, label: labels[0] } : undefined;
    })
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) => left.row.provenance.exchangeTs - right.row.provenance.exchangeTs || left.row.rowId.localeCompare(right.row.rowId));

  const minimumTotal = resolved.minimumRowsPerSplit * 3;
  if (labeled.length < minimumTotal) throw new Error(`Order-book model requires at least ${minimumTotal} labeled rows`);
  for (let index = 1; index < labeled.length; index += 1) {
    if (labeled[index]!.row.provenance.exchangeTs < labeled[index - 1]!.row.provenance.exchangeTs) {
      throw new Error("Order-book model row timestamps regressed");
    }
  }

  let trainCut = Math.max(1, Math.min(labeled.length - 2, Math.floor(labeled.length * resolved.trainFraction)));
  while (trainCut < labeled.length - 2 && labeled[trainCut]!.row.provenance.exchangeTs === labeled[trainCut - 1]!.row.provenance.exchangeTs) trainCut += 1;
  let testCut = Math.max(trainCut + 1, Math.min(labeled.length - 1, Math.floor(labeled.length * (resolved.trainFraction + resolved.validationFraction))));
  while (testCut < labeled.length - 1 && labeled[testCut]!.row.provenance.exchangeTs === labeled[testCut - 1]!.row.provenance.exchangeTs) testCut += 1;
  const validationStartsAt = labeled[trainCut]!.row.provenance.exchangeTs;
  const testStartsAt = labeled[testCut]!.row.provenance.exchangeTs;
  const rawTrain = labeled.slice(0, trainCut);
  const rawValidation = labeled.slice(trainCut, testCut);
  const train = rawTrain.filter(({ label }) => label.observedExchangeTs < validationStartsAt).map(({ row }) => row);
  const validation = rawValidation.filter(({ label }) => label.observedExchangeTs < testStartsAt).map(({ row }) => row);
  const test = labeled.slice(testCut).map(({ row }) => row);

  for (const [name, rows] of [
    ["train", train],
    ["validation", validation],
    ["test", test]
  ] as const) {
    if (rows.length < resolved.minimumRowsPerSplit) {
      throw new Error(`Purged chronological ${name} split has ${rows.length} rows; ${resolved.minimumRowsPerSplit} required`);
    }
  }
  return {
    train,
    validation,
    test,
    excludedMissingLabel,
    purgedTrainRows: rawTrain.length - train.length,
    purgedValidationRows: rawValidation.length - validation.length,
    validationStartsAt,
    testStartsAt
  };
}

export function trainOrderBookRidgeModelV1(rows: readonly OrderBookDatasetRowV1[], config: OrderBookModelTrainingConfigV1): OrderBookModelTrainingResultV1 {
  const resolved = resolveTrainingConfig(config);
  const split = splitOrderBookRowsChronologicallyV1(rows, config);
  const scope = assertOneTrainingScope([...split.train, ...split.validation, ...split.test]);
  const names = [...split.train[0]!.features.names];
  if (names.length === 0 || names.length > MAX_MODEL_FEATURES_V1 || new Set(names).size !== names.length) {
    throw new Error(`Model feature schema must contain 1..${MAX_MODEL_FEATURES_V1} unique names`);
  }
  const training = split.train.map((row) => sample(row, resolved.horizonMs, names));
  const means = columnMeans(
    training.map((item) => item.x),
    names.length
  );
  const scales = columnScales(
    training.map((item) => item.x),
    means
  );
  const targetMean = mean(training.map((item) => item.y));
  const system = Array.from({ length: names.length }, () => Array<number>(names.length).fill(0));
  const target = Array<number>(names.length).fill(0);
  for (const item of training) {
    const x = standardize(item.x, means, scales);
    const centeredTarget = item.y - targetMean;
    for (let left = 0; left < names.length; left += 1) {
      target[left] += x[left]! * centeredTarget;
      for (let right = 0; right < names.length; right += 1) system[left]![right] += x[left]! * x[right]!;
    }
  }
  for (let index = 0; index < names.length; index += 1) system[index]![index] += resolved.ridgeLambda;
  const coefficients = solveLinearSystem(system, target);
  const predictRow = (row: OrderBookDatasetRowV1) => {
    const value = sample(row, resolved.horizonMs, names);
    return targetMean + dot(coefficients, standardize(value.x, means, scales));
  };
  const metrics = {
    train: metricsFor(split.train, resolved.horizonMs, resolved.flatThresholdBps, predictRow),
    validation: metricsFor(split.validation, resolved.horizonMs, resolved.flatThresholdBps, predictRow),
    test: metricsFor(split.test, resolved.horizonMs, resolved.flatThresholdBps, predictRow)
  };
  const ordered = [...split.train, ...split.validation, ...split.test];
  const generations = [...new Set(ordered.map((row) => row.provenance.connectionGeneration))].sort((left, right) => left - right);
  const draft = {
    schemaVersion: ORDER_BOOK_RIDGE_MODEL_SCHEMA_V1,
    modelId: "",
    algorithm: "ridge-linear-regression",
    target: { schemaVersion: "future-mid-return-v1", horizonMs: resolved.horizonMs, unit: "basis-points" },
    scope,
    features: { schemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1, names, means, scales },
    parameters: { intercept: targetMean, coefficients, ridgeLambda: resolved.ridgeLambda },
    decisionPolicy: {
      flatThresholdBps: resolved.flatThresholdBps,
      outOfDistributionZScore: resolved.outOfDistributionZScore
    },
    trainedAt: resolved.trainedAt,
    trainingWindow: {
      firstExchangeTs: ordered[0]!.provenance.exchangeTs,
      lastExchangeTs: ordered.at(-1)!.provenance.exchangeTs,
      connectionGenerations: generations,
      trainRows: split.train.length,
      validationRows: split.validation.length,
      testRows: split.test.length,
      purgedTrainRows: split.purgedTrainRows,
      purgedValidationRows: split.purgedValidationRows
    },
    metrics,
    executionBoundary: { researchOnly: true, paperOrders: false, liveOrders: false }
  } satisfies Omit<OrderBookRidgeModelV1, "modelId"> & { modelId: string };
  const model: OrderBookRidgeModelV1 = {
    ...draft,
    modelId: `ob-ridge:${createHash("sha256").update(JSON.stringify(draft)).digest("hex")}`
  };
  assertOrderBookRidgeModelV1(model);
  return { model, split };
}

export function predictOrderBookReturnV1(model: OrderBookRidgeModelV1, input: OrderBookInferenceInputV1): OrderBookPredictionV1 {
  assertOrderBookRidgeModelV1(model);
  assertInferenceInput(model, input);
  const standardized = standardize(input.features.values, model.features.means, model.features.scales);
  const contributions = model.features.names
    .map((feature, index) => ({
      feature,
      standardizedValue: standardized[index]!,
      contributionBps: standardized[index]! * model.parameters.coefficients[index]!
    }))
    .sort((left, right) => Math.abs(right.contributionBps) - Math.abs(left.contributionBps) || left.feature.localeCompare(right.feature))
    .slice(0, 5);
  const predictedReturnBps = finite(model.parameters.intercept + dot(model.parameters.coefficients, standardized), "prediction");
  const maximumAbsoluteZScore = standardized.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const noise = Math.max(model.metrics.validation.rmseBps, 1e-9);
  return {
    schemaVersion: ORDER_BOOK_PREDICTION_SCHEMA_V1,
    modelId: model.modelId,
    instrumentId: input.snapshot.instrumentId,
    symbol: input.snapshot.symbol,
    horizonMs: model.target.horizonMs,
    anchorSequence: input.features.anchorSequence,
    anchorExchangeTs: input.features.anchorExchangeTs,
    predictedReturnBps,
    direction: direction(predictedReturnBps, model.decisionPolicy.flatThresholdBps),
    signalToNoise: Math.min(MAX_SIGNAL_TO_NOISE_V1, Math.abs(predictedReturnBps) / noise),
    distribution: {
      status: maximumAbsoluteZScore > model.decisionPolicy.outOfDistributionZScore ? "out-of-distribution" : "within-training-range",
      maximumAbsoluteZScore,
      threshold: model.decisionPolicy.outOfDistributionZScore
    },
    contributions,
    behaviorScope: "anonymous-aggregate-liquidity",
    participantIdentityInferred: false,
    executionBoundary: { researchOnly: true, paperOrders: false, liveOrders: false }
  };
}

export function assertOrderBookRidgeModelV1(model: OrderBookRidgeModelV1): void {
  if (!model || model.schemaVersion !== ORDER_BOOK_RIDGE_MODEL_SCHEMA_V1 || model.algorithm !== "ridge-linear-regression") throw new Error("Unsupported order-book model artifact");
  if (!model.modelId.startsWith("ob-ridge:") || model.modelId.length !== 73) throw new Error("Order-book model identity is invalid");
  const expectedModelId = `ob-ridge:${createHash("sha256")
    .update(JSON.stringify({ ...model, modelId: "" }))
    .digest("hex")}`;
  if (model.modelId !== expectedModelId) throw new Error("Order-book model integrity check failed");
  if (!positiveSafeInteger(model.trainedAt) || !positiveSafeInteger(model.target.horizonMs)) throw new Error("Order-book model timestamps/horizon are invalid");
  if (model.target.schemaVersion !== "future-mid-return-v1" || model.target.unit !== "basis-points") throw new Error("Order-book model target is invalid");
  if (model.scope.behaviorScope !== "anonymous-aggregate-liquidity" || model.scope.participantIdentityInferred !== false) throw new Error("Order-book model overstates participant identity");
  if ([model.scope.venue, model.scope.market, model.scope.instrumentId, model.scope.symbol, model.scope.normalizerVersion].some((value) => !value.trim() || value.length > 128)) throw new Error("Order-book model scope is invalid");
  if (model.scope.exchangeTimestampSource !== "event-time" && model.scope.exchangeTimestampSource !== "matching-engine-time") throw new Error("Order-book model timestamp scope is invalid");
  if (model.executionBoundary.researchOnly !== true || model.executionBoundary.paperOrders !== false || model.executionBoundary.liveOrders !== false) throw new Error("Order-book model execution boundary is invalid");
  const lengths = [model.features.names.length, model.features.means.length, model.features.scales.length, model.parameters.coefficients.length];
  if (lengths.some((length) => length < 1 || length > MAX_MODEL_FEATURES_V1 || length !== lengths[0])) throw new Error("Order-book model feature dimensions are inconsistent");
  if (new Set(model.features.names).size !== model.features.names.length || model.features.names.some((name) => !name.trim() || name.length > 128)) throw new Error("Order-book model feature names are invalid");
  for (const value of [...model.features.means, ...model.features.scales, ...model.parameters.coefficients, model.parameters.intercept]) finite(value, "model parameter");
  if (model.features.scales.some((value) => value <= 0) || model.parameters.ridgeLambda <= 0) throw new Error("Order-book model scale/regularization is invalid");
  if (!Number.isFinite(model.decisionPolicy.flatThresholdBps) || model.decisionPolicy.flatThresholdBps < 0 || !Number.isFinite(model.decisionPolicy.outOfDistributionZScore) || model.decisionPolicy.outOfDistributionZScore < 1) throw new Error("Order-book model decision policy is invalid");
  for (const value of Object.values(model.metrics)) {
    if (!positiveSafeInteger(value.rows) || !Number.isFinite(value.directionalAccuracy) || value.directionalAccuracy < 0 || value.directionalAccuracy > 1) throw new Error("Order-book model metrics are invalid");
    if (![value.meanActualBps, value.meanPredictionBps, value.maeBps, value.rmseBps, value.correlation].every(Number.isFinite) || value.maeBps < 0 || value.rmseBps < 0 || value.correlation < -1 || value.correlation > 1) throw new Error("Order-book model metrics are invalid");
  }
}

function assertInferenceInput(model: OrderBookRidgeModelV1, input: OrderBookInferenceInputV1) {
  const { features, snapshot } = input;
  if (features.schemaVersion !== ORDER_BOOK_FEATURE_SCHEMA_V1 || features.names.length !== model.features.names.length || features.names.some((name, index) => name !== model.features.names[index])) {
    throw new Error("Inference feature schema does not match the model");
  }
  if (features.values.length !== features.names.length || features.values.some((value) => !Number.isFinite(value))) throw new Error("Inference feature values are invalid");
  if (
    snapshot.venue !== model.scope.venue ||
    snapshot.market !== model.scope.market ||
    snapshot.instrumentId !== model.scope.instrumentId ||
    snapshot.symbol !== model.scope.symbol ||
    snapshot.normalizerVersion !== model.scope.normalizerVersion ||
    snapshot.exchangeTimestampSource !== model.scope.exchangeTimestampSource
  ) {
    throw new Error("Inference snapshot is outside the model scope");
  }
  if (features.anchorSequence !== snapshot.sequence || features.anchorExchangeTs !== snapshot.exchangeTs || features.latestFeatureInputExchangeTs > snapshot.exchangeTs) throw new Error("Inference feature provenance does not match its snapshot");
  if (snapshot.quality.fresh !== true || snapshot.quality.sequenceContinuous !== true || snapshot.quality.positive !== true || snapshot.quality.sorted !== true || snapshot.quality.uncrossed !== true) {
    throw new Error("Inference snapshot does not carry accepted quality evidence");
  }
}

function assertOneTrainingScope(rows: readonly OrderBookDatasetRowV1[]): OrderBookRidgeModelV1["scope"] {
  const first = rows[0]!.provenance;
  for (const row of rows) {
    const value = row.provenance;
    if (value.venue !== first.venue || value.market !== first.market || value.instrumentId !== first.instrumentId || value.symbol !== first.symbol || value.normalizerVersion !== first.normalizerVersion || value.exchangeTimestampSource !== first.exchangeTimestampSource) {
      throw new Error("Baseline order-book model requires one instrument/normalizer scope");
    }
    if (value.behaviorScope !== "anonymous-aggregate-liquidity" || value.participantIdentityInferred !== false) throw new Error("Dataset overstates participant identity");
  }
  return {
    venue: first.venue,
    market: first.market,
    instrumentId: first.instrumentId,
    symbol: first.symbol,
    normalizerVersion: first.normalizerVersion,
    exchangeTimestampSource: first.exchangeTimestampSource,
    behaviorScope: "anonymous-aggregate-liquidity",
    participantIdentityInferred: false
  };
}

function assertDatasetRow(row: OrderBookDatasetRowV1) {
  if (!row || row.schemaVersion !== "orderbook-dataset-row-v1" || row.features.schemaVersion !== ORDER_BOOK_FEATURE_SCHEMA_V1) throw new Error("Unsupported order-book dataset row");
  if (!row.rowId || row.rowId.length > 1_024 || row.features.names.length !== row.features.values.length || row.features.names.length > MAX_MODEL_FEATURES_V1) throw new Error("Order-book dataset feature dimensions are invalid");
  if (row.features.values.some((value) => !Number.isFinite(value))) throw new Error("Order-book dataset contains a non-finite feature");
  if (!positiveSafeInteger(row.provenance.exchangeTs)) throw new Error("Order-book dataset anchor timestamp is invalid");
  if (!nonNegativeSafeInteger(row.provenance.sequence) || !Array.isArray(row.provenance.labelInputs) || row.provenance.labelInputs.length !== row.labels.length) {
    throw new Error("Order-book dataset label provenance is invalid");
  }
  const inputsByHorizon = new Map(row.provenance.labelInputs.map((input) => [input.horizonMs, input]));
  if (inputsByHorizon.size !== row.provenance.labelInputs.length) throw new Error("Order-book dataset label provenance is invalid");
  const labelHorizons = new Set<number>();
  for (const label of row.labels) {
    const expectedTarget = row.provenance.exchangeTs + label.horizonMs;
    const expectedAlignmentDelay = label.observedExchangeTs - label.targetExchangeTs;
    const input = inputsByHorizon.get(label.horizonMs);
    if (
      label.schemaVersion !== "future-mid-return-v1" ||
      !positiveSafeInteger(label.horizonMs) ||
      !positiveSafeInteger(label.targetExchangeTs) ||
      !positiveSafeInteger(label.observedExchangeTs) ||
      !Number.isSafeInteger(expectedTarget) ||
      label.targetExchangeTs !== expectedTarget ||
      !Number.isSafeInteger(expectedAlignmentDelay) ||
      expectedAlignmentDelay < 0 ||
      label.alignmentDelayMs !== expectedAlignmentDelay ||
      label.anchorSequence !== row.provenance.sequence ||
      !positiveSafeInteger(label.futureSequence) ||
      label.futureSequence <= label.anchorSequence ||
      !Number.isFinite(label.returnBps) ||
      labelHorizons.has(label.horizonMs) ||
      !input ||
      input.targetExchangeTs !== label.targetExchangeTs ||
      input.observedExchangeTs !== label.observedExchangeTs ||
      input.futureSequence !== label.futureSequence
    ) {
      throw new Error("Order-book dataset label provenance is invalid");
    }
    labelHorizons.add(label.horizonMs);
  }
}

function sample(row: OrderBookDatasetRowV1, horizonMs: number, names: readonly string[]) {
  if (row.features.names.length !== names.length || row.features.names.some((name, index) => name !== names[index])) throw new Error("Dataset feature schemas are inconsistent");
  const labels = row.labels.filter((label) => label.horizonMs === horizonMs);
  if (labels.length !== 1) throw new Error(`Dataset row ${row.rowId} does not have exactly one target label`);
  return { x: [...row.features.values], y: finite(labels[0]!.returnBps, "target") };
}

function metricsFor(rows: readonly OrderBookDatasetRowV1[], horizonMs: number, flatThreshold: number, predict: (row: OrderBookDatasetRowV1) => number): OrderBookModelMetricsV1 {
  const actual = rows.map((row) => sample(row, horizonMs, row.features.names).y);
  const predicted = rows.map(predict);
  let absolute = 0;
  let squared = 0;
  let correct = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const error = predicted[index]! - actual[index]!;
    absolute += Math.abs(error);
    squared += error ** 2;
    if (direction(predicted[index]!, flatThreshold) === direction(actual[index]!, flatThreshold)) correct += 1;
  }
  return {
    rows: rows.length,
    meanActualBps: mean(actual),
    meanPredictionBps: mean(predicted),
    maeBps: absolute / rows.length,
    rmseBps: Math.sqrt(squared / rows.length),
    directionalAccuracy: correct / rows.length,
    correlation: correlation(actual, predicted)
  };
}

function resolveTrainingConfig(config: OrderBookModelTrainingConfigV1): ResolvedOrderBookModelTrainingConfigV1 {
  if (!positiveSafeInteger(config.horizonMs) || !positiveSafeInteger(config.trainedAt)) throw new RangeError("Model horizon and trainedAt must be positive safe integers");
  const trainFraction = finiteOr(config.trainFraction, 0.6);
  const validationFraction = finiteOr(config.validationFraction, 0.2);
  if (trainFraction < 0.4 || trainFraction > 0.8 || validationFraction < 0.1 || validationFraction > 0.3 || trainFraction + validationFraction > 0.9) throw new RangeError("Model chronological split fractions are invalid");
  const maximumRows = boundedInteger(config.maximumRows, MAX_MODEL_TRAINING_ROWS_V1, 9, MAX_MODEL_TRAINING_ROWS_V1);
  return {
    horizonMs: config.horizonMs,
    trainedAt: config.trainedAt,
    ridgeLambda: clampPositive(finiteOr(config.ridgeLambda, 1), 1e-9, 1e9, "ridgeLambda"),
    trainFraction,
    validationFraction,
    minimumRowsPerSplit: boundedInteger(config.minimumRowsPerSplit, 30, 1, Math.floor(maximumRows / 3)),
    maximumRows,
    flatThresholdBps: clampNonNegative(finiteOr(config.flatThresholdBps, 0.1), 1e6, "flatThresholdBps"),
    outOfDistributionZScore: clampPositive(finiteOr(config.outOfDistributionZScore, 6), 1, 100, "outOfDistributionZScore")
  };
}

function solveLinearSystem(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) < 1e-14) throw new Error("Ridge model system is numerically singular");
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let index = column; index <= size; index += 1) augmented[column]![index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let index = column; index <= size; index += 1) augmented[row]![index] -= factor * augmented[column]![index]!;
    }
  }
  return augmented.map((row) => finite(row[size]!, "coefficient"));
}

function columnMeans(rows: readonly (readonly number[])[], columns: number) {
  return Array.from({ length: columns }, (_, column) => mean(rows.map((row) => row[column]!)));
}

function columnScales(rows: readonly (readonly number[])[], means: readonly number[]) {
  return means.map((value, column) => {
    const variance = mean(rows.map((row) => (row[column]! - value) ** 2));
    const scale = Math.sqrt(variance);
    return scale > 1e-12 ? scale : 1;
  });
}

function standardize(values: readonly number[], means: readonly number[], scales: readonly number[]) {
  if (values.length !== means.length || means.length !== scales.length) throw new Error("Standardization dimensions are inconsistent");
  return values.map((value, index) => finite((value - means[index]!) / scales[index]!, "standardized feature"));
}

function correlation(left: readonly number[], right: readonly number[]) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]! - leftMean;
    const b = right[index]! - rightMean;
    numerator += a * b;
    leftSquare += a ** 2;
    rightSquare += b ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : 0;
}

function direction(value: number, flatThreshold: number): "up" | "down" | "flat" {
  return value > flatThreshold ? "up" : value < -flatThreshold ? "down" : "flat";
}

function mean(values: readonly number[]) {
  if (values.length === 0) throw new Error("Cannot calculate an empty mean");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dot(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length) throw new Error("Vector dimensions are inconsistent");
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function finiteOr(value: number | undefined, fallback: number) {
  return value === undefined ? fallback : finite(value, "configuration value");
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new RangeError(`Integer configuration must be within ${minimum}..${maximum}`);
  return resolved;
}

function clampPositive(value: number, minimum: number, maximum: number, name: string) {
  if (value < minimum || value > maximum) throw new RangeError(`${name} must be within ${minimum}..${maximum}`);
  return value;
}

function clampNonNegative(value: number, maximum: number, name: string) {
  if (value < 0 || value > maximum) throw new RangeError(`${name} must be within 0..${maximum}`);
  return value;
}
