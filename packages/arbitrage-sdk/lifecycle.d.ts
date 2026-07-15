export type LifecycleKind = "basis" | "triangular" | "native-spread" | "pairwise";
export type LifecycleStatus = "first-seen" | "confirmed" | "decaying" | "expired";
export type LifecycleEvidenceQuality = "unverified" | "degraded" | "fresh" | "verified";
export type LifecycleReason = "candidate-observed" | "confirmation-complete" | "score-below-entry" | "score-below-exit" | "evidence-incomplete" | "evidence-quality" | "evidence-stale" | "route-absent" | "universe-incomplete" | "universe-restored" | "policy-changed" | "duplicate-route-conflict" | "observation-replayed" | "observation-out-of-order" | "observation-future" | "decay-grace-elapsed" | "route-capacity-reached";
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
    runtime: {
        acceptedSnapshots: number;
        rejectedSnapshots: number;
        lastAcceptedAt?: number;
        lastRejectedAt?: number;
        lastError?: string;
    };
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
export declare function parseLifecycleResponse(value: unknown): LifecycleResponse;
