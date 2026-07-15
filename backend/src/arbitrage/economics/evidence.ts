import type { EconomicFailure, EconomicFxRate, VersionedEvidence } from "./types.js";

export function validateEvidence(
  evidence: VersionedEvidence,
  evaluatedAt: number,
  maximumAgeMs: number,
  maximumFutureClockSkewMs: number,
  coverageUntil = evaluatedAt
): EconomicFailure[] {
  const failures: EconomicFailure[] = [];
  if (!text(evidence.source) || !text(evidence.version) || !finiteTimestamp(evidence.asOf) || !finiteTimestamp(evidence.validUntil) || evidence.validUntil < evidence.asOf) {
    return [{ code: "invalid-request", message: "Evidence identity or validity interval is invalid" }];
  }
  if (evidence.asOf > evaluatedAt + maximumFutureClockSkewMs) failures.push({ code: "future-evidence", message: "Evidence timestamp is ahead of the allowed clock skew" });
  if (evaluatedAt - evidence.asOf > maximumAgeMs) failures.push({ code: "stale-evidence", message: "Evidence is older than the configured maximum age" });
  if (evidence.validUntil < coverageUntil) failures.push({ code: "coverage-gap", message: "Evidence does not cover the required horizon" });
  return failures;
}

export function evidenceId(value: VersionedEvidence): string {
  return `${value.source}@${value.version}:${value.asOf}-${value.validUntil}`;
}

export function convertAsset(
  quantity: number,
  asset: string,
  valuationAsset: string,
  fxRates: readonly EconomicFxRate[],
  direction: "cost" | "proceeds"
): number | undefined {
  if (asset === valuationAsset) return quantity;
  const direct = fxRates.find((rate) => rate.baseAsset === asset && rate.quoteAsset === valuationAsset);
  if (direct) return quantity * (direction === "cost" ? direct.ask : direct.bid);
  const inverse = fxRates.find((rate) => rate.baseAsset === valuationAsset && rate.quoteAsset === asset);
  if (inverse) return quantity / (direction === "cost" ? inverse.bid : inverse.ask);
  return undefined;
}

export function fxRateFor(asset: string, valuationAsset: string, fxRates: readonly EconomicFxRate[]): EconomicFxRate | undefined {
  return fxRates.find(
    (rate) =>
      (rate.baseAsset === asset && rate.quoteAsset === valuationAsset) ||
      (rate.baseAsset === valuationAsset && rate.quoteAsset === asset)
  );
}

function text(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}

function finiteTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
