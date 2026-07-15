import type { InstrumentRegistrySnapshot } from "../market/instrumentRegistry.js";
import type { ArbitrageIdentityCoverage } from "./types.js";

const REQUIRED_BASIS_REGISTRY_SOURCES = ["binance:spot", "binance:derivatives", "binance:funding", "bybit:spot", "bybit:linear"] as const;

export function basisIdentityCoverage(snapshot: InstrumentRegistrySnapshot | undefined): ArbitrageIdentityCoverage {
  if (!snapshot) return { complete: false, stale: true, failedSources: ["registry-unavailable"] };
  const groups = new Map<string, InstrumentRegistrySnapshot["sourceStates"]>();
  for (const state of snapshot.sourceStates) {
    const rows = groups.get(state.source) ?? [];
    rows.push(state);
    groups.set(state.source, rows);
  }
  const failedSources: string[] = [];
  let stale = false;
  for (const source of REQUIRED_BASIS_REGISTRY_SOURCES) {
    const states = groups.get(source) ?? [];
    if (states.length !== 1) failedSources.push(states.length === 0 ? `missing:${source}` : `duplicate:${source}`);
    else if (states[0]!.status !== "fresh") {
      failedSources.push(source);
      stale ||= states[0]!.status === "stale-cache";
    }
  }
  return { complete: failedSources.length === 0, stale, failedSources };
}
