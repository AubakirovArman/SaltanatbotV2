import { basisScanToLifecycleSnapshot, type BasisLifecycleAdapterOptions, type BasisLifecycleScan } from "./basisAdapter.js";
import type { OpportunityLifecycleCoordinator } from "./coordinator.js";
import type { OpportunityLifecyclePolicy } from "./types.js";

export const BASIS_LIFECYCLE_POLICY_V1: Readonly<Partial<OpportunityLifecyclePolicy>> = Object.freeze({
  enterScore: 0,
  exitScore: -5,
  confirmationObservations: 2,
  confirmationMinDurationMs: 250,
  minimumEvidenceQuality: "fresh",
  minimumEvidenceSources: 2,
  observationFreshForMs: 10_000,
  decayGraceMs: 10_000,
  maxFutureSkewMs: 1_000,
  maxRoutes: 10_000,
  maxEvents: 10_000,
  maxCandidatesPerSnapshot: 10_000,
  maxEvidenceSourcesPerCandidate: 2
});

export interface BasisLifecycleSource {
  subscribe(listener: (scan: BasisLifecycleScan) => void): () => void;
  current(): BasisLifecycleScan | undefined;
}

export interface BasisLifecycleRuntimeOptions extends BasisLifecycleAdapterOptions {
  policy?: Partial<OpportunityLifecyclePolicy>;
}

/**
 * Attaches the read-only basis stream to lifecycle state. Subscribe-before-current
 * closes the bootstrap race; duplicate snapshots remain idempotent in the reducer.
 */
export function attachBasisOpportunityLifecycle(source: BasisLifecycleSource, coordinator: OpportunityLifecycleCoordinator, options: BasisLifecycleRuntimeOptions = {}) {
  const safeConsume = (scan: BasisLifecycleScan) => {
    let snapshot: ReturnType<typeof basisScanToLifecycleSnapshot>;
    try {
      snapshot = basisScanToLifecycleSnapshot(scan, options);
    } catch (error) {
      coordinator.recordRejectedSnapshot(scan.updatedAt, error);
      return;
    }
    try {
      coordinator.ingestRuntime(snapshot, options.policy ?? BASIS_LIFECYCLE_POLICY_V1);
    } catch {
      // The coordinator already recorded the reducer rejection transactionally.
      // One malformed snapshot must not tear down public market data.
    }
  };
  const unsubscribe = source.subscribe(safeConsume);
  const current = source.current();
  if (current) safeConsume(current);
  return unsubscribe;
}
