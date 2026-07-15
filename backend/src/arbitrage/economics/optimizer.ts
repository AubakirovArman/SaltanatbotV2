import type {
  AllocationRejection,
  CapitalAllocation,
  CapitalAllocationCandidate,
  CapitalAllocationRequest,
  CapitalAllocationResult,
  CapitalResource
} from "./optimizerTypes.js";

const EPSILON = 1e-10;
const MAX_CANDIDATES = 64;
const MAX_UNITS_PER_CANDIDATE = 10_000;
const MAX_SEARCH_NODES = 2_000_000;

interface PreparedCandidate extends CapitalAllocationCandidate {
  profitPerUnit: number;
  resources: Map<string, number>;
}

interface SearchState {
  index: number;
  profit: number;
  openRoutes: number;
  remaining: Map<string, number>;
  familyUsed: Map<string, number>;
  units: number[];
}

/**
 * Pure bounded discrete allocator. It returns only feasible allocations. When
 * the node budget is exhausted the incumbent is explicitly marked truncated,
 * together with a valid upper bound, and is never presented as optimal.
 */
export function allocateCapital(request: CapitalAllocationRequest): CapitalAllocationResult {
  validateRequest(request);
  const budgets = resourceMap(request.budgets, "budget");
  const familyLimits = new Map((request.familyLimits ?? []).map((row) => [row.family, row.maximumRiskCapital]));
  const allowed = new Set<CapitalAllocationCandidate["outcomeClass"]>(request.allowedOutcomeClasses ?? ["locked", "projected", "statistical"]);
  const rejections: AllocationRejection[] = [];
  const prepared: PreparedCandidate[] = [];

  for (const candidate of request.candidates) {
    const rejection = preflightCandidate(candidate, request.profitMode, budgets, allowed);
    if (rejection) {
      rejections.push(rejection);
      continue;
    }
    prepared.push({
      ...candidate,
      profitPerUnit: request.profitMode === "conservative" ? candidate.conservativeNetProfitPerUnit : candidate.projectedNetProfitPerUnit,
      resources: resourceMap(candidate.capitalPerUnit, `candidate ${candidate.routeId}`)
    });
  }

  prepared.sort((left, right) => candidateScore(right, budgets) - candidateScore(left, budgets) || right.profitPerUnit - left.profitPerUnit || left.routeId.localeCompare(right.routeId));
  const rootUpperBound = prepared.reduce((total, row) => total + row.profitPerUnit * row.maximumUnits, 0);
  const suffixUpperBound = suffixProfitBounds(prepared);
  let bestProfit = 0;
  let bestUnits = new Array(prepared.length).fill(0) as number[];
  let visitedNodes = 0;
  let truncated = false;

  const visit = (state: SearchState) => {
    if (truncated) return;
    if (visitedNodes >= request.maximumSearchNodes) {
      truncated = true;
      return;
    }
    visitedNodes += 1;
    if (state.profit + suffixUpperBound[state.index]! <= bestProfit + EPSILON) return;
    if (state.index === prepared.length) {
      if (state.profit > bestProfit + EPSILON || (Math.abs(state.profit - bestProfit) <= EPSILON && lexicographicallySmaller(state.units, bestUnits))) {
        bestProfit = state.profit;
        bestUnits = [...state.units];
      }
      return;
    }

    const candidate = prepared[state.index]!;
    const maximum = feasibleMaximumUnits(candidate, state, familyLimits, request.maximumOpenRoutes);
    for (const units of unitChoices(candidate, maximum)) {
      if (truncated) break;
      const next = applyUnits(state, candidate, units);
      next.index += 1;
      visit(next);
    }
  };

  visit({ index: 0, profit: 0, openRoutes: 0, remaining: new Map(budgets), familyUsed: new Map(), units: [] });

  const allocations = materializeAllocations(prepared, bestUnits);
  const used = aggregateResources(allocations.flatMap((row) => row.requiredCapital));
  const unusedCapital = [...budgets].map(([key, amount]) => {
    const [venue = "", asset = ""] = splitResourceKey(key);
    return { venue, asset, amount: cleanNumber(Math.max(0, amount - (used.get(key) ?? 0))) };
  }).sort(compareResource);
  const selected = new Set(allocations.map((row) => row.routeId));
  for (const candidate of prepared) {
    if (!selected.has(candidate.routeId)) rejections.push({ routeId: candidate.routeId, code: "not-selected", message: "A higher-value feasible portfolio was selected within the configured constraints" });
  }
  rejections.sort((left, right) => left.routeId.localeCompare(right.routeId) || left.code.localeCompare(right.code));
  const upperBoundNetProfit = truncated ? rootUpperBound : bestProfit;

  return {
    modelVersion: "capital-allocation-v1",
    profitMode: request.profitMode,
    optimal: !truncated,
    truncated,
    visitedNodes,
    netProfit: cleanNumber(bestProfit),
    upperBoundNetProfit: cleanNumber(upperBoundNetProfit),
    absoluteOptimalityGap: cleanNumber(Math.max(0, upperBoundNetProfit - bestProfit)),
    allocations,
    unusedCapital,
    familyRiskCapital: familyTotals(allocations),
    rejections
  };
}

function validateRequest(request: CapitalAllocationRequest) {
  if (request.modelVersion !== "capital-allocation-v1") throw new Error("Unsupported capital allocation model version");
  if (!Number.isSafeInteger(request.maximumOpenRoutes) || request.maximumOpenRoutes < 0 || request.maximumOpenRoutes > MAX_CANDIDATES) throw new Error("maximumOpenRoutes is outside the bounded range");
  if (!Number.isSafeInteger(request.maximumSearchNodes) || request.maximumSearchNodes < 1 || request.maximumSearchNodes > MAX_SEARCH_NODES) throw new Error("maximumSearchNodes is outside the bounded range");
  if (request.candidates.length > MAX_CANDIDATES) throw new Error(`At most ${MAX_CANDIDATES} allocation candidates are allowed`);
  const routes = new Set<string>();
  for (const row of request.candidates) {
    if (!row.routeId.trim() || !row.family.trim() || !row.unitLabel.trim() || routes.has(row.routeId)) throw new Error("Allocation candidates require unique route, family and unit identities");
    routes.add(row.routeId);
    if (![row.minimumUnits, row.maximumUnits].every(Number.isSafeInteger) || row.minimumUnits < 1 || row.maximumUnits < row.minimumUnits || row.maximumUnits > MAX_UNITS_PER_CANDIDATE) throw new Error(`Candidate ${row.routeId} has invalid unit limits`);
    if (![row.conservativeNetProfitPerUnit, row.projectedNetProfitPerUnit].every(Number.isFinite) || !Number.isFinite(row.riskCapitalPerUnit) || row.riskCapitalPerUnit <= 0 || row.capitalPerUnit.length === 0) throw new Error(`Candidate ${row.routeId} has invalid profit or capital values`);
  }
  resourceMap(request.budgets, "budget");
  const families = new Set<string>();
  for (const row of request.familyLimits ?? []) {
    if (!row.family.trim() || families.has(row.family) || !Number.isFinite(row.maximumRiskCapital) || row.maximumRiskCapital < 0) throw new Error("Family limits require unique identities and non-negative values");
    families.add(row.family);
  }
}

function preflightCandidate(candidate: CapitalAllocationCandidate, mode: CapitalAllocationRequest["profitMode"], budgets: Map<string, number>, allowed: Set<CapitalAllocationCandidate["outcomeClass"]>): AllocationRejection | undefined {
  if (!candidate.eligible) return { routeId: candidate.routeId, code: "ineligible", message: "The route economics evaluation is not eligible" };
  if (!allowed.has(candidate.outcomeClass)) return { routeId: candidate.routeId, code: "outcome-class-disabled", message: `Outcome class ${candidate.outcomeClass} is disabled by policy` };
  const profit = mode === "conservative" ? candidate.conservativeNetProfitPerUnit : candidate.projectedNetProfitPerUnit;
  if (profit <= 0) return { routeId: candidate.routeId, code: "non-positive-profit", message: "Net profit per unit is not positive in the selected mode" };
  const resources = resourceMap(candidate.capitalPerUnit, `candidate ${candidate.routeId}`);
  for (const key of resources.keys()) {
    if (!budgets.has(key)) return { routeId: candidate.routeId, code: "missing-capital-budget", message: `No capital budget exists for ${printResourceKey(key)}` };
  }
  const maximumFromCapital = [...resources].reduce((limit, [key, amount]) => Math.min(limit, Math.floor(((budgets.get(key) ?? 0) + EPSILON) / amount)), candidate.maximumUnits);
  if (maximumFromCapital < candidate.minimumUnits) return { routeId: candidate.routeId, code: "below-minimum-size", message: "Available capital cannot satisfy the route minimum allocation" };
  return undefined;
}

function feasibleMaximumUnits(candidate: PreparedCandidate, state: SearchState, familyLimits: Map<string, number>, maximumOpenRoutes: number): number {
  if (state.openRoutes >= maximumOpenRoutes) return 0;
  let maximum = candidate.maximumUnits;
  for (const [key, amount] of candidate.resources) maximum = Math.min(maximum, Math.floor(((state.remaining.get(key) ?? 0) + EPSILON) / amount));
  const familyLimit = familyLimits.get(candidate.family);
  if (familyLimit !== undefined) maximum = Math.min(maximum, Math.floor((familyLimit - (state.familyUsed.get(candidate.family) ?? 0) + EPSILON) / candidate.riskCapitalPerUnit));
  return Math.max(0, maximum);
}

function unitChoices(candidate: PreparedCandidate, maximum: number): number[] {
  const values: number[] = [];
  if (maximum >= candidate.minimumUnits) {
    for (let units = maximum; units >= candidate.minimumUnits; units -= 1) values.push(units);
  }
  values.push(0);
  return values;
}

function applyUnits(state: SearchState, candidate: PreparedCandidate, units: number): SearchState {
  const next: SearchState = {
    index: state.index,
    profit: state.profit + candidate.profitPerUnit * units,
    openRoutes: state.openRoutes + (units > 0 ? 1 : 0),
    remaining: new Map(state.remaining),
    familyUsed: new Map(state.familyUsed),
    units: [...state.units, units]
  };
  if (units === 0) return next;
  for (const [key, amount] of candidate.resources) next.remaining.set(key, (next.remaining.get(key) ?? 0) - amount * units);
  next.familyUsed.set(candidate.family, (next.familyUsed.get(candidate.family) ?? 0) + candidate.riskCapitalPerUnit * units);
  return next;
}

function materializeAllocations(candidates: PreparedCandidate[], units: number[]): CapitalAllocation[] {
  return candidates.flatMap((candidate, index) => {
    const count = units[index] ?? 0;
    if (count === 0) return [];
    return [{
      routeId: candidate.routeId,
      family: candidate.family,
      outcomeClass: candidate.outcomeClass,
      unitLabel: candidate.unitLabel,
      units: count,
      riskCapital: cleanNumber(candidate.riskCapitalPerUnit * count),
      netProfit: cleanNumber(candidate.profitPerUnit * count),
      requiredCapital: [...candidate.resources].map(([key, amount]) => {
        const [venue = "", asset = ""] = splitResourceKey(key);
        return { venue, asset, amount: cleanNumber(amount * count) };
      }).sort(compareResource)
    }];
  }).sort((left, right) => left.routeId.localeCompare(right.routeId));
}

function resourceMap(resources: readonly CapitalResource[], label: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of resources) {
    if (!row.venue.trim() || !row.asset.trim() || !Number.isFinite(row.amount) || row.amount <= 0) throw new Error(`${label} resources require venue, asset and positive amount`);
    const key = resourceKey(row.venue, row.asset);
    result.set(key, (result.get(key) ?? 0) + row.amount);
  }
  if (result.size === 0) throw new Error(`${label} requires at least one resource`);
  return result;
}

function candidateScore(candidate: PreparedCandidate, budgets: Map<string, number>): number {
  const dominantShare = [...candidate.resources].reduce((maximum, [key, amount]) => Math.max(maximum, amount / (budgets.get(key) ?? amount)), 0);
  return candidate.profitPerUnit / Math.max(dominantShare, EPSILON);
}

function suffixProfitBounds(candidates: readonly PreparedCandidate[]): number[] {
  const bounds = new Array(candidates.length + 1).fill(0) as number[];
  for (let index = candidates.length - 1; index >= 0; index -= 1) bounds[index] = bounds[index + 1]! + candidates[index]!.profitPerUnit * candidates[index]!.maximumUnits;
  return bounds;
}

function aggregateResources(resources: readonly CapitalResource[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of resources) result.set(resourceKey(row.venue, row.asset), (result.get(resourceKey(row.venue, row.asset)) ?? 0) + row.amount);
  return result;
}

function familyTotals(allocations: readonly CapitalAllocation[]) {
  const totals = new Map<string, number>();
  for (const row of allocations) totals.set(row.family, (totals.get(row.family) ?? 0) + row.riskCapital);
  return [...totals].map(([family, amount]) => ({ family, amount: cleanNumber(amount) })).sort((left, right) => left.family.localeCompare(right.family));
}

function lexicographicallySmaller(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

function resourceKey(venue: string, asset: string) {
  return `${venue}\u0000${asset}`;
}

function splitResourceKey(key: string) {
  return key.split("\u0000");
}

function printResourceKey(key: string) {
  return splitResourceKey(key).join(":");
}

function compareResource(left: CapitalResource, right: CapitalResource) {
  return left.venue.localeCompare(right.venue) || left.asset.localeCompare(right.asset);
}

function cleanNumber(value: number) {
  return Object.is(value, -0) ? 0 : value;
}
