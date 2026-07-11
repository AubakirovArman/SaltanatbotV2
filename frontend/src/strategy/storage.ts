import type { IndicatorConfig } from "../chart/indicatorTypes";
import { createDefaultIndicators } from "../chart/defaultIndicators";
import type { StrategyArtifact } from "./library";
import { mergeDefaultStrategyLibrary } from "./library";
import { normalizeCyclesAnalysisArtifact } from "./pine/compatibility";

const indicatorsKey = "marketforge.indicators.v1";
const libraryKey = "marketforge.strategyLibrary.v1";

export function loadInitialWorkspaceState() {
  const indicators = readJson<IndicatorConfig[]>(indicatorsKey) ?? createDefaultIndicators();
  return {
    indicators,
    strategyLibrary: mergeDefaultStrategyLibrary(readJson<StrategyArtifact[]>(libraryKey), indicators)
      .map(normalizeCyclesAnalysisArtifact)
  };
}

export function storeIndicators(indicators: IndicatorConfig[]) {
  writeJson(indicatorsKey, indicators);
}

export function storeStrategyLibrary(library: StrategyArtifact[]) {
  writeJson(libraryKey, library);
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
