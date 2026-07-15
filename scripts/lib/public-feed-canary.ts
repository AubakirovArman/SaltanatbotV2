export interface PublicFeedCanaryTarget {
  venue: string;
  instrumentId: string;
  environment: "mainnet-public" | "testnet-public";
  expectedBookIntegrity: "route-ready" | "research-only";
  expectedContinuityProtocol: string;
  requiredEvidence: {
    book: true;
    funding: boolean;
  };
}

export interface PublicFeedCanaryObservation {
  book: boolean;
  funding: boolean;
  bookIntegrity: "route-ready" | "research-only" | "none";
  continuityProtocol: string | "none";
}

export interface PublicFeedCanarySuccess extends PublicFeedCanaryTarget {
  ok: true;
  observedEvidence: PublicFeedCanaryObservation;
  book: Record<string, unknown>;
  funding?: Record<string, unknown>;
}

export interface PublicFeedCanaryFailure extends PublicFeedCanaryTarget {
  ok: false;
  observedEvidence: PublicFeedCanaryObservation;
  error: string;
}

export type PublicFeedCanaryVenueResult = PublicFeedCanarySuccess | PublicFeedCanaryFailure;

export interface PublicFeedCanaryOutput {
  schemaVersion: 3;
  kind: "credential-free-public-feed-canary";
  startedAt: number;
  finishedAt: number;
  timeoutMs: number;
  credentialsUsed: false;
  executionAttempted: false;
  soakClaimed: false;
  mainnetReadinessClaimed: false;
  ok: boolean;
  venues: PublicFeedCanaryVenueResult[];
}

const MAX_ERROR_LENGTH = 1_000;

export function requiredPublicEvidenceObserved(target: PublicFeedCanaryTarget, observation: PublicFeedCanaryObservation) {
  return observation.book && observation.bookIntegrity === target.expectedBookIntegrity && observation.continuityProtocol === target.expectedContinuityProtocol && (!target.requiredEvidence.funding || observation.funding);
}

export function successfulPublicFeedCanaryTarget(target: PublicFeedCanaryTarget, observation: PublicFeedCanaryObservation, book: Record<string, unknown>, funding?: Record<string, unknown>): PublicFeedCanarySuccess {
  if (!requiredPublicEvidenceObserved(target, observation)) throw new Error("Required public canary evidence is incomplete");
  if (target.requiredEvidence.funding && !funding) throw new Error("Required funding evidence is missing");
  if (publicBookIntegrity(book) !== target.expectedBookIntegrity) throw new Error("Public book integrity does not match the reviewed canary boundary");
  if (publicBookContinuityProtocol(book) !== target.expectedContinuityProtocol) throw new Error("Public book continuity protocol does not match the reviewed canary boundary");
  return {
    ...target,
    ok: true,
    observedEvidence: { ...observation },
    book: structuredClone(book),
    ...(funding ? { funding: structuredClone(funding) } : {})
  };
}

export function failedPublicFeedCanaryTarget(target: PublicFeedCanaryTarget, observation: PublicFeedCanaryObservation, error: unknown): PublicFeedCanaryFailure {
  return {
    ...target,
    ok: false,
    observedEvidence: { ...observation },
    error: boundedError(error)
  };
}

export function publicFeedCanaryOutput(input: {
  startedAt: number;
  finishedAt: number;
  timeoutMs: number;
  venues: readonly PublicFeedCanaryVenueResult[];
}): PublicFeedCanaryOutput {
  positiveSafeInteger(input.startedAt, "startedAt");
  positiveSafeInteger(input.finishedAt, "finishedAt");
  positiveSafeInteger(input.timeoutMs, "timeoutMs");
  if (input.finishedAt < input.startedAt) throw new Error("finishedAt must not precede startedAt");
  if (input.venues.length === 0 || input.venues.length > 32) throw new Error("venues must contain between 1 and 32 results");
  const identities = new Set<string>();
  const venues = input.venues.map((result) => {
    const identity = `${result.venue}\u0000${result.instrumentId}`;
    if (identities.has(identity)) throw new Error(`Duplicate public canary target ${result.venue}:${result.instrumentId}`);
    identities.add(identity);
    return structuredClone(result);
  });
  return {
    schemaVersion: 3,
    kind: "credential-free-public-feed-canary",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    timeoutMs: input.timeoutMs,
    credentialsUsed: false,
    executionAttempted: false,
    soakClaimed: false,
    mainnetReadinessClaimed: false,
    ok: venues.every(({ ok }) => ok),
    venues
  };
}

export function publicBookIntegrity(book: Record<string, unknown>): PublicFeedCanaryObservation["bookIntegrity"] {
  const continuity = book.continuity;
  if (!continuity || typeof continuity !== "object" || Array.isArray(continuity)) return "none";
  const proof = continuity as Record<string, unknown>;
  const kind = proof.kind;
  if (kind === "sequence-verified" && positiveSequence(proof.sequence)) return "route-ready";
  if (kind === "checksum-verified" && positiveSequence(proof.sequence) && Number.isSafeInteger(proof.checksum)) return "route-ready";
  if (kind === "sequence-observed" && positiveSequence(proof.sequence) && proof.sequenceVerified === false) return "research-only";
  if (kind === "atomic-snapshot" && proof.sequenceVerified === false) return "research-only";
  return "none";
}

export function publicBookContinuityProtocol(book: Record<string, unknown>): string | "none" {
  const continuity = book.continuity;
  if (!continuity || typeof continuity !== "object" || Array.isArray(continuity)) return "none";
  const protocol = (continuity as Record<string, unknown>).protocol;
  return typeof protocol === "string" && protocol.length > 0 && protocol.length <= 100 ? protocol : "none";
}

function positiveSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) || "Public feed canary failed";
}

function positiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}
