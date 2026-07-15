import { createHash } from "node:crypto";
import type { ResearchAlertEconomicIdentity } from "./types.js";

/**
 * Family-independent identity for the same economic route. Family and display
 * symbols are intentionally excluded; exact instruments, venues and direction remain.
 */
export function researchAlertDedupKey(identity: ResearchAlertEconomicIdentity): string {
  const legs = identity.legs.map((leg) => ({ venue: leg.venue, instrumentId: leg.instrumentId, marketType: leg.marketType, side: leg.side })).sort((left, right) => canonicalLeg(left).localeCompare(canonicalLeg(right)));
  return `research-economic-route:v1:${digest({ economicAssetId: identity.economicAssetId, legs }).slice(0, 40)}`;
}

export function researchAlertSnapshotFingerprint(value: unknown): string {
  return digest(value);
}

export function researchAlertPolicyFingerprint(value: unknown): string {
  return digest(value);
}

function canonicalLeg(leg: ResearchAlertEconomicIdentity["legs"][number]) {
  return `${leg.venue}\u0000${leg.instrumentId}\u0000${leg.marketType}\u0000${leg.side}`;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
