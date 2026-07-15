import { array, bool, exact, finite, integer, optionalText, record, text } from "./validation.js";

export type LifecycleKind = "basis" | "triangular" | "native-spread" | "pairwise";
export type LifecycleStatus = "first-seen" | "confirmed" | "decaying" | "expired";
export type LifecycleEvidenceQuality = "unverified" | "degraded" | "fresh" | "verified";
export type LifecycleReason =
  | "candidate-observed"
  | "confirmation-complete"
  | "score-below-entry"
  | "score-below-exit"
  | "evidence-incomplete"
  | "evidence-quality"
  | "evidence-stale"
  | "route-absent"
  | "universe-incomplete"
  | "universe-restored"
  | "policy-changed"
  | "duplicate-route-conflict"
  | "observation-replayed"
  | "observation-out-of-order"
  | "observation-future"
  | "decay-grace-elapsed"
  | "route-capacity-reached";

export interface LifecycleQuery {
  universeId?: string;
  routeId?: string;
  kind?: LifecycleKind;
  status?: LifecycleStatus;
  actionable?: boolean;
  routeOffset?: number;
  routeLimit?: number;
  afterSequence?: number;
  eventLimit?: number;
}

export interface LifecycleUniverse {
  universeId: string;
  lastPolicyId: string;
  lastSnapshotId: string;
  lastSnapshotFingerprint: string;
  lastEvaluatedAt: number;
  coverageComplete: boolean;
  lastCoverageReason: LifecycleReason;
}

export interface LifecycleRoute {
  key: string;
  universeId: string;
  policyId: string;
  kind: LifecycleKind;
  routeId: string;
  status: LifecycleStatus;
  actionable: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  lastObservationAt: number;
  lastObservationId: string;
  recentObservationIds: string[];
  score: number;
  rawEvidenceQuality: LifecycleEvidenceQuality;
  effectiveEvidenceQuality: LifecycleEvidenceQuality;
  evidenceSourceIds: string[];
  evidenceComplete: boolean;
  confirmationCount: number;
  confirmationStartedAt?: number;
  confirmedAt?: number;
  decayStartedAt?: number;
  expiredAt?: number;
  lastReason: LifecycleReason;
}

export interface LifecycleEvent {
  id: string;
  sequence: number;
  type: "universe" | "transition" | "evidence-rejected";
  universeId: string;
  policyId: string;
  kind?: LifecycleKind;
  routeId?: string;
  from?: LifecycleStatus;
  to?: LifecycleStatus;
  reason: LifecycleReason;
  effectiveAt: number;
  evaluatedAt: number;
  observationId?: string;
}

export interface LifecycleResponse {
  schemaVersion: 1;
  readOnly: true;
  executionPermission: false;
  generatedAt: number;
  runtime: { acceptedSnapshots: number; rejectedSnapshots: number; lastAcceptedAt?: number; lastRejectedAt?: number; lastError?: string };
  summary: {
    universeCount: number;
    retainedRoutes: number;
    matchedRoutes: number;
    returnedRoutes: number;
    routesTruncated: boolean;
    retainedEvents: number;
    matchedEvents: number;
    returnedEvents: number;
    eventsTruncated: boolean;
    nextEventSequence: number;
  };
  universes: LifecycleUniverse[];
  routes: LifecycleRoute[];
  events: LifecycleEvent[];
}

const KINDS = ["basis", "triangular", "native-spread", "pairwise"] as const;
const STATUSES = ["first-seen", "confirmed", "decaying", "expired"] as const;
const QUALITIES = ["unverified", "degraded", "fresh", "verified"] as const;
const REASONS = [
  "candidate-observed",
  "confirmation-complete",
  "score-below-entry",
  "score-below-exit",
  "evidence-incomplete",
  "evidence-quality",
  "evidence-stale",
  "route-absent",
  "universe-incomplete",
  "universe-restored",
  "policy-changed",
  "duplicate-route-conflict",
  "observation-replayed",
  "observation-out-of-order",
  "observation-future",
  "decay-grace-elapsed",
  "route-capacity-reached"
] as const;

export function parseLifecycleResponse(value: unknown): LifecycleResponse {
  const row = record(value, "lifecycle response");
  if (row.schemaVersion !== 1 || row.readOnly !== true || row.executionPermission !== false) throw new Error("lifecycle response safety envelope is invalid");
  const generatedAt = timestamp(row.generatedAt, "generatedAt");
  const runtime = parseRuntime(row.runtime);
  const summary = parseSummary(row.summary);
  const universes = array(row.universes, "universes", 10_000).map((item, index) => parseUniverse(item, `universes[${index}]`));
  const routes = array(row.routes, "routes", 500).map((item, index) => parseRoute(item, `routes[${index}]`));
  const events = array(row.events, "events", 500).map((item, index) => parseEvent(item, `events[${index}]`));
  unique(
    universes.map(({ universeId }) => universeId),
    "universe IDs"
  );
  unique(
    routes.map(({ key }) => key),
    "route keys"
  );
  unique(
    events.map(({ id }) => id),
    "event IDs"
  );
  unique(
    events.map(({ sequence }) => String(sequence)),
    "event sequences"
  );
  if (events.some((event, index) => index > 0 && event.sequence >= events[index - 1]!.sequence)) throw new Error("lifecycle events must be newest first");
  if (summary.universeCount !== universes.length || summary.returnedRoutes !== routes.length || summary.returnedEvents !== events.length) throw new Error("lifecycle summary does not match returned rows");
  if (summary.retainedRoutes < summary.matchedRoutes || summary.matchedRoutes < summary.returnedRoutes || summary.retainedEvents < summary.matchedEvents || summary.matchedEvents < summary.returnedEvents) throw new Error("lifecycle summary count hierarchy is invalid");
  if (summary.eventsTruncated !== summary.returnedEvents < summary.matchedEvents) throw new Error("lifecycle event truncation flag is inconsistent");
  return { schemaVersion: 1, readOnly: true, executionPermission: false, generatedAt, runtime, summary, universes, routes, events };
}

function parseRuntime(value: unknown): LifecycleResponse["runtime"] {
  const row = record(value, "runtime");
  const acceptedSnapshots = integer(row.acceptedSnapshots, "runtime.acceptedSnapshots");
  const rejectedSnapshots = integer(row.rejectedSnapshots, "runtime.rejectedSnapshots");
  const lastAcceptedAt = optionalTimestamp(row.lastAcceptedAt, "runtime.lastAcceptedAt");
  const lastRejectedAt = optionalTimestamp(row.lastRejectedAt, "runtime.lastRejectedAt");
  const lastError = optionalText(row.lastError, "runtime.lastError");
  if (lastError && lastError.length > 240) throw new Error("runtime.lastError is too long");
  return { acceptedSnapshots, rejectedSnapshots, ...(lastAcceptedAt === undefined ? {} : { lastAcceptedAt }), ...(lastRejectedAt === undefined ? {} : { lastRejectedAt }), ...(lastError === undefined ? {} : { lastError }) };
}

function parseSummary(value: unknown): LifecycleResponse["summary"] {
  const row = record(value, "summary");
  return {
    universeCount: integer(row.universeCount, "summary.universeCount"),
    retainedRoutes: integer(row.retainedRoutes, "summary.retainedRoutes"),
    matchedRoutes: integer(row.matchedRoutes, "summary.matchedRoutes"),
    returnedRoutes: integer(row.returnedRoutes, "summary.returnedRoutes"),
    routesTruncated: bool(row.routesTruncated, "summary.routesTruncated"),
    retainedEvents: integer(row.retainedEvents, "summary.retainedEvents"),
    matchedEvents: integer(row.matchedEvents, "summary.matchedEvents"),
    returnedEvents: integer(row.returnedEvents, "summary.returnedEvents"),
    eventsTruncated: bool(row.eventsTruncated, "summary.eventsTruncated"),
    nextEventSequence: integer(row.nextEventSequence, "summary.nextEventSequence")
  };
}

function parseUniverse(value: unknown, label: string): LifecycleUniverse {
  const row = record(value, label);
  return {
    universeId: identifier(row.universeId, `${label}.universeId`),
    lastPolicyId: identifier(row.lastPolicyId, `${label}.lastPolicyId`),
    lastSnapshotId: identifier(row.lastSnapshotId, `${label}.lastSnapshotId`),
    lastSnapshotFingerprint: text(row.lastSnapshotFingerprint, `${label}.lastSnapshotFingerprint`),
    lastEvaluatedAt: timestamp(row.lastEvaluatedAt, `${label}.lastEvaluatedAt`),
    coverageComplete: bool(row.coverageComplete, `${label}.coverageComplete`),
    lastCoverageReason: reason(row.lastCoverageReason, `${label}.lastCoverageReason`)
  };
}

function parseRoute(value: unknown, label: string): LifecycleRoute {
  const row = record(value, label);
  const status = exact(row.status, STATUSES, `${label}.status`);
  const actionable = bool(row.actionable, `${label}.actionable`);
  const evidenceComplete = bool(row.evidenceComplete, `${label}.evidenceComplete`);
  const effectiveEvidenceQuality = exact(row.effectiveEvidenceQuality, QUALITIES, `${label}.effectiveEvidenceQuality`);
  if (actionable && (status !== "confirmed" || !evidenceComplete || (effectiveEvidenceQuality !== "fresh" && effectiveEvidenceQuality !== "verified"))) throw new Error(`${label}.actionable is inconsistent with lifecycle evidence`);
  const firstSeenAt = timestamp(row.firstSeenAt, `${label}.firstSeenAt`);
  const lastSeenAt = timestamp(row.lastSeenAt, `${label}.lastSeenAt`);
  const lastObservationAt = timestamp(row.lastObservationAt, `${label}.lastObservationAt`);
  if (firstSeenAt > lastSeenAt) throw new Error(`${label} timestamp order is invalid`);
  const recentObservationIds = stringArray(row.recentObservationIds, `${label}.recentObservationIds`, 128);
  const evidenceSourceIds = stringArray(row.evidenceSourceIds, `${label}.evidenceSourceIds`, 128);
  const universeId = identifier(row.universeId, `${label}.universeId`);
  const kind = exact(row.kind, KINDS, `${label}.kind`);
  const routeId = identifier(row.routeId, `${label}.routeId`);
  const key = text(row.key, `${label}.key`);
  if (key !== `${universeId}\u001f${kind}\u001f${routeId}`) throw new Error(`${label}.key does not match its universe and route`);
  return {
    key,
    universeId,
    policyId: identifier(row.policyId, `${label}.policyId`),
    kind,
    routeId,
    status,
    actionable,
    firstSeenAt,
    lastSeenAt,
    lastObservationAt,
    lastObservationId: identifier(row.lastObservationId, `${label}.lastObservationId`),
    recentObservationIds,
    score: finite(row.score, `${label}.score`),
    rawEvidenceQuality: exact(row.rawEvidenceQuality, QUALITIES, `${label}.rawEvidenceQuality`),
    effectiveEvidenceQuality,
    evidenceSourceIds,
    evidenceComplete,
    confirmationCount: integer(row.confirmationCount, `${label}.confirmationCount`),
    ...optionalRouteTimes(row, label),
    lastReason: reason(row.lastReason, `${label}.lastReason`)
  };
}

function parseEvent(value: unknown, label: string): LifecycleEvent {
  const row = record(value, label);
  const kind = row.kind === undefined ? undefined : exact(row.kind, KINDS, `${label}.kind`);
  const from = row.from === undefined ? undefined : exact(row.from, STATUSES, `${label}.from`);
  const to = row.to === undefined ? undefined : exact(row.to, STATUSES, `${label}.to`);
  const routeId = row.routeId === undefined ? undefined : identifier(row.routeId, `${label}.routeId`);
  const observationId = row.observationId === undefined ? undefined : identifier(row.observationId, `${label}.observationId`);
  return {
    id: identifier(row.id, `${label}.id`),
    sequence: positiveInteger(row.sequence, `${label}.sequence`),
    type: exact(row.type, ["universe", "transition", "evidence-rejected"] as const, `${label}.type`),
    universeId: identifier(row.universeId, `${label}.universeId`),
    policyId: identifier(row.policyId, `${label}.policyId`),
    ...(kind ? { kind } : {}),
    ...(routeId ? { routeId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    reason: reason(row.reason, `${label}.reason`),
    effectiveAt: timestamp(row.effectiveAt, `${label}.effectiveAt`),
    evaluatedAt: timestamp(row.evaluatedAt, `${label}.evaluatedAt`),
    ...(observationId ? { observationId } : {})
  };
}

function optionalRouteTimes(row: Record<string, unknown>, label: string) {
  const values = {
    confirmationStartedAt: optionalTimestamp(row.confirmationStartedAt, `${label}.confirmationStartedAt`),
    confirmedAt: optionalTimestamp(row.confirmedAt, `${label}.confirmedAt`),
    decayStartedAt: optionalTimestamp(row.decayStartedAt, `${label}.decayStartedAt`),
    expiredAt: optionalTimestamp(row.expiredAt, `${label}.expiredAt`)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Pick<LifecycleRoute, "confirmationStartedAt" | "confirmedAt" | "decayStartedAt" | "expiredAt">;
}

function reason(value: unknown, label: string) {
  return exact(value, REASONS, label);
}

function timestamp(value: unknown, label: string) {
  return integer(value, label);
}

function optionalTimestamp(value: unknown, label: string) {
  return value === undefined ? undefined : timestamp(value, label);
}

function positiveInteger(value: unknown, label: string) {
  const parsed = integer(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function identifier(value: unknown, label: string) {
  const parsed = text(value, label);
  if (parsed.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]*$/.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function stringArray(value: unknown, label: string, maximum: number) {
  const result = array(value, label, maximum).map((item, index) => identifier(item, `${label}[${index}]`));
  unique(result, label);
  return result;
}

function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
