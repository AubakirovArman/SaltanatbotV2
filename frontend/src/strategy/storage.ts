import type { IndicatorConfig } from "../chart/indicatorTypes";
import { createDefaultIndicators } from "../chart/defaultIndicators";
import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";
import type { StrategyArtifact } from "./library";
import { mergeDefaultStrategyLibrary } from "./library";
import { normalizeCyclesAnalysisArtifact } from "./pine/compatibility";

const indicatorsKey = "marketforge.indicators.v1";
const libraryKey = "marketforge.strategyLibrary.v1";

export function loadInitialWorkspaceState(ownerId?: string) {
  const indicators = readJson<IndicatorConfig[]>(indicatorsKey, ownerId) ?? createDefaultIndicators();
  return {
    indicators,
    strategyLibrary: mergeDefaultStrategyLibrary(readJson<StrategyArtifact[]>(libraryKey, ownerId), indicators)
      .map(normalizeCyclesAnalysisArtifact)
  };
}

export function storeIndicators(indicators: IndicatorConfig[], ownerId?: string) {
  writeJson(indicatorsKey, indicators, ownerId);
}

export function storeStrategyLibrary(library: StrategyArtifact[], ownerId?: string) {
  writeJson(libraryKey, library, ownerId);
}

function readJson<T>(key: string, ownerId?: string): T | undefined {
  try {
    const raw = readTenantLocalItem(window.localStorage, key, ownerId);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson<T>(key: string, value: T, ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, key, JSON.stringify(value), ownerId);
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
