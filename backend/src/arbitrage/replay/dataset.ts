import { cloneJson, cloneJsonWithDigest, eventDigest } from "./canonical.js";
import type { JsonValue, ReplayDataset, ReplayEvent, ReplayInstrumentConstraintEpoch, ReplayManifestV3, ReplayManifestV4, ReplayOptions, ReplayResult } from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const ECONOMIC_ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/;

export const HARD_MAX_REPLAY_SNAPSHOTS = 1_000;
export const HARD_MAX_REPLAY_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const HARD_MAX_REPLAY_SNAPSHOT_STATE_ENTRIES = 1_000_000;

export interface ManifestInput extends Omit<ReplayManifestV4, "schemaVersion" | "eventDigest" | "eventCount" | "economicAssetIds" | "instrumentConstraintEpochs"> {}

export function createReplayManifest(input: ManifestInput, events: ReplayEvent[]): ReplayManifestV4 {
  return {
    schemaVersion: 4,
    datasetId: input.datasetId,
    createdAt: input.createdAt,
    eventDigest: eventDigest(events),
    eventCount: events.length,
    economicAssetIds: manifestEconomicAssetIds(events, true),
    instrumentConstraintEpochs: manifestInstrumentConstraintEpochs(events, true),
    adapterVersions: { ...input.adapterVersions },
    registrySnapshotId: input.registrySnapshotId,
    registrySnapshotDigest: input.registrySnapshotDigest,
    costModelVersion: input.costModelVersion,
    survivorshipPolicy: input.survivorshipPolicy,
    sourceFiles: input.sourceFiles.map((source) => ({ ...source }))
  };
}

export function validateReplayDataset(dataset: ReplayDataset): void {
  const { manifest, events } = dataset;
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3 && manifest.schemaVersion !== 4) throw new Error("unsupported replay manifest schema");
  identifier(manifest.datasetId, "datasetId");
  positiveTimestamp(manifest.createdAt, "manifest.createdAt");
  identifier(manifest.registrySnapshotId, "registrySnapshotId");
  if (!DIGEST.test(manifest.registrySnapshotDigest)) throw new Error("manifest.registrySnapshotDigest is invalid");
  identifier(manifest.costModelVersion, "costModelVersion");
  if (!DIGEST.test(manifest.eventDigest)) throw new Error("manifest.eventDigest is invalid");
  if (!Number.isSafeInteger(manifest.eventCount) || manifest.eventCount < 0 || manifest.eventCount !== events.length) throw new Error("manifest.eventCount does not match events");
  if (manifest.schemaVersion === 2 || manifest.schemaVersion === 3 || manifest.schemaVersion === 4) {
    if (!Array.isArray(manifest.economicAssetIds)) throw new Error("manifest.economicAssetIds must be an array");
    const expectedEconomicAssetIds = manifestEconomicAssetIds(events, true);
    if (manifest.economicAssetIds.some((value) => !ECONOMIC_ASSET_ID.test(value))) throw new Error("manifest.economicAssetIds contains an invalid canonical identity");
    if (new Set(manifest.economicAssetIds).size !== manifest.economicAssetIds.length || !isSorted(manifest.economicAssetIds)) {
      throw new Error("manifest.economicAssetIds must be sorted and unique");
    }
    if (JSON.stringify(manifest.economicAssetIds) !== JSON.stringify(expectedEconomicAssetIds)) {
      throw new Error("manifest.economicAssetIds does not match instrument listing events");
    }
  }
  if (manifest.schemaVersion === 3) {
    if (!Array.isArray(manifest.instrumentMinimumNotionals)) throw new Error("manifest.instrumentMinimumNotionals must be an array");
    const expected = manifestInstrumentMinimumNotionals(events, true);
    if (JSON.stringify(manifest.instrumentMinimumNotionals) !== JSON.stringify(expected)) {
      throw new Error("manifest.instrumentMinimumNotionals does not match instrument listing events");
    }
  }
  if (manifest.schemaVersion === 4) {
    if (!Array.isArray(manifest.instrumentConstraintEpochs)) throw new Error("manifest.instrumentConstraintEpochs must be an array");
    const expected = manifestInstrumentConstraintEpochs(events, true);
    if (JSON.stringify(manifest.instrumentConstraintEpochs) !== JSON.stringify(expected)) {
      throw new Error("manifest.instrumentConstraintEpochs does not match instrument constraint events");
    }
  } else if (events.some((event) => event.eventType === "instrument-constraints-updated")) {
    throw new Error("instrument constraint updates require replay manifest schema v4");
  }
  const adapters = Object.entries(manifest.adapterVersions);
  if (adapters.length === 0) throw new Error("manifest requires adapter versions");
  for (const [venue, version] of adapters) {
    identifier(venue, "adapter venue");
    identifier(version, `adapterVersions.${venue}`);
  }
  if (manifest.sourceFiles.length === 0) throw new Error("manifest requires immutable source files");
  const sourceIds = new Set<string>();
  for (const source of manifest.sourceFiles) {
    identifier(source.id, "source file id");
    if (sourceIds.has(source.id)) throw new Error(`duplicate source file ${source.id}`);
    sourceIds.add(source.id);
    if (!DIGEST.test(source.digest)) throw new Error(`source file ${source.id} digest is invalid`);
  }
  if (eventDigest(events) !== manifest.eventDigest) throw new Error("event digest mismatch");

  const lastSequence = new Map<string, number>();
  const activeInstruments = new Set<string>();
  const activeConstraintVersions = new Map<string, number>();
  const seenIdentities = new Set<string>();
  let previous: ReplayEvent | undefined;
  for (const [index, event] of events.entries()) {
    validateEvent(event, index);
    if (previous && compareEvent(previous, event) >= 0) throw new Error(`events are not in canonical order at index ${index}`);
    previous = event;
    const priorSequence = lastSequence.get(event.sourceId);
    if (priorSequence !== undefined && event.sequence <= priorSequence) throw new Error(`source ${event.sourceId} sequence regressed`);
    lastSequence.set(event.sourceId, event.sequence);
    const identity = `${event.sourceId}:${event.sequence}`;
    if (seenIdentities.has(identity)) throw new Error(`duplicate event ${identity}`);
    seenIdentities.add(identity);

    if (manifest.schemaVersion === 4 && event.instrumentId) {
      if (event.eventType === "instrument-listed") {
        const epoch = instrumentConstraintEpoch(event, index, true);
        if (epoch.constraintVersion !== 1) throw new Error(`instrument ${event.instrumentId} listing constraintVersion must be 1`);
        activeConstraintVersions.set(event.instrumentId, epoch.constraintVersion);
      } else if (event.eventType === "instrument-delisted") {
        activeConstraintVersions.delete(event.instrumentId);
      } else if (event.eventType === "instrument-constraints-updated") {
        const previousVersion = activeConstraintVersions.get(event.instrumentId);
        if (previousVersion === undefined) throw new Error(`instrument ${event.instrumentId} constraints updated before listing`);
        const epoch = instrumentConstraintEpoch(event, index, true);
        if (epoch.constraintVersion !== previousVersion + 1) {
          throw new Error(`instrument ${event.instrumentId} constraintVersion must advance from ${previousVersion} to ${previousVersion + 1}`);
        }
        activeConstraintVersions.set(event.instrumentId, epoch.constraintVersion);
      }
    }

    if (manifest.survivorshipPolicy !== "point-in-time" || !event.instrumentId) continue;
    if (event.eventType === "instrument-listed") {
      if (activeInstruments.has(event.instrumentId)) throw new Error(`instrument ${event.instrumentId} listed twice`);
      activeInstruments.add(event.instrumentId);
    } else if (event.eventType === "instrument-delisted") {
      if (!activeInstruments.delete(event.instrumentId)) throw new Error(`instrument ${event.instrumentId} delisted before listing`);
    } else if (!activeInstruments.has(event.instrumentId)) {
      throw new Error(`${event.eventType} for inactive instrument ${event.instrumentId}`);
    }
  }
}

export function replayDataset<T extends JsonValue>(dataset: ReplayDataset, initialState: T, reducer: (state: T, event: ReplayEvent, context: { eventIndex: number; logicalTime: number }) => T, options: ReplayOptions = {}): ReplayResult<T> {
  validateReplayDataset(dataset);
  const snapshotEvery = options.snapshotEvery ?? 0;
  if (!Number.isSafeInteger(snapshotEvery) || snapshotEvery < 0) throw new Error("snapshotEvery must be a non-negative integer");
  const maxSnapshots = boundedReplayOutputOption(options.maxSnapshots, HARD_MAX_REPLAY_SNAPSHOTS, "maxSnapshots");
  const maxSnapshotBytes = boundedReplayOutputOption(options.maxSnapshotBytes, HARD_MAX_REPLAY_SNAPSHOT_BYTES, "maxSnapshotBytes");
  const maxSnapshotStateEntries = boundedReplayOutputOption(options.maxSnapshotStateEntries, HARD_MAX_REPLAY_SNAPSHOT_STATE_ENTRIES, "maxSnapshotStateEntries");
  const expectedSnapshots = snapshotEvery > 0 ? Math.ceil(dataset.events.length / snapshotEvery) : 0;
  if (expectedSnapshots > maxSnapshots) throw new Error(`replay snapshot output exceeds maxSnapshots (${maxSnapshots})`);
  let state = cloneJson(initialState);
  const replayEvents = cloneJson(dataset.events as unknown as JsonValue) as unknown as ReplayEvent[];
  const snapshots: ReplayResult<T>["snapshots"] = [];
  let snapshotBytes = 0;
  let snapshotStateEntries = 0;
  replayEvents.forEach((event, eventIndex) => {
    state = reducer(state, event, { eventIndex, logicalTime: event.receivedAt });
    if (snapshotEvery > 0 && ((eventIndex + 1) % snapshotEvery === 0 || eventIndex === replayEvents.length - 1)) {
      snapshotStateEntries += countJsonEntries(state, maxSnapshotStateEntries - snapshotStateEntries);
      if (snapshotStateEntries > maxSnapshotStateEntries) throw new Error(`replay snapshot output exceeds maxSnapshotStateEntries (${maxSnapshotStateEntries})`);
      const snapshot = cloneJsonWithDigest(state);
      snapshotBytes += snapshot.byteLength;
      if (snapshotBytes > maxSnapshotBytes) throw new Error(`replay snapshot output exceeds maxSnapshotBytes (${maxSnapshotBytes})`);
      snapshots.push({ eventIndex, logicalTime: event.receivedAt, stateDigest: snapshot.digest, state: snapshot.clone });
    }
  });
  const identityVerified = dataset.manifest.schemaVersion === 2 || dataset.manifest.schemaVersion === 3 || dataset.manifest.schemaVersion === 4;
  const verifiedPointInTime = dataset.manifest.survivorshipPolicy === "point-in-time" && dataset.manifest.schemaVersion === 4;
  const warnings: string[] = [];
  if (!identityVerified) warnings.push("legacy replay schema v1 has no verified canonical economic identity; result is exploratory and identity-unverified");
  if (dataset.manifest.schemaVersion === 2) warnings.push("legacy replay schema v2 has no verified point-in-time minimum notional; result is exploratory");
  if (dataset.manifest.schemaVersion === 3) warnings.push("legacy replay schema v3 has no versioned point-in-time instrument constraint updates; result is exploratory");
  if (dataset.manifest.survivorshipPolicy !== "point-in-time") warnings.push("current-universe survivorship bias: result is exploratory and unverified");
  const final = cloneJsonWithDigest(state);
  return {
    datasetId: dataset.manifest.datasetId,
    eventDigest: dataset.manifest.eventDigest,
    eventCount: dataset.events.length,
    ...(dataset.events[0] ? { firstEventAt: dataset.events[0].receivedAt } : {}),
    ...(dataset.events.at(-1) ? { lastEventAt: dataset.events.at(-1)!.receivedAt } : {}),
    identityVerified,
    verifiedPointInTime,
    warnings,
    finalState: final.clone,
    finalStateDigest: final.digest,
    snapshots
  };
}

function validateEvent(event: ReplayEvent, index: number) {
  identifier(event.sourceId, `events[${index}].sourceId`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error(`events[${index}].sequence is invalid`);
  positiveTimestamp(event.exchangeTs, `events[${index}].exchangeTs`);
  positiveTimestamp(event.receivedAt, `events[${index}].receivedAt`);
  if (event.exchangeTs > event.receivedAt) throw new Error(`events[${index}].exchangeTs cannot be later than receivedAt`);
  if (!EVENT_TYPES.has(event.eventType)) throw new Error(`events[${index}].eventType is invalid`);
  if (event.instrumentId !== undefined) identifier(event.instrumentId, `events[${index}].instrumentId`);
  if (
    (event.eventType === "instrument-listed" || event.eventType === "instrument-delisted" || event.eventType === "instrument-constraints-updated" || event.eventType === "top-book" || event.eventType === "depth-snapshot" || event.eventType === "funding-settlement" || event.eventType === "borrow-state") &&
    !event.instrumentId
  ) {
    throw new Error(`events[${index}] ${event.eventType} requires instrumentId`);
  }
}

const EVENT_TYPES = new Set(["instrument-listed", "instrument-delisted", "instrument-constraints-updated", "top-book", "depth-snapshot", "funding-settlement", "borrow-state", "venue-state"]);

function compareEvent(left: ReplayEvent, right: ReplayEvent) {
  return left.receivedAt - right.receivedAt || left.sourceId.localeCompare(right.sourceId) || left.sequence - right.sequence || left.exchangeTs - right.exchangeTs;
}
function identifier(value: string, label: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
}
function positiveTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function manifestEconomicAssetIds(events: ReplayEvent[], required = false): string[] {
  const values = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.eventType !== "instrument-listed") continue;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      if (required) throw new Error(`events[${index}].payload.economicAssetId is required by replay manifest schema v2`);
      continue;
    }
    const value = event.payload.economicAssetId;
    if (value === undefined) {
      if (required) throw new Error(`events[${index}].payload.economicAssetId is required by replay manifest schema v2`);
      continue;
    }
    if (typeof value !== "string" || !ECONOMIC_ASSET_ID.test(value)) {
      throw new Error(`events[${index}].payload.economicAssetId is invalid`);
    }
    values.add(value);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

function manifestInstrumentMinimumNotionals(events: ReplayEvent[], required = false) {
  const values: ReplayManifestV3["instrumentMinimumNotionals"] = [];
  for (const [listingEventIndex, event] of events.entries()) {
    if (event.eventType !== "instrument-listed") continue;
    if (!event.instrumentId || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      if (required) throw new Error(`events[${listingEventIndex}].payload.minimumNotional is required by replay manifest schema v3`);
      continue;
    }
    const minimumNotional = event.payload.minimumNotional;
    if (typeof minimumNotional !== "number" || !Number.isFinite(minimumNotional) || minimumNotional <= 0) {
      throw new Error(`events[${listingEventIndex}].payload.minimumNotional is invalid`);
    }
    values.push({ instrumentId: event.instrumentId, listingEventIndex, minimumNotional });
  }
  return values;
}

function manifestInstrumentConstraintEpochs(events: ReplayEvent[], required = false): ReplayInstrumentConstraintEpoch[] {
  const values: ReplayInstrumentConstraintEpoch[] = [];
  for (const [eventIndex, event] of events.entries()) {
    if (event.eventType !== "instrument-listed" && event.eventType !== "instrument-constraints-updated") continue;
    values.push(instrumentConstraintEpoch(event, eventIndex, required));
  }
  return values;
}

function instrumentConstraintEpoch(event: ReplayEvent, eventIndex: number, required: boolean): ReplayInstrumentConstraintEpoch {
  if (event.eventType !== "instrument-listed" && event.eventType !== "instrument-constraints-updated") {
    throw new Error(`events[${eventIndex}] is not an instrument constraint event`);
  }
  if (!event.instrumentId || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    if (required) throw new Error(`events[${eventIndex}] instrument constraint payload is required by replay manifest schema v4`);
    throw new Error(`events[${eventIndex}] instrument constraint payload is invalid`);
  }
  const constraintVersion = event.payload.constraintVersion;
  const quantityStep = event.payload.quantityStep;
  const minimumQuantity = event.payload.minimumQuantity;
  const minimumNotional = event.payload.minimumNotional;
  if (!Number.isSafeInteger(constraintVersion) || (constraintVersion as number) <= 0) throw new Error(`events[${eventIndex}].payload.constraintVersion is invalid`);
  for (const [field, value] of Object.entries({ quantityStep, minimumQuantity, minimumNotional })) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`events[${eventIndex}].payload.${field} is invalid`);
  }
  return {
    instrumentId: event.instrumentId,
    eventIndex,
    eventType: event.eventType,
    constraintVersion: constraintVersion as number,
    quantityStep: quantityStep as number,
    minimumQuantity: minimumQuantity as number,
    minimumNotional: minimumNotional as number
  };
}

function boundedReplayOutputOption(value: number | undefined, hardMaximum: number, label: string) {
  const result = value ?? hardMaximum;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`);
  if (result > hardMaximum) throw new Error(`${label} cannot exceed the hard limit (${hardMaximum})`);
  return result;
}

function countJsonEntries(value: JsonValue, remainingBudget: number) {
  let count = 0;
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    const children = Array.isArray(current) ? current : Object.values(current);
    count += children.length;
    if (count > remainingBudget) return count;
    for (const child of children) if (child !== null && typeof child === "object") pending.push(child);
  }
  return count;
}

function isSorted(values: string[]) {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0);
}
