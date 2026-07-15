import { canonicalJson, sha256 } from "./canonical.js";
import { validateReplayDataset } from "./dataset.js";
import type { JsonValue, ReplayDataset, ReplayEvent } from "./types.js";

export const ENGINE_REPLAY_VERSIONS = {
  triangular: "triangular-v1",
  pairwise: "pairwise-v1",
  "native-spread": "native-spread-v1",
  "options-parity": "options-parity-v1",
  "n-leg": "n-leg-v1"
} as const;

export type EngineReplayKind = keyof typeof ENGINE_REPLAY_VERSIONS;
export type EngineReplayVersion = (typeof ENGINE_REPLAY_VERSIONS)[EngineReplayKind];

export const HARD_MAX_ENGINE_REPLAY_EVIDENCE = 64;
export const HARD_MAX_ENGINE_REPLAY_INPUT_BYTES = 2 * 1024 * 1024;
export const HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE = 1_000;

export interface EngineReplayEvidence {
  instrumentId: string;
  eventIndex: number;
  sourceId: string;
  sourceSequence: number;
  bookSequence: number;
  sourceGeneration: string;
  complete: true;
  sequenceVerified: true;
  exchangeTs: number;
  receivedAt: number;
  eventDigest: `sha256:${string}`;
}

export interface EngineReplayManifestV1 {
  schemaVersion: 1;
  replayKind: "point-in-time-engine-evaluation";
  evaluationId: string;
  datasetId: string;
  datasetEventDigest: `sha256:${string}`;
  registrySnapshotId: string;
  registrySnapshotDigest: `sha256:${string}`;
  costModelVersion: string;
  engine: EngineReplayKind;
  engineVersion: EngineReplayVersion;
  evaluatedAt: number;
  inputDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  evidence: EngineReplayEvidence[];
  readOnly: true;
  executable: false;
}

export interface EngineReplayResult<T> {
  evaluationId: string;
  datasetId: string;
  engine: EngineReplayKind;
  engineVersion: EngineReplayVersion;
  evaluatedAt: number;
  verifiedPointInTime: true;
  readOnly: true;
  executable: false;
  manifestDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  outputDigest: `sha256:${string}`;
  evidence: EngineReplayEvidence[];
  output: T;
}

export interface CreateEngineReplayManifestInput {
  evaluationId: string;
  engine: EngineReplayKind;
  evaluatedAt: number;
  input: unknown;
  evidenceEventIndexes: readonly number[];
}

export interface ReplayBookProof {
  bookSequence: number;
  sourceGeneration: string;
  complete: true;
  sequenceVerified: true;
}

export function createEngineReplayManifest(dataset: ReplayDataset, input: CreateEngineReplayManifestInput): EngineReplayManifestV1 {
  requireVerifiedPointInTimeDataset(dataset);
  identifier(input.evaluationId, "evaluationId");
  positiveTimestamp(input.evaluatedAt, "evaluatedAt");
  const engineVersion = ENGINE_REPLAY_VERSIONS[input.engine];
  if (!engineVersion) throw new Error("unsupported replay engine");
  const inputValue = replayJsonValue(input.input, "engine input");
  const inputCanonical = canonicalJson(inputValue);
  if (Buffer.byteLength(inputCanonical) > HARD_MAX_ENGINE_REPLAY_INPUT_BYTES) {
    throw new Error(`engine input exceeds ${HARD_MAX_ENGINE_REPLAY_INPUT_BYTES} bytes`);
  }
  rejectSecrets(inputValue);
  if (input.evidenceEventIndexes.length === 0 || input.evidenceEventIndexes.length > HARD_MAX_ENGINE_REPLAY_EVIDENCE) {
    throw new Error(`evidence count must be between 1 and ${HARD_MAX_ENGINE_REPLAY_EVIDENCE}`);
  }
  const evidence = input.evidenceEventIndexes.map((eventIndex) => evidenceAt(dataset, eventIndex, input.evaluatedAt));
  assertUniqueEvidence(evidence);
  for (const item of evidence) assertLatestAvailableDepth(dataset, item, input.evaluatedAt);
  return {
    schemaVersion: 1,
    replayKind: "point-in-time-engine-evaluation",
    evaluationId: input.evaluationId,
    datasetId: dataset.manifest.datasetId,
    datasetEventDigest: dataset.manifest.eventDigest,
    registrySnapshotId: dataset.manifest.registrySnapshotId,
    registrySnapshotDigest: dataset.manifest.registrySnapshotDigest,
    costModelVersion: dataset.manifest.costModelVersion,
    engine: input.engine,
    engineVersion,
    evaluatedAt: input.evaluatedAt,
    inputDigest: sha256(inputValue),
    evidenceDigest: sha256(evidence as unknown as JsonValue),
    evidence,
    readOnly: true,
    executable: false
  };
}

export function validateEngineReplayManifest(dataset: ReplayDataset, manifest: EngineReplayManifestV1, engine: EngineReplayKind, input: unknown): Map<string, ReplayEvent> {
  requireVerifiedPointInTimeDataset(dataset);
  if (manifest.schemaVersion !== 1 || manifest.replayKind !== "point-in-time-engine-evaluation") throw new Error("unsupported engine replay manifest");
  identifier(manifest.evaluationId, "evaluationId");
  positiveTimestamp(manifest.evaluatedAt, "evaluatedAt");
  if (manifest.engine !== engine || manifest.engineVersion !== ENGINE_REPLAY_VERSIONS[engine]) throw new Error("engine replay version mismatch");
  if (manifest.datasetId !== dataset.manifest.datasetId || manifest.datasetEventDigest !== dataset.manifest.eventDigest) throw new Error("engine replay dataset binding mismatch");
  if (manifest.registrySnapshotId !== dataset.manifest.registrySnapshotId || manifest.registrySnapshotDigest !== dataset.manifest.registrySnapshotDigest) {
    throw new Error("engine replay registry binding mismatch");
  }
  if (manifest.costModelVersion !== dataset.manifest.costModelVersion) throw new Error("engine replay cost-model binding mismatch");
  if (manifest.readOnly !== true || manifest.executable !== false) throw new Error("engine replay safety envelope is invalid");
  const inputValue = replayJsonValue(input, "engine input");
  if (Buffer.byteLength(canonicalJson(inputValue)) > HARD_MAX_ENGINE_REPLAY_INPUT_BYTES) throw new Error(`engine input exceeds ${HARD_MAX_ENGINE_REPLAY_INPUT_BYTES} bytes`);
  rejectSecrets(inputValue);
  if (sha256(inputValue) !== manifest.inputDigest) throw new Error("engine replay input digest mismatch");
  if (manifest.evidence.length === 0 || manifest.evidence.length > HARD_MAX_ENGINE_REPLAY_EVIDENCE) throw new Error("engine replay evidence count is invalid");
  if (sha256(manifest.evidence as unknown as JsonValue) !== manifest.evidenceDigest) throw new Error("engine replay evidence digest mismatch");
  assertUniqueEvidence(manifest.evidence);
  const events = new Map<string, ReplayEvent>();
  for (const expected of manifest.evidence) {
    const actual = evidenceAt(dataset, expected.eventIndex, manifest.evaluatedAt);
    if (canonicalJson(actual as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) throw new Error(`engine replay evidence ${expected.eventIndex} does not match dataset`);
    assertLatestAvailableDepth(dataset, actual, manifest.evaluatedAt);
    events.set(actual.instrumentId, dataset.events[actual.eventIndex]!);
  }
  return events;
}

export function makeEngineReplayResult<T>(manifest: EngineReplayManifestV1, output: T): EngineReplayResult<T> {
  const outputValue = normalizedOutput(output, "engine output", new Set<object>());
  const outputClone = JSON.parse(canonicalJson(outputValue)) as T;
  return {
    evaluationId: manifest.evaluationId,
    datasetId: manifest.datasetId,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    evaluatedAt: manifest.evaluatedAt,
    verifiedPointInTime: true,
    readOnly: true,
    executable: false,
    manifestDigest: sha256(manifest as unknown as JsonValue),
    inputDigest: manifest.inputDigest,
    evidenceDigest: manifest.evidenceDigest,
    outputDigest: sha256(outputValue),
    evidence: structuredClone(manifest.evidence),
    output: outputClone
  };
}

export function requireEvidence(events: ReadonlyMap<string, ReplayEvent>, expectedInstrumentIds: readonly string[]): void {
  const expected = [...new Set(expectedInstrumentIds)].sort();
  if (expected.length !== expectedInstrumentIds.length) throw new Error("engine input contains duplicate instrument identity");
  const actual = [...events.keys()].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("engine replay evidence does not exactly cover required instruments");
}

function requireVerifiedPointInTimeDataset(dataset: ReplayDataset) {
  validateReplayDataset(dataset);
  if (dataset.manifest.schemaVersion !== 4 || dataset.manifest.survivorshipPolicy !== "point-in-time") {
    throw new Error("engine replay requires replay manifest schema v4 with point-in-time survivorship");
  }
}

function evidenceAt(dataset: ReplayDataset, eventIndex: number, evaluatedAt: number): EngineReplayEvidence {
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex >= dataset.events.length) throw new Error(`evidence event index ${eventIndex} is invalid`);
  const event = dataset.events[eventIndex]!;
  if (event.eventType !== "depth-snapshot" || !event.instrumentId) throw new Error(`evidence event ${eventIndex} is not an instrument depth snapshot`);
  if (event.receivedAt > evaluatedAt) throw new Error(`evidence event ${eventIndex} arrived after evaluatedAt`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) throw new Error(`evidence event ${eventIndex} has no positive sequence provenance`);
  const proof = replayBookProof(event, event.instrumentId);
  return {
    instrumentId: event.instrumentId,
    eventIndex,
    sourceId: event.sourceId,
    sourceSequence: event.sequence,
    ...proof,
    exchangeTs: event.exchangeTs,
    receivedAt: event.receivedAt,
    eventDigest: sha256(event as unknown as JsonValue)
  };
}

export function replayBookProof(event: ReplayEvent, instrumentId: string): ReplayBookProof {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error(`depth snapshot ${instrumentId} payload is invalid`);
  const payload = event.payload as Record<string, JsonValue>;
  if (payload.complete !== true) throw new Error(`depth snapshot ${instrumentId} is not explicitly complete`);
  if (payload.sequenceVerified !== true) throw new Error(`depth snapshot ${instrumentId} has no sequence-continuity proof`);
  if (!Number.isSafeInteger(payload.bookSequence) || (payload.bookSequence as number) <= 0) throw new Error(`depth snapshot ${instrumentId} bookSequence is invalid`);
  if (typeof payload.sourceGeneration !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(payload.sourceGeneration)) {
    throw new Error(`depth snapshot ${instrumentId} sourceGeneration is invalid`);
  }
  return {
    bookSequence: payload.bookSequence as number,
    sourceGeneration: payload.sourceGeneration,
    complete: true,
    sequenceVerified: true
  };
}

function assertLatestAvailableDepth(dataset: ReplayDataset, evidence: EngineReplayEvidence, evaluatedAt: number) {
  let active = false;
  let latestIndex: number | undefined;
  for (const [index, event] of dataset.events.entries()) {
    if (event.receivedAt > evaluatedAt) break;
    if (event.instrumentId !== evidence.instrumentId) continue;
    if (event.eventType === "instrument-listed") {
      active = true;
      latestIndex = undefined;
    } else if (event.eventType === "instrument-delisted") {
      active = false;
      latestIndex = undefined;
    } else if (event.eventType === "depth-snapshot" && active) latestIndex = index;
  }
  if (!active) throw new Error(`evidence instrument ${evidence.instrumentId} is inactive at evaluatedAt`);
  if (latestIndex !== evidence.eventIndex) throw new Error(`evidence for ${evidence.instrumentId} is not the latest depth available at evaluatedAt`);
}

function assertUniqueEvidence(evidence: readonly EngineReplayEvidence[]) {
  const indexes = new Set<number>();
  const instruments = new Set<string>();
  for (const item of evidence) {
    if (indexes.has(item.eventIndex)) throw new Error(`duplicate evidence event index ${item.eventIndex}`);
    if (instruments.has(item.instrumentId)) throw new Error(`duplicate evidence instrument ${item.instrumentId}`);
    indexes.add(item.eventIndex);
    instruments.add(item.instrumentId);
  }
}

function replayJsonValue(value: unknown, label: string): JsonValue {
  assertJson(value, label, new Set<object>());
  return value as JsonValue;
}

function normalizedOutput(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${path} is not canonical JSON`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value.map((item, index) => {
      if (item === undefined) throw new Error(`${path}[${index}] is not canonical JSON`);
      return normalizedOutput(item, `${path}[${index}]`, ancestors);
    });
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${path} contains a non-plain object`);
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) record[key] = normalizedOutput(item, `${path}.${key}`, ancestors);
    }
    result = record;
  }
  ancestors.delete(value);
  return result;
}

function assertJson(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} is not canonical JSON`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJson(item, `${path}[${index}]`, ancestors));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${path} contains a non-plain object`);
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function rejectSecrets(value: JsonValue, path = "engine input") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[-_]?key|secret|token|password|credentials|private[-_]?key|passphrase)$/i.test(key)) throw new Error(`${path}.${key} is forbidden in read-only replay`);
    rejectSecrets(item, `${path}.${key}`);
  }
}

function identifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(value)) throw new Error(`${label} is invalid`);
}

function positiveTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}
