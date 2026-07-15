export type VenueClockStatus = "calibrated" | "degraded" | "expired" | "unavailable";
export interface VenueClockHealthSource {
    sourceId: string;
    status: VenueClockStatus;
    evaluatedAt: number;
    sampleCount: number;
    consistentSampleCount: number;
    sampledAt?: number;
    expiresAt?: number;
    roundTripMs?: number;
    minimumObservedRoundTripMs?: number;
    offsetLowerMs?: number;
    offsetUpperMs?: number;
    offsetMidpointMs?: number;
    uncertaintyMs?: number;
    rejectedProbes: number;
    reason?: "no-samples" | "sample-expired" | "insufficient-consistent-samples" | "uncertainty-too-high";
    ok: boolean;
    endpoint: string;
    message?: string;
}
export interface VenueClockHealth {
    schemaVersion: 1;
    updatedAt: number;
    stale: boolean;
    sources: VenueClockHealthSource[];
}
export declare function parseVenueClockHealth(value: unknown): VenueClockHealth;
