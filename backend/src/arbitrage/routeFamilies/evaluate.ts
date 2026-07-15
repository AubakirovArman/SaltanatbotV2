import { evaluatePairwiseRoute, pairwiseOpportunityOrder, type PairwiseBookSnapshot, type PairwiseInstrument, type PairwiseRejection } from "../engines/pairwise/index.js";
import { discoverRouteFamilyCandidates } from "./discovery.js";
import { materializeRouteFamilyCandidates } from "./materialize.js";
import type { RouteFamilyEvaluationRequest, RouteFamilyEvaluationResponse } from "./types.js";

/** Deterministic, transport-free evaluation of the six supported research route families. */
export function evaluateRouteFamilies(request: RouteFamilyEvaluationRequest): RouteFamilyEvaluationResponse {
  const instruments = uniqueMap(request.instruments, (value) => value.instrumentId, "instrument");
  const books = uniqueMap(request.books, (value) => value.instrumentId, "book");
  const discovery = discoverRouteFamilyCandidates(request.instruments, { families: request.families, maxCandidates: request.maxRoutes });
  const materialized = materializeRouteFamilyCandidates(discovery.candidates, request.assumptions);
  const opportunities = [];
  const rejections: PairwiseRejection[] = materialized.missing.map(({ candidate, message }) => ({ routeId: candidate.routeId, code: "missing-assumption", message }));
  for (const { route } of materialized.routes) {
    const result = evaluatePairwiseRoute(route, instruments as ReadonlyMap<string, PairwiseInstrument>, books as ReadonlyMap<string, PairwiseBookSnapshot>, request.options);
    if (result.opportunity) opportunities.push(result.opportunity);
    else rejections.push(result.rejection);
  }
  opportunities.sort(pairwiseOpportunityOrder);
  rejections.sort((left, right) => (left.routeId ?? "").localeCompare(right.routeId ?? "") || left.code.localeCompare(right.code));
  return {
    engine: "route-families-v1",
    executionStatus: "research-only",
    executable: false,
    evaluatedAt: request.options.evaluatedAt,
    totalCompatibleCandidates: discovery.totalCompatibleCandidates,
    evaluatedRoutes: materialized.routes.length,
    truncated: discovery.truncated,
    candidates: discovery.candidates,
    opportunities,
    rejections,
    rejectedInstruments: discovery.rejectedInstruments
  };
}

function uniqueMap<T>(rows: readonly T[], key: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) throw new Error(`Duplicate route-family ${label} ${id}`);
    result.set(id, row);
  }
  return result;
}
