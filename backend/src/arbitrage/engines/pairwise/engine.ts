import { evaluatePairwiseRoute, validatePairwiseInstrument } from "./evaluate.js";
import type { PairwiseBookSnapshot, PairwiseEngineOptions, PairwiseEvaluationOptions, PairwiseInstrument, PairwiseOpportunity, PairwiseRoute, PairwiseUpdateResult } from "./types.js";

const DEFAULT_MAX_QUOTE_AGE_MS = 2_000;
const DEFAULT_MAX_LEG_SKEW_MS = 250;
const DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS = 1_000;
const DEFAULT_MAX_ASSUMPTION_AGE_MS = 86_400_000;
const DEFAULT_MAX_ECONOMIC_IDENTITY_AGE_MS = 30 * 86_400_000;
const DEFAULT_MAX_RESIDUAL_DELTA_BPS = 1;
const DEFAULT_PAIRING_ITERATIONS = 20;

/** Incremental, transport-free pair scanner over caller-supplied public books. */
export class PairwiseArbitrageEngine {
  private readonly instruments = new Map<string, PairwiseInstrument>();
  private readonly routes: PairwiseRoute[];
  private readonly routesByInstrument = new Map<string, PairwiseRoute[]>();
  private readonly books = new Map<string, PairwiseBookSnapshot>();
  private readonly active = new Map<string, PairwiseOpportunity>();
  private readonly now: () => number;
  private readonly evaluation: Omit<PairwiseEvaluationOptions, "evaluatedAt">;

  constructor(instruments: readonly PairwiseInstrument[], routes: readonly PairwiseRoute[], options: PairwiseEngineOptions = {}) {
    for (const value of instruments) {
      const problem = validatePairwiseInstrument(value);
      if (problem) throw new Error(`Invalid pairwise instrument ${value.instrumentId || "<missing>"}: ${problem}`);
      if (this.instruments.has(value.instrumentId)) throw new Error(`Duplicate pairwise instrument ${value.instrumentId}`);
      this.instruments.set(value.instrumentId, structuredClone(value));
    }
    const routeIds = new Set<string>();
    this.routes = [...routes].map((value) => structuredClone(value)).sort((left, right) => left.routeId.localeCompare(right.routeId));
    for (const route of this.routes) {
      if (!route.routeId?.trim() || routeIds.has(route.routeId)) throw new Error(`Duplicate or empty pairwise route ${route.routeId || "<missing>"}`);
      routeIds.add(route.routeId);
      if (!this.instruments.has(route.longInstrumentId) || !this.instruments.has(route.shortInstrumentId)) {
        throw new Error(`Pairwise route ${route.routeId} references unknown instrument metadata`);
      }
      this.indexRoute(route.longInstrumentId, route);
      this.indexRoute(route.shortInstrumentId, route);
    }
    this.now = options.now ?? Date.now;
    this.evaluation = {
      minNetReturnBps: finiteOr(options.minNetReturnBps, 0),
      maxQuoteAgeMs: positiveOr(options.maxQuoteAgeMs, DEFAULT_MAX_QUOTE_AGE_MS),
      maxLegSkewMs: positiveOr(options.maxLegSkewMs, DEFAULT_MAX_LEG_SKEW_MS),
      maxFutureClockSkewMs: positiveOr(options.maxFutureClockSkewMs, DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS),
      maxAssumptionAgeMs: positiveOr(options.maxAssumptionAgeMs, DEFAULT_MAX_ASSUMPTION_AGE_MS),
      maxEconomicIdentityAgeMs: positiveOr(options.maxEconomicIdentityAgeMs, DEFAULT_MAX_ECONOMIC_IDENTITY_AGE_MS),
      maxResidualDeltaBps: nonNegativeOr(options.maxResidualDeltaBps, DEFAULT_MAX_RESIDUAL_DELTA_BPS),
      pairingIterations: Math.max(4, Math.min(64, Math.floor(positiveOr(options.pairingIterations, DEFAULT_PAIRING_ITERATIONS))))
    };
  }

  configuredRoutes(): PairwiseRoute[] {
    return structuredClone(this.routes);
  }

  affectedRoutes(instrumentId: string): PairwiseRoute[] {
    return structuredClone(this.routesByInstrument.get(instrumentId) ?? []);
  }

  updateBook(update: PairwiseBookSnapshot): PairwiseUpdateResult {
    const instrumentId = String(update.instrumentId ?? "").trim();
    if (!this.instruments.has(instrumentId)) {
      return {
        instrumentId,
        evaluatedRouteIds: [],
        upserted: [],
        removedOpportunityIds: [],
        rejections: [{ instrumentId, code: "unknown-instrument", message: "Book instrument is absent from pairwise metadata" }]
      };
    }
    this.books.set(instrumentId, cloneBook({ ...update, instrumentId }));
    const evaluatedAt = this.now();
    const routes = this.routesByInstrument.get(instrumentId) ?? [];
    const upserted: PairwiseOpportunity[] = [];
    const removedOpportunityIds: string[] = [];
    const rejections: PairwiseUpdateResult["rejections"] = [];
    for (const route of routes) {
      const result = evaluatePairwiseRoute(route, this.instruments, this.books, { ...this.evaluation, evaluatedAt });
      const id = `pairwise:${route.routeId}`;
      if (result.opportunity) {
        this.active.set(id, result.opportunity);
        upserted.push(result.opportunity);
      } else {
        rejections.push(result.rejection);
        if (this.active.delete(id)) removedOpportunityIds.push(id);
      }
    }
    upserted.sort(pairwiseOpportunityOrder);
    removedOpportunityIds.sort();
    rejections.sort((left, right) => (left.routeId ?? "").localeCompare(right.routeId ?? "") || left.code.localeCompare(right.code));
    return { instrumentId, evaluatedRouteIds: routes.map((route) => route.routeId), upserted, removedOpportunityIds, rejections };
  }

  opportunities(): PairwiseOpportunity[] {
    const now = this.now();
    return [...this.active.values()]
      .filter((value) => {
        const timestamps = value.timestamps;
        const booksFresh = Math.max(now - timestamps.oldestExchangeTs, now - timestamps.oldestReceivedAt) <= this.evaluation.maxQuoteAgeMs;
        const assumptionsFresh = now - timestamps.oldestAssumptionAsOf <= this.evaluation.maxAssumptionAgeMs;
        const identityValid = value.provenance.economicIdentity.legs.every((identity) => now <= identity.effectiveValidUntil);
        const horizonOpen = timestamps.horizonExitAt === undefined || now < timestamps.horizonExitAt;
        return booksFresh && assumptionsFresh && identityValid && horizonOpen;
      })
      .sort(pairwiseOpportunityOrder);
  }

  private indexRoute(instrumentId: string, route: PairwiseRoute): void {
    const indexed = this.routesByInstrument.get(instrumentId) ?? [];
    indexed.push(route);
    indexed.sort((left, right) => left.routeId.localeCompare(right.routeId));
    this.routesByInstrument.set(instrumentId, indexed);
  }
}

export function pairwiseOpportunityOrder(left: PairwiseOpportunity, right: PairwiseOpportunity): number {
  return right.netReturnBps - left.netReturnBps || right.netExpectedPnlQuote - left.netExpectedPnlQuote || right.executableBaseQuantity - left.executableBaseQuantity || left.id.localeCompare(right.id);
}

function cloneBook(book: PairwiseBookSnapshot): PairwiseBookSnapshot {
  return {
    ...book,
    bids: book.bids.map(([price, quantity]) => [price, quantity] as const),
    asks: book.asks.map(([price, quantity]) => [price, quantity] as const)
  };
}

function finiteOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
