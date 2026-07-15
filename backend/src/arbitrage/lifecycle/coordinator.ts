import { createOpportunityLifecycleState, evaluateOpportunityLifecycle } from "./engine.js";
import type { OpportunityLifecycleEvaluation, OpportunityLifecyclePolicy, OpportunityLifecycleSnapshot, OpportunityLifecycleState } from "./types.js";
import type { OpportunityLifecycleReadQuery, OpportunityLifecycleReadResponse, OpportunityLifecycleRuntimeStatus } from "./runtimeTypes.js";

const DEFAULT_ROUTE_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 100;
export const MAX_LIFECYCLE_READ_ROWS = 500;
export const MAX_LIFECYCLE_ROUTE_OFFSET = 100_000;

type LifecycleEvaluator = (previous: OpportunityLifecycleState, snapshot: OpportunityLifecycleSnapshot, policy: Partial<OpportunityLifecyclePolicy>) => OpportunityLifecycleEvaluation;

export interface OpportunityLifecycleCoordinatorOptions {
  initialState?: OpportunityLifecycleState;
  defaultPolicy?: Partial<OpportunityLifecyclePolicy>;
  policies?: Readonly<Record<string, Partial<OpportunityLifecyclePolicy>>>;
  now?: () => number;
  /** Test/failure-injection seam. Production uses the pure reducer. */
  evaluate?: LifecycleEvaluator;
}

/**
 * Transactional, bounded in-memory owner for the pure lifecycle reducer.
 * It has no notification, account, credential or order dependency.
 */
export class OpportunityLifecycleCoordinator {
  private state: OpportunityLifecycleState;
  private readonly defaultPolicy: Partial<OpportunityLifecyclePolicy>;
  private readonly policies: Readonly<Record<string, Partial<OpportunityLifecyclePolicy>>>;
  private readonly now: () => number;
  private readonly evaluator: LifecycleEvaluator;
  private runtime: OpportunityLifecycleRuntimeStatus = { acceptedSnapshots: 0, rejectedSnapshots: 0 };

  constructor(options: OpportunityLifecycleCoordinatorOptions = {}) {
    this.state = clone(options.initialState ?? createOpportunityLifecycleState());
    this.defaultPolicy = { ...options.defaultPolicy };
    this.policies = Object.fromEntries(Object.entries(options.policies ?? {}).map(([key, value]) => [key, { ...value }]));
    this.now = options.now ?? Date.now;
    this.evaluator = options.evaluate ?? evaluateOpportunityLifecycle;
  }

  ingest(snapshot: OpportunityLifecycleSnapshot, policy?: Partial<OpportunityLifecyclePolicy>): OpportunityLifecycleEvaluation {
    const inputState = clone(this.state);
    try {
      const evaluation = this.evaluator(inputState, snapshot, policy ?? this.policies[snapshot.policyId] ?? this.defaultPolicy);
      // Do not expose the coordinator's mutable owner state through evaluator return references.
      this.state = clone(evaluation.state);
      this.recordAcceptedSnapshot(snapshot.evaluatedAt);
      return { ...evaluation, state: clone(evaluation.state), routes: evaluation.routes.map(cloneRoute), events: evaluation.events.map((event) => ({ ...event })) };
    } catch (error) {
      this.recordRejectedSnapshot(snapshot.evaluatedAt, error);
      throw error;
    }
  }

  /**
   * Internal no-export ingestion path for trusted runtime adapters. The production
   * reducer is pure and creates a detached state before changing it, so its result
   * can become the coordinator-owned state without three redundant full-state
   * structured clones. Failure-injected evaluators retain the defensive boundary.
   */
  ingestRuntime(snapshot: OpportunityLifecycleSnapshot, policy?: Partial<OpportunityLifecyclePolicy>): void {
    const trustedPureReducer = this.evaluator === evaluateOpportunityLifecycle;
    const inputState = trustedPureReducer ? this.state : clone(this.state);
    try {
      const evaluation = this.evaluator(inputState, snapshot, policy ?? this.policies[snapshot.policyId] ?? this.defaultPolicy);
      this.state = trustedPureReducer ? evaluation.state : clone(evaluation.state);
      this.recordAcceptedSnapshot(snapshot.evaluatedAt);
    } catch (error) {
      this.recordRejectedSnapshot(snapshot.evaluatedAt, error);
      throw error;
    }
  }

  /** Records adapter/transport rejection without accepting a partial snapshot. */
  recordRejectedSnapshot(evaluatedAt: number, error: unknown) {
    this.runtime = {
      ...this.runtime,
      rejectedSnapshots: this.runtime.rejectedSnapshots + 1,
      lastRejectedAt: safeTimestamp(evaluatedAt) ? evaluatedAt : this.now(),
      lastError: sanitizeError(error)
    };
  }

  read(query: OpportunityLifecycleReadQuery = {}): OpportunityLifecycleReadResponse {
    const routeLimit = boundedInteger(query.routeLimit, DEFAULT_ROUTE_LIMIT, 1, MAX_LIFECYCLE_READ_ROWS);
    const eventLimit = boundedInteger(query.eventLimit, DEFAULT_EVENT_LIMIT, 0, MAX_LIFECYCLE_READ_ROWS);
    const routeOffset = boundedInteger(query.routeOffset, 0, 0, MAX_LIFECYCLE_ROUTE_OFFSET);
    const afterSequence = boundedInteger(query.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    const allRoutes = Object.values(this.state.routes);
    const matchingRoutes = allRoutes.filter((route) => routeMatches(route, query)).sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.key.localeCompare(right.key));
    const routes = matchingRoutes.slice(routeOffset, routeOffset + routeLimit).map(cloneRoute);
    const matchingEvents = this.state.history.filter((event) => event.sequence > afterSequence && eventMatches(event, query)).sort((left, right) => right.sequence - left.sequence);
    const events = matchingEvents.slice(0, eventLimit).map((event) => ({ ...event }));
    const universes = Object.values(this.state.universes)
      .filter((universe) => !query.universeId || universe.universeId === query.universeId)
      .sort((left, right) => left.universeId.localeCompare(right.universeId))
      .map((universe) => ({ ...universe }));
    return {
      schemaVersion: 1,
      readOnly: true,
      executionPermission: false,
      generatedAt: this.now(),
      runtime: { ...this.runtime },
      summary: {
        universeCount: universes.length,
        retainedRoutes: allRoutes.length,
        matchedRoutes: matchingRoutes.length,
        returnedRoutes: routes.length,
        routesTruncated: routeOffset + routes.length < matchingRoutes.length,
        retainedEvents: this.state.history.length,
        matchedEvents: matchingEvents.length,
        returnedEvents: events.length,
        eventsTruncated: events.length < matchingEvents.length,
        nextEventSequence: this.state.nextEventSequence
      },
      universes,
      routes,
      events
    };
  }

  /** Defensive export for optional atomic persistence owned by a different layer. */
  exportState(): OpportunityLifecycleState {
    return clone(this.state);
  }

  private recordAcceptedSnapshot(evaluatedAt: number) {
    this.runtime = {
      ...this.runtime,
      acceptedSnapshots: this.runtime.acceptedSnapshots + 1,
      lastAcceptedAt: evaluatedAt,
      lastError: undefined
    };
  }
}

function routeMatches(route: OpportunityLifecycleReadResponse["routes"][number], query: OpportunityLifecycleReadQuery) {
  return (!query.universeId || route.universeId === query.universeId) && (!query.routeId || route.routeId === query.routeId) && (!query.kind || route.kind === query.kind) && (!query.status || route.status === query.status) && (query.actionable === undefined || route.actionable === query.actionable);
}

function eventMatches(event: OpportunityLifecycleReadResponse["events"][number], query: OpportunityLifecycleReadQuery) {
  return (!query.universeId || event.universeId === query.universeId) && (!query.routeId || event.routeId === query.routeId) && (!query.kind || event.kind === query.kind);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneRoute(route: OpportunityLifecycleReadResponse["routes"][number]) {
  return { ...route, recentObservationIds: [...route.recentObservationIds], evidenceSourceIds: [...route.evidenceSourceIds] };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new TypeError(`Lifecycle read bound must be an integer from ${minimum} to ${maximum}`);
  return resolved;
}

function safeTimestamp(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sanitizeError(error: unknown) {
  // This status is public. Never reflect arbitrary transport/payload error text,
  // because upstream messages can contain URLs, headers or other sensitive context.
  if (error instanceof TypeError) return "Lifecycle snapshot validation failed";
  if (error instanceof Error && error.name === "AbortError") return "Lifecycle snapshot aborted";
  return "Lifecycle snapshot rejected";
}
