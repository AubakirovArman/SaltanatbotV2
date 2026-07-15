import type { OpportunityLifecycleRoute } from "../lifecycle/index.js";
import type { ResearchAlertFamily, ResearchAlertLifecycleEvidence, ResearchAlertLifecycleKind } from "./types.js";

/** Exact adapter from the existing lifecycle coordinator's retained route view. */
export function lifecycleRouteToResearchAlertEvidence(route: OpportunityLifecycleRoute, family: ResearchAlertFamily): ResearchAlertLifecycleEvidence {
  const expected = researchAlertLifecycleKind(family);
  if (route.kind !== expected) throw new TypeError(`Lifecycle kind ${route.kind} cannot evidence ${family}`);
  return {
    universeId: route.universeId,
    policyId: route.policyId,
    kind: expected,
    routeId: route.routeId,
    observationId: route.lastObservationId,
    status: route.status,
    actionable: route.actionable,
    lastObservationAt: route.lastObservationAt,
    effectiveEvidenceQuality: route.effectiveEvidenceQuality,
    evidenceComplete: route.evidenceComplete,
    evidenceSourceIds: [...route.evidenceSourceIds]
  };
}

export function researchAlertLifecycleKind(family: ResearchAlertFamily): ResearchAlertLifecycleKind {
  switch (family) {
    case "cross-venue-spot-spot":
    case "reverse-cash-and-carry":
    case "perpetual-perpetual-funding":
    case "spot-dated-future":
    case "calendar-spread":
    case "perpetual-future":
      return "pairwise";
    case "basis":
    case "triangular":
    case "native-spread":
    case "options-parity":
    case "n-leg":
    case "cex-dex":
      return family;
  }
}
