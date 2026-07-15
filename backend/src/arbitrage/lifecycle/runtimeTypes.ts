import type { OpportunityLifecycleEvent, OpportunityLifecycleKind, OpportunityLifecycleRoute, OpportunityLifecycleStatus, OpportunityLifecycleUniverse } from "./types.js";

export interface OpportunityLifecycleRuntimeStatus {
  acceptedSnapshots: number;
  rejectedSnapshots: number;
  lastAcceptedAt?: number;
  lastRejectedAt?: number;
  /** Sanitized operational error only; input payloads are never retained here. */
  lastError?: string;
}

export interface OpportunityLifecycleReadQuery {
  universeId?: string;
  routeId?: string;
  kind?: OpportunityLifecycleKind;
  status?: OpportunityLifecycleStatus;
  actionable?: boolean;
  routeOffset?: number;
  routeLimit?: number;
  afterSequence?: number;
  eventLimit?: number;
}

export interface OpportunityLifecycleReadResponse {
  schemaVersion: 1;
  readOnly: true;
  /** Lifecycle readiness is research state and never an execution permission. */
  executionPermission: false;
  generatedAt: number;
  runtime: OpportunityLifecycleRuntimeStatus;
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
  universes: OpportunityLifecycleUniverse[];
  routes: OpportunityLifecycleRoute[];
  /** Newest event first. Use afterSequence for incremental reads. */
  events: OpportunityLifecycleEvent[];
}
