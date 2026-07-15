export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ReplayEventType = "instrument-listed" | "instrument-delisted" | "instrument-constraints-updated" | "top-book" | "depth-snapshot" | "funding-settlement" | "borrow-state" | "venue-state";

export interface ReplayEvent<T extends JsonValue = JsonValue> {
  sourceId: string;
  sequence: number;
  exchangeTs: number;
  receivedAt: number;
  eventType: ReplayEventType;
  instrumentId?: string;
  payload: T;
}

interface ReplayManifestFields {
  datasetId: string;
  createdAt: number;
  eventDigest: `sha256:${string}`;
  eventCount: number;
  adapterVersions: Record<string, string>;
  registrySnapshotId: string;
  registrySnapshotDigest: `sha256:${string}`;
  costModelVersion: string;
  survivorshipPolicy: "point-in-time" | "current-universe-biased";
  sourceFiles: Array<{ id: string; digest: `sha256:${string}` }>;
}

/** Legacy manifest: arrival/provenance is verifiable, economic identity is not. */
export interface ReplayManifestV1 extends ReplayManifestFields {
  schemaVersion: 1;
}

export interface ReplayManifestV2 extends ReplayManifestFields {
  schemaVersion: 2;
  /** Sorted canonical economic identities declared by instrument listing events. */
  economicAssetIds: string[];
}

export interface ReplayInstrumentMinimumNotional {
  instrumentId: string;
  listingEventIndex: number;
  minimumNotional: number;
}

export interface ReplayManifestV3 extends ReplayManifestFields {
  schemaVersion: 3;
  /** Sorted canonical economic identities declared by instrument listing events. */
  economicAssetIds: string[];
  /** Point-in-time execution floor for every listing epoch, in canonical event order. */
  instrumentMinimumNotionals: ReplayInstrumentMinimumNotional[];
}

export interface ReplayInstrumentConstraintEpoch {
  instrumentId: string;
  eventIndex: number;
  eventType: "instrument-listed" | "instrument-constraints-updated";
  constraintVersion: number;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
}

export interface ReplayManifestV4 extends ReplayManifestFields {
  schemaVersion: 4;
  /** Sorted canonical economic identities declared by instrument listing events. */
  economicAssetIds: string[];
  /** Ordered point-in-time execution-constraint epochs, including in-place updates. */
  instrumentConstraintEpochs: ReplayInstrumentConstraintEpoch[];
}

export type ReplayManifest = ReplayManifestV1 | ReplayManifestV2 | ReplayManifestV3 | ReplayManifestV4;

export interface ReplayDataset {
  manifest: ReplayManifest;
  events: ReplayEvent[];
}

export interface ReplaySnapshot<T extends JsonValue> {
  eventIndex: number;
  logicalTime: number;
  stateDigest: `sha256:${string}`;
  state: T;
}

export interface ReplayResult<T extends JsonValue> {
  datasetId: string;
  eventDigest: `sha256:${string}`;
  eventCount: number;
  firstEventAt?: number;
  lastEventAt?: number;
  identityVerified: boolean;
  verifiedPointInTime: boolean;
  warnings: string[];
  finalState: T;
  finalStateDigest: `sha256:${string}`;
  snapshots: ReplaySnapshot<T>[];
}

export interface ReplayOptions {
  snapshotEvery?: number;
  /** Caller bound, which cannot exceed the absolute 1,000-snapshot ceiling. */
  maxSnapshots?: number;
  /** Optional lower total snapshot-output byte bound; cannot exceed 32 MiB. */
  maxSnapshotBytes?: number;
  /** Optional lower total snapshot state-entry bound; cannot exceed 1,000,000 entries. */
  maxSnapshotStateEntries?: number;
}
