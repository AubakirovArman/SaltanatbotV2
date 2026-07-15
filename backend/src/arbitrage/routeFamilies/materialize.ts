import type { PairwiseRoute } from "../engines/pairwise/index.js";
import { routeFamilyScopeKey } from "./discovery.js";
import type { MaterializedRoute, RouteFamilyAssumptionCatalog, RouteFamilyCandidate, RouteFamilyScope } from "./types.js";

export interface RouteMaterializationResult {
  routes: MaterializedRoute[];
  missing: Array<{ candidate: RouteFamilyCandidate; message: string }>;
}

/** Attaches only exact-scope, point-in-time assumptions; no defaults are synthesized. */
export function materializeRouteFamilyCandidates(candidates: readonly RouteFamilyCandidate[], catalog: RouteFamilyAssumptionCatalog): RouteMaterializationResult {
  const scopes = exactMap(catalog.scopes, (value) => routeFamilyScopeKey(value.family, value.longInstrumentId, value.shortInstrumentId), "route scope");
  const capital = exactMap(catalog.capital, (value) => value.instrumentId, "capital assumption");
  const inventory = exactMap(catalog.inventory, (value) => value.instrumentId, "inventory assumption");
  const borrow = exactMap(catalog.borrow, (value) => value.instrumentId, "borrow assumption");
  const funding = exactMap(catalog.funding, (value) => value.instrumentId, "funding assumption");
  const routes: MaterializedRoute[] = [];
  const missing: RouteMaterializationResult["missing"] = [];

  for (const candidate of candidates) {
    const scope = scopes.get(candidate.routeKey);
    if (!scope) {
      missing.push({ candidate, message: "Exact route scope with requested quantity and family assumptions is required" });
      continue;
    }
    const result = materialize(candidate, scope, { capital, inventory, borrow, funding });
    if (typeof result === "string") missing.push({ candidate, message: result });
    else routes.push({ candidate, route: result });
  }
  return { routes, missing };
}

function materialize(
  candidate: RouteFamilyCandidate,
  scope: RouteFamilyScope,
  values: {
    capital: ReadonlyMap<string, RouteFamilyAssumptionCatalog["capital"][number]>;
    inventory: ReadonlyMap<string, RouteFamilyAssumptionCatalog["inventory"][number]>;
    borrow: ReadonlyMap<string, RouteFamilyAssumptionCatalog["borrow"][number]>;
    funding: ReadonlyMap<string, RouteFamilyAssumptionCatalog["funding"][number]>;
  }
): PairwiseRoute | string {
  if (!Number.isFinite(scope.requestedBaseQuantity) || scope.requestedBaseQuantity <= 0) return "A positive requestedBaseQuantity is required";
  const base = {
    routeId: candidate.routeId,
    longInstrumentId: candidate.longInstrumentId,
    shortInstrumentId: candidate.shortInstrumentId,
    requestedBaseQuantity: scope.requestedBaseQuantity
  };
  if (candidate.family === "cross-venue-spot-spot") {
    const longCapital = values.capital.get(candidate.longInstrumentId);
    const shortAccess = values.inventory.get(candidate.shortInstrumentId);
    if (!longCapital || !shortAccess || !scope.rebalance) return "Spot-spot requires exact long quote capital, short base inventory and rebalance assumptions";
    return { ...base, strategyKind: "spot-spot", longCapital, shortAccess, rebalance: scope.rebalance };
  }
  if (!scope.convergence) return "A route-specific convergence assumption is required";
  if (candidate.family === "reverse-cash-and-carry") {
    const spotBorrow = values.borrow.get(candidate.shortInstrumentId);
    const perpetualFunding = values.funding.get(candidate.longInstrumentId);
    if (!spotBorrow || !perpetualFunding) return "Reverse carry requires exact spot borrow and long-perpetual funding assumptions";
    return { ...base, strategyKind: "reverse-cash-and-carry", convergence: scope.convergence, borrow: spotBorrow, funding: [perpetualFunding] };
  }
  if (candidate.family === "perpetual-perpetual-funding") {
    const longFunding = values.funding.get(candidate.longInstrumentId);
    const shortFunding = values.funding.get(candidate.shortInstrumentId);
    if (!longFunding || !shortFunding) return "Perpetual-perpetual requires one full-horizon funding assumption for each leg";
    return { ...base, strategyKind: "perpetual-perpetual", convergence: scope.convergence, funding: [longFunding, shortFunding] };
  }
  if (candidate.family === "spot-dated-future") {
    const longCapital = values.capital.get(candidate.longInstrumentId);
    if (!longCapital || !scope.delivery) return "Spot-dated-future requires exact spot quote capital and delivery assumptions";
    return { ...base, strategyKind: "spot-dated-future", longCapital, convergence: scope.convergence, delivery: scope.delivery };
  }
  if (candidate.family === "calendar-spread") {
    if (!scope.delivery) return "Calendar spread requires an exact delivery/roll assumption";
    return { ...base, strategyKind: "calendar-spread", convergence: scope.convergence, delivery: scope.delivery };
  }
  if (!scope.delivery) return "Perpetual-future requires an exact close-before-expiry assumption";
  const perpetualId = candidate.longMarketType === "perpetual" ? candidate.longInstrumentId : candidate.shortInstrumentId;
  const perpetualFunding = values.funding.get(perpetualId);
  if (!perpetualFunding) return "Perpetual-future requires a full-horizon funding assumption for its perpetual leg";
  return { ...base, strategyKind: "perpetual-future", convergence: scope.convergence, funding: [perpetualFunding], delivery: scope.delivery };
}

function exactMap<T>(rows: readonly T[], key: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) throw new Error(`Duplicate ${label} for ${id}`);
    result.set(id, row);
  }
  return result;
}
