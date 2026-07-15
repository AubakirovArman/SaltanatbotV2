import { array, bool, record, text } from "./validation.js";

export interface BasisIdentityCoverage {
  complete: boolean;
  stale: boolean;
  failedSources: string[];
}

export function parseBasisIdentityCoverage(value: unknown): BasisIdentityCoverage | undefined {
  if (value === undefined) return undefined;
  const row = record(value, "identityCoverage");
  const complete = bool(row.complete, "identityCoverage.complete");
  const stale = bool(row.stale, "identityCoverage.stale");
  const failedSources = array(row.failedSources, "identityCoverage.failedSources", 32).map((source, index) => text(source, `identityCoverage.failedSources[${index}]`));
  if (new Set(failedSources).size !== failedSources.length) throw new Error("identityCoverage.failedSources must be unique");
  if (complete !== (failedSources.length === 0) || (complete && stale)) throw new Error("identityCoverage status is inconsistent with failed sources");
  return { complete, stale, failedSources };
}
