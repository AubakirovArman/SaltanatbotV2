import { affordablePairwiseBaseQuantity, pairwiseTolerance, planPairwiseLeg, type PairwisePlanFailure } from "./quantity.js";
import type { PairwiseBookSnapshot, PairwiseDeliveryAssumption, PairwiseEvaluationOptions, PairwiseFundingAssumption, PairwiseInstrument, PairwiseLegSimulation, PairwiseOpportunity, PairwiseProvenance, PairwiseRejection, PairwiseRiskFlag, PairwiseRoute, PairwiseTimestamps } from "./types.js";

const DAY_MS = 86_400_000;
const RETURN_EPSILON_BPS = 1e-7;
const ECONOMIC_ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/;

export type PairwiseEvaluationResult = { opportunity: PairwiseOpportunity; rejection?: never } | { opportunity?: never; rejection: PairwiseRejection };

/** Pure two-leg research simulation. It performs no transport or account access. */
export function evaluatePairwiseRoute(route: PairwiseRoute, instruments: ReadonlyMap<string, PairwiseInstrument>, books: ReadonlyMap<string, PairwiseBookSnapshot>, options: PairwiseEvaluationOptions): PairwiseEvaluationResult {
  const long = instruments.get(route.longInstrumentId);
  const short = instruments.get(route.shortInstrumentId);
  if (!long) return rejected(route, "unknown-instrument", "Long instrument metadata is missing", route.longInstrumentId);
  if (!short) return rejected(route, "unknown-instrument", "Short instrument metadata is missing", route.shortInstrumentId);
  const routeProblem = validateRoute(route, long, short, options);
  if (routeProblem) return { rejection: routeProblem };

  const longBook = books.get(long.instrumentId);
  const shortBook = books.get(short.instrumentId);
  if (!longBook) return rejected(route, "missing-book", "Long instrument book is missing", long.instrumentId);
  if (!shortBook) return rejected(route, "missing-book", "Short instrument book is missing", short.instrumentId);
  const quality = validateDataQuality(route, long, short, longBook, shortBook, options);
  if ("rejection" in quality) return quality;

  const shortLimit = shortResourceLimit(route);
  const inventoryTarget = Math.min(route.requestedBaseQuantity, shortLimit ?? route.requestedBaseQuantity);
  const capitalTarget = affordableLongTarget(route, long, longBook, inventoryTarget);
  let target = capitalTarget ?? inventoryTarget;
  const inventoryLimited = shortLimit !== undefined && shortLimit + pairwiseTolerance(route.requestedBaseQuantity) < route.requestedBaseQuantity;
  const capitalLimited = capitalTarget !== undefined && capitalTarget + pairwiseTolerance(inventoryTarget) < inventoryTarget;
  let capacityTarget = target;
  let longLeg: PairwiseLegSimulation | undefined;
  let shortLeg: PairwiseLegSimulation | undefined;
  let depthLimited = false;
  for (let iteration = 0; iteration < options.pairingIterations; iteration += 1) {
    const plannedLong = planPairwiseLeg("long", long, longBook, target);
    if ("failure" in plannedLong) return planRejected(route, plannedLong.failure);
    const plannedShort = planPairwiseLeg("short", short, shortBook, target);
    if ("failure" in plannedShort) return planRejected(route, plannedShort.failure);
    longLeg = plannedLong.leg;
    shortLeg = plannedShort.leg;
    depthLimited ||= longLeg.depthLimited || shortLeg.depthLimited;
    if (longLeg.depthLimited) capacityTarget = Math.min(capacityTarget, longLeg.baseEquivalentQuantity);
    if (shortLeg.depthLimited) capacityTarget = Math.min(capacityTarget, shortLeg.baseEquivalentQuantity);
    const paired = Math.min(longLeg.baseEquivalentQuantity, shortLeg.baseEquivalentQuantity);
    const residual = Math.abs(longLeg.baseEquivalentQuantity - shortLeg.baseEquivalentQuantity);
    if (residualBps(residual, paired) <= options.maxResidualDeltaBps) break;
    if (!(paired > 0) || paired >= target - pairwiseTolerance(target)) break;
    target = paired;
  }
  if (!longLeg || !shortLeg) return rejected(route, "insufficient-depth", "Unable to construct both legs");

  const executableBaseQuantity = Math.min(longLeg.baseEquivalentQuantity, shortLeg.baseEquivalentQuantity);
  const residualBaseQuantity = longLeg.baseEquivalentQuantity - shortLeg.baseEquivalentQuantity;
  const residual = residualBps(Math.abs(residualBaseQuantity), executableBaseQuantity);
  if (residual > options.maxResidualDeltaBps) {
    return rejected(route, "residual-delta", `Base-equivalent leg mismatch is ${residual.toFixed(8)} bps`);
  }

  const referenceNotionalQuote = (longLeg.quoteNotional + shortLeg.quoteNotional) / 2;
  if (!(referenceNotionalQuote > 0)) return rejected(route, "minimum-notional", "Reference notional is zero");
  const grossEntryPnlQuote = shortLeg.quoteNotional - longLeg.quoteNotional;
  const expectedExitBasisBps = route.strategyKind === "spot-spot" ? 0 : route.convergence.expectedExitBasisBps;
  const grossExpectedPnlQuote = grossEntryPnlQuote - (referenceNotionalQuote * expectedExitBasisBps) / 10_000;
  const entryFeesQuote = longLeg.entryFeeQuote + shortLeg.entryFeeQuote;
  const exitFeesQuote = route.strategyKind === "spot-spot" ? 0 : (referenceNotionalQuote * (route.convergence.longExitFeeBps + route.convergence.shortExitFeeBps)) / 10_000;
  const borrowCostQuote = borrowCost(route, shortLeg.quoteNotional, options.evaluatedAt);
  const fundingNetQuote = fundingNet(route, longLeg, shortLeg);
  const deliveryFeesQuote = hasDelivery(route) ? (referenceNotionalQuote * route.delivery.deliveryFeeBps) / 10_000 : 0;
  const rebalanceCostQuote = route.strategyKind === "spot-spot" ? (referenceNotionalQuote * route.rebalance.costBps) / 10_000 : 0;
  const netExpectedPnlQuote = grossExpectedPnlQuote - entryFeesQuote - exitFeesQuote - borrowCostQuote - deliveryFeesQuote - rebalanceCostQuote + fundingNetQuote;
  const entryBasisBps = (grossEntryPnlQuote / referenceNotionalQuote) * 10_000;
  const netReturnBps = (netExpectedPnlQuote / referenceNotionalQuote) * 10_000;
  if (!(netReturnBps > options.minNetReturnBps + RETURN_EPSILON_BPS)) {
    return rejected(route, "non-profitable", `Net edge ${netReturnBps.toFixed(8)} bps does not exceed ${options.minNetReturnBps.toFixed(8)} bps`);
  }

  const unfilledBaseQuantity = Math.max(0, route.requestedBaseQuantity - executableBaseQuantity);
  const capacityShortfallBaseQuantity = Math.max(0, route.requestedBaseQuantity - capacityTarget);
  const baseDustQuantity = Math.max(0, capacityTarget - executableBaseQuantity);
  const riskFlags = buildRiskFlags(route, long, short, longBook, shortBook, longLeg, shortLeg, {
    baseDustQuantity,
    residualBaseQuantity,
    depthLimited,
    capitalLimited,
    inventoryLimited
  });
  return {
    opportunity: {
      id: `pairwise:${route.routeId}`,
      strategyKind: route.strategyKind,
      edgeKind: "research-simulation",
      executable: false,
      routeId: route.routeId,
      baseAsset: long.baseAsset,
      economicAssetId: long.economicAssetId,
      quoteAsset: long.quoteAsset,
      requestedBaseQuantity: route.requestedBaseQuantity,
      executableBaseQuantity,
      longBaseQuantity: longLeg.baseEquivalentQuantity,
      shortBaseQuantity: shortLeg.baseEquivalentQuantity,
      residualBaseQuantity,
      unfilledBaseQuantity,
      capacityShortfallBaseQuantity,
      baseDustQuantity,
      grossEntryPnlQuote,
      grossExpectedPnlQuote,
      netExpectedPnlQuote,
      entryBasisBps,
      expectedExitBasisBps,
      netReturnBps,
      referenceNotionalQuote,
      legs: [longLeg, shortLeg],
      costs: { entryFeesQuote, exitFeesQuote, borrowCostQuote, fundingNetQuote, deliveryFeesQuote, rebalanceCostQuote },
      timestamps: quality.timestamps,
      provenance: provenance(route, long, short, longBook, shortBook, options),
      riskFlags
    }
  };
}

export function validatePairwiseBook(book: PairwiseBookSnapshot, instrument: PairwiseInstrument, now: number, maxFutureClockSkewMs: number): string | undefined {
  if (!book.complete) return "book is not a complete, sequence-verified snapshot";
  if (book.instrumentId !== instrument.instrumentId || book.quantityUnit !== instrument.quantityModel.unit) {
    return "book identity or native quantity unit does not match instrument metadata";
  }
  if (!book.sourceId?.trim()) return "book sourceId is required";
  if (book.source === "websocket" && (!Number.isSafeInteger(book.sequence) || (book.sequence ?? 0) <= 0)) {
    return "complete websocket books require a positive sequence";
  }
  if (!positiveTimestamp(book.exchangeTs) || !positiveTimestamp(book.receivedAt)) return "book timestamps must be positive integers";
  if (book.exchangeTs > now + maxFutureClockSkewMs || book.receivedAt > now + maxFutureClockSkewMs) {
    return "book timestamp exceeds the future-clock safety boundary";
  }
  if (levelsProblem(book.bids, "bids") || levelsProblem(book.asks, "asks")) return "book levels are missing, invalid or not strictly sorted";
  if (book.bids[0]![0] >= book.asks[0]![0]) return "book is crossed or locked";
  return undefined;
}

export function validatePairwiseInstrument(instrument: PairwiseInstrument): string | undefined {
  if (!instrument.instrumentId?.trim() || !instrument.venue?.trim() || !instrument.symbol?.trim()) return "instrument identity is incomplete";
  if (!instrument.baseAsset?.trim() || !instrument.quoteAsset?.trim() || !instrument.settleAsset?.trim()) return "instrument assets are incomplete";
  const identityProblem = economicIdentityStaticProblem(instrument);
  if (identityProblem) return identityProblem;
  if (!positive(instrument.quantityStep) || !positive(instrument.minimumQuantity) || !positive(instrument.minimumNotional)) return "quantity and notional filters must be positive";
  if (!Number.isFinite(instrument.takerFeeBps) || instrument.takerFeeBps < 0 || instrument.takerFeeBps >= 10_000) return "taker fee is invalid";
  if (instrument.quantityModel.unit === "contract" && !positive(instrument.quantityModel.contractMultiplier)) return "contract multiplier must be positive";
  if (instrument.marketType === "spot" && instrument.quantityModel.unit === "contract") return "spot instruments cannot use contract quantities";
  if (instrument.marketType === "future" && !positiveTimestamp(instrument.expiryTime)) return "dated futures require expiryTime";
  return undefined;
}

function validateRoute(route: PairwiseRoute, long: PairwiseInstrument, short: PairwiseInstrument, options: PairwiseEvaluationOptions): PairwiseRejection | undefined {
  const longIdentityProblem = economicIdentityProblem(long, options);
  if (longIdentityProblem) return economicIdentityRejected(route, long, longIdentityProblem);
  const shortIdentityProblem = economicIdentityProblem(short, options);
  if (shortIdentityProblem) return economicIdentityRejected(route, short, shortIdentityProblem);
  if (long.economicAssetId !== short.economicAssetId) {
    return {
      routeId: route.routeId,
      code: "economic-identity-mismatch",
      message: "Legs must have an exact canonical economicAssetId match; ticker equality is not identity proof"
    };
  }
  const longProblem = validatePairwiseInstrument(long);
  if (longProblem) return { routeId: route.routeId, instrumentId: long.instrumentId, code: "invalid-route", message: longProblem };
  const shortProblem = validatePairwiseInstrument(short);
  if (shortProblem) return { routeId: route.routeId, instrumentId: short.instrumentId, code: "invalid-route", message: shortProblem };
  if (!route.routeId?.trim() || route.longInstrumentId === route.shortInstrumentId || !positive(route.requestedBaseQuantity)) {
    return { routeId: route.routeId, code: "invalid-route", message: "Route identity, distinct legs and positive requested base quantity are required" };
  }
  if (long.baseAsset !== short.baseAsset || long.quoteAsset !== short.quoteAsset) {
    return { routeId: route.routeId, code: "invalid-route", message: "Legs must share canonical base and quote assets; no implicit cross-asset FX conversion is performed" };
  }
  if (long.settleAsset !== short.settleAsset || long.settleAsset !== long.quoteAsset || short.settleAsset !== short.quoteAsset) {
    return {
      routeId: route.routeId,
      code: "settlement-conversion-required",
      message: "Both legs must settle in their shared quote asset unless an explicit point-in-time FX and settlement conversion model is provided"
    };
  }
  const quoteValuedContract = [long, short].find((instrument) => instrument.quantityModel.unit === "contract" && instrument.quantityModel.multiplierAsset === "quote");
  if (quoteValuedContract) {
    return {
      routeId: route.routeId,
      instrumentId: quoteValuedContract.instrumentId,
      code: "settlement-conversion-required",
      message: "Inverse or quote-valued contracts require an explicit point-in-time FX, collateral and settlement conversion model"
    };
  }

  if (route.strategyKind === "spot-spot") {
    if (long.marketType !== "spot" || short.marketType !== "spot" || long.venue === short.venue) return invalidKind(route, "spot-spot requires spot legs on different venues");
    const capitalProblem = capitalAssumptionProblem(route, route.longCapital, options);
    if (capitalProblem) return capitalProblem;
    if (!validInventory(route.shortAccess)) return missing(route, "Spot sell inventory must be explicitly verified and positive");
    const inventoryProblem = constAssumptionProblem(route.shortAccess, options);
    if (inventoryProblem) return assumptionRejected(route, route.shortAccess, options);
    if (constAssumptionProblem(route.rebalance, options)) return assumptionRejected(route, route.rebalance, options);
    if (!nonNegative(route.rebalance.costBps)) return missing(route, "Rebalance cost must be explicitly non-negative");
    return undefined;
  }

  const convergenceProblem = convergenceAssumptionProblem(route.convergence, options);
  if (convergenceProblem) return { routeId: route.routeId, ...convergenceProblem };
  if (route.strategyKind === "perpetual-perpetual") {
    if (long.marketType !== "perpetual" || short.marketType !== "perpetual" || long.venue === short.venue) return invalidKind(route, "perpetual-perpetual requires perpetual legs on different venues");
    return fundingProblem(route, [long.instrumentId, short.instrumentId], options);
  }
  if (route.strategyKind === "reverse-cash-and-carry") {
    if (long.marketType !== "perpetual" || short.marketType !== "spot") return invalidKind(route, "reverse cash-and-carry requires long perpetual and short spot");
    const borrowProblem = borrowAssumptionProblem(route, options);
    if (borrowProblem) return borrowProblem;
    return fundingProblem(route, [long.instrumentId], options);
  }
  if (route.strategyKind === "spot-dated-future") {
    if (long.marketType !== "spot" || short.marketType !== "future") return invalidKind(route, "spot-dated-future requires long spot and short dated future");
    const capitalProblem = capitalAssumptionProblem(route, route.longCapital, options);
    if (capitalProblem) return capitalProblem;
    return deliveryProblem(route, long, short, options);
  }
  if (route.strategyKind === "perpetual-future") {
    if (!((long.marketType === "perpetual" && short.marketType === "future") || (long.marketType === "future" && short.marketType === "perpetual"))) {
      return invalidKind(route, "perpetual-future requires exactly one perpetual and one dated future");
    }
    const perpetual = long.marketType === "perpetual" ? long : short;
    const funding = fundingProblem(route, [perpetual.instrumentId], options);
    return funding ?? deliveryProblem(route, long, short, options);
  }
  if (long.marketType !== "future" || short.marketType !== "future") return invalidKind(route, "dated-futures routes require two dated futures");
  if (route.strategyKind === "dated-futures-spread") {
    if (long.venue === short.venue || long.expiryTime !== short.expiryTime) return invalidKind(route, "dated-futures spread requires the same expiry on different venues");
  }
  return deliveryProblem(route, long, short, options);
}

function validateDataQuality(route: PairwiseRoute, long: PairwiseInstrument, short: PairwiseInstrument, longBook: PairwiseBookSnapshot, shortBook: PairwiseBookSnapshot, options: PairwiseEvaluationOptions): { timestamps: PairwiseTimestamps } | { rejection: PairwiseRejection } {
  for (const [instrument, book] of [
    [long, longBook],
    [short, shortBook]
  ] as const) {
    const problem = validatePairwiseBook(book, instrument, options.evaluatedAt, options.maxFutureClockSkewMs);
    if (problem) return rejected(route, book.complete ? "invalid-book" : "incomplete-book", problem, instrument.instrumentId);
  }
  const exchangeTimes = [longBook.exchangeTs, shortBook.exchangeTs];
  const receivedTimes = [longBook.receivedAt, shortBook.receivedAt];
  const oldestExchangeTs = Math.min(...exchangeTimes);
  const newestExchangeTs = Math.max(...exchangeTimes);
  const oldestReceivedAt = Math.min(...receivedTimes);
  const newestReceivedAt = Math.max(...receivedTimes);
  const quoteAgeMs = Math.max(0, options.evaluatedAt - oldestExchangeTs, options.evaluatedAt - oldestReceivedAt);
  const legSkewMs = Math.max(newestExchangeTs - oldestExchangeTs, newestReceivedAt - oldestReceivedAt);
  if (quoteAgeMs > options.maxQuoteAgeMs) return rejected(route, "stale-book", `Oldest leg is ${quoteAgeMs} ms old`);
  if (legSkewMs > options.maxLegSkewMs) return rejected(route, "skewed-books", `Leg timestamp skew is ${legSkewMs} ms`);
  const oldestAssumptionAsOf = Math.min(...assumptions(route).map((value) => value.asOf));
  return {
    timestamps: {
      evaluatedAt: options.evaluatedAt,
      oldestExchangeTs,
      newestExchangeTs,
      oldestReceivedAt,
      newestReceivedAt,
      quoteAgeMs,
      legSkewMs,
      oldestAssumptionAsOf,
      assumptionAgeMs: Math.max(0, options.evaluatedAt - oldestAssumptionAsOf),
      ...(route.strategyKind === "spot-spot" ? {} : { horizonExitAt: route.convergence.exitAt })
    }
  };
}

function convergenceAssumptionProblem(value: { source: string; asOf: number; exitAt: number; expectedExitBasisBps: number; longExitFeeBps: number; shortExitFeeBps: number }, options: PairwiseEvaluationOptions): Pick<PairwiseRejection, "code" | "message"> | undefined {
  if (!value || !value.source?.trim() || !positiveTimestamp(value.exitAt) || value.exitAt <= options.evaluatedAt) return { code: "missing-assumption", message: "A future convergence exit is required" };
  if (!Number.isFinite(value.expectedExitBasisBps) || !nonNegative(value.longExitFeeBps) || !nonNegative(value.shortExitFeeBps)) return { code: "missing-assumption", message: "Exit basis and both exit fees must be explicit" };
  const problem = constAssumptionProblem(value, options);
  return problem ? { code: "stale-assumption", message: problem } : undefined;
}

function fundingProblem(route: Extract<PairwiseRoute, { strategyKind: "perpetual-perpetual" | "reverse-cash-and-carry" | "perpetual-future" }>, ids: string[], options: PairwiseEvaluationOptions): PairwiseRejection | undefined {
  if (!Array.isArray(route.funding)) return missing(route, "Funding assumptions are required");
  const byId = new Map(route.funding.map((value) => [value.instrumentId, value]));
  if (byId.size !== route.funding.length || byId.size !== ids.length || ids.some((id) => !byId.has(id))) return missing(route, "Exactly one funding assumption is required for every perpetual leg");
  for (const id of ids) {
    const value = byId.get(id)!;
    if (value.scheduleVerified !== true || !Number.isFinite(value.cumulativeRateBps) || value.coversUntil < route.convergence.exitAt || (value.rateKind !== "venue-estimate" && value.rateKind !== "manual-stress")) return missing(route, `Funding assumption for ${id} is incomplete or does not cover the holding horizon`);
    const problem = constAssumptionProblem(value, options);
    if (problem) return { routeId: route.routeId, instrumentId: id, code: "stale-assumption", message: problem };
  }
  return undefined;
}

function borrowAssumptionProblem(route: Extract<PairwiseRoute, { strategyKind: "reverse-cash-and-carry" }>, options: PairwiseEvaluationOptions): PairwiseRejection | undefined {
  const value = route.borrow;
  if (!value || value.kind !== "borrow" || value.availabilityVerified !== true || !positive(value.availableBaseQuantity)) return { routeId: route.routeId, code: "borrow-unavailable", message: "Reverse carry requires explicitly verified positive spot borrow" };
  if (!nonNegative(value.annualRateBps) || value.coversUntil < route.convergence.exitAt) return missing(route, "Borrow rate and availability must cover the convergence horizon");
  const problem = constAssumptionProblem(value, options);
  return problem ? { routeId: route.routeId, code: "stale-assumption", message: problem } : undefined;
}

function deliveryProblem(route: Extract<PairwiseRoute, { strategyKind: "spot-dated-future" | "perpetual-future" | "calendar-spread" | "dated-futures-spread" }>, long: PairwiseInstrument, short: PairwiseInstrument, options: PairwiseEvaluationOptions): PairwiseRejection | undefined {
  const value = route.delivery;
  if (!value || value.exitAt !== route.convergence.exitAt || !nonNegative(value.deliveryFeeBps)) return missing(route, "Calendar delivery/close assumption must match the convergence exit");
  const problem = constAssumptionProblem(value, options);
  if (problem) return { routeId: route.routeId, code: "stale-assumption", message: problem };
  const expiries = [long.expiryTime, short.expiryTime].filter((value): value is number => value !== undefined);
  const firstExpiry = Math.min(...expiries);
  if (!Number.isFinite(firstExpiry)) return { routeId: route.routeId, code: "expiry-boundary", message: "Delivery routes require a dated-future expiry" };
  if (route.strategyKind === "calendar-spread" && long.expiryTime === short.expiryTime) return { routeId: route.routeId, code: "expiry-boundary", message: "Calendar legs require different expiries" };
  if (value.mode === "close-before-expiry") {
    if (value.exitAt >= firstExpiry) return { routeId: route.routeId, code: "expiry-boundary", message: "Close-before-expiry exit must precede both expiries" };
    return undefined;
  }
  if (route.strategyKind !== "calendar-spread") return { routeId: route.routeId, code: "expiry-boundary", message: "Spot/future, perpetual/future and same-expiry cross-venue spreads must close before delivery" };
  const near = long.expiryTime! < short.expiryTime! ? long : short;
  if (value.nearInstrumentId !== near.instrumentId || Math.abs(value.exitAt - near.expiryTime!) > 1_000 || !value.settlementPriceSource?.trim()) {
    return { routeId: route.routeId, code: "expiry-boundary", message: "Near settlement and far roll assumptions do not match instrument expiries" };
  }
  return undefined;
}

function constAssumptionProblem(value: { source: string; asOf: number }, options: PairwiseEvaluationOptions): string | undefined {
  if (!value?.source?.trim() || !positiveTimestamp(value.asOf)) return "Assumption source and timestamp are required";
  if (value.asOf > options.evaluatedAt + options.maxFutureClockSkewMs) return "Assumption timestamp exceeds the future-clock boundary";
  if (options.evaluatedAt - value.asOf > options.maxAssumptionAgeMs) return "Assumption is stale";
  return undefined;
}

function assumptions(route: PairwiseRoute): { kind: string; source: string; asOf: number }[] {
  if (route.strategyKind === "spot-spot") return [tag("capital", route.longCapital), tag("inventory", route.shortAccess), tag("rebalance", route.rebalance)];
  const values = [tag("convergence", route.convergence)];
  if (route.strategyKind === "spot-dated-future") values.push(tag("capital", route.longCapital));
  if (route.strategyKind === "reverse-cash-and-carry") values.push(tag("borrow", route.borrow));
  if (hasDelivery(route)) values.push(tag("delivery", route.delivery));
  if (hasFunding(route)) {
    values.push(...[...route.funding].sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)).map((value) => tag(`funding:${value.instrumentId}`, value)));
  }
  return values;
}

function provenance(route: PairwiseRoute, long: PairwiseInstrument, short: PairwiseInstrument, longBook: PairwiseBookSnapshot, shortBook: PairwiseBookSnapshot, options: PairwiseEvaluationOptions): PairwiseProvenance {
  return {
    engine: "pairwise-v1",
    routeId: route.routeId,
    metadataIds: [route.longInstrumentId, route.shortInstrumentId],
    economicIdentity: {
      economicAssetId: long.economicAssetId,
      matchPolicy: "exact",
      authority: "caller-supplied",
      maxAgeMs: options.maxEconomicIdentityAgeMs,
      maxFutureClockSkewMs: options.maxFutureClockSkewMs,
      legs: [identityProvenance(long, options), identityProvenance(short, options)]
    },
    books: [bookProvenance(longBook), bookProvenance(shortBook)],
    assumptions: assumptions(route)
  };
}

function bookProvenance(book: PairwiseBookSnapshot) {
  return {
    instrumentId: book.instrumentId,
    source: book.source,
    sourceId: book.sourceId,
    ...(book.sequence !== undefined ? { sequence: book.sequence } : {}),
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt
  };
}

function identityProvenance(instrument: PairwiseInstrument, options: PairwiseEvaluationOptions) {
  return {
    instrumentId: instrument.instrumentId,
    ...instrument.economicIdentity,
    effectiveValidUntil: Math.min(instrument.economicIdentity.validUntil, instrument.economicIdentity.asOf + options.maxEconomicIdentityAgeMs)
  };
}

function economicIdentityStaticProblem(instrument: PairwiseInstrument): string | undefined {
  if (!ECONOMIC_ASSET_ID.test(instrument.economicAssetId ?? "")) return "canonical economicAssetId must use the lowercase namespace:value format";
  const review = instrument.economicIdentity;
  if (!review || review.status !== "reviewed") return "canonical economic identity must have caller-supplied reviewed status";
  if (!review.source?.trim() || !review.version?.trim()) return "canonical economic identity source and version are required";
  if (!positiveTimestamp(review.asOf) || !positiveTimestamp(review.validUntil) || review.validUntil < review.asOf) {
    return "canonical economic identity requires a valid asOf-to-validUntil interval";
  }
  return undefined;
}

function economicIdentityProblem(instrument: PairwiseInstrument, options: PairwiseEvaluationOptions): string | undefined {
  const problem = economicIdentityStaticProblem(instrument);
  if (problem) return problem;
  const review = instrument.economicIdentity;
  if (review.asOf > options.evaluatedAt + options.maxFutureClockSkewMs) {
    return "canonical economic identity asOf exceeds the future-clock boundary";
  }
  if (options.evaluatedAt - review.asOf > options.maxEconomicIdentityAgeMs) {
    return "canonical economic identity review is stale";
  }
  if (review.validUntil < options.evaluatedAt) return "canonical economic identity review has expired";
  return undefined;
}

function economicIdentityRejected(route: PairwiseRoute, instrument: PairwiseInstrument, message: string): PairwiseRejection {
  return { routeId: route.routeId, instrumentId: instrument.instrumentId, code: "economic-identity-invalid", message };
}

function buildRiskFlags(
  route: PairwiseRoute,
  long: PairwiseInstrument,
  short: PairwiseInstrument,
  longBook: PairwiseBookSnapshot,
  shortBook: PairwiseBookSnapshot,
  longLeg: PairwiseLegSimulation,
  shortLeg: PairwiseLegSimulation,
  state: { baseDustQuantity: number; residualBaseQuantity: number; depthLimited: boolean; capitalLimited: boolean; inventoryLimited: boolean }
): PairwiseRiskFlag[] {
  const flags: PairwiseRiskFlag[] = ["simultaneous-execution-not-guaranteed", "caller-supplied-identity-review"];
  if (route.strategyKind === "spot-spot") flags.push("prefunded-quote-capital", "prefunded-spot-inventory", "cross-venue-rebalance");
  else flags.push("convergence-assumption");
  if (route.strategyKind === "spot-dated-future") flags.push("prefunded-quote-capital");
  if (route.strategyKind === "reverse-cash-and-carry") flags.push("explicit-borrow-assumption");
  if (hasDelivery(route)) flags.push("delivery-assumption");
  if (long.marketType !== "spot" || short.marketType !== "spot") flags.push("derivative-margin-not-modeled");
  if ([long, short].some((value) => value.quantityModel.unit === "quote" || (value.quantityModel.unit === "contract" && value.quantityModel.multiplierAsset === "quote"))) flags.push("inverse-or-quote-valued-contract");
  if (hasFunding(route)) {
    if (route.funding.some((value) => value.rateKind === "venue-estimate")) flags.push("funding-estimate");
    if (route.funding.some((value) => value.rateKind === "manual-stress")) flags.push("manual-funding-stress");
  }
  if (state.depthLimited) flags.push("depth-limited");
  if (state.capitalLimited) flags.push("capital-limited");
  if (state.inventoryLimited) flags.push("inventory-limited");
  if (state.baseDustQuantity > pairwiseTolerance(state.baseDustQuantity)) flags.push("rounding-dust");
  if (Math.abs(state.residualBaseQuantity) > pairwiseTolerance(Math.max(longLeg.baseEquivalentQuantity, shortLeg.baseEquivalentQuantity))) flags.push("residual-base-delta");
  if (longLeg.quoteNotional <= long.minimumNotional * 1.25 || shortLeg.quoteNotional <= short.minimumNotional * 1.25) flags.push("near-minimum-notional");
  if (longBook.bids.length === 1 || longBook.asks.length === 1 || shortBook.bids.length === 1 || shortBook.asks.length === 1) flags.push("top-book-only");
  if (longBook.source === "rest" || shortBook.source === "rest") flags.push("rest-snapshot");
  return flags;
}

function borrowCost(route: PairwiseRoute, shortNotional: number, evaluatedAt: number): number {
  if (route.strategyKind !== "reverse-cash-and-carry") return 0;
  const years = (route.convergence.exitAt - evaluatedAt) / (365 * DAY_MS);
  return (shortNotional * route.borrow.annualRateBps * years) / 10_000;
}

function fundingNet(route: PairwiseRoute, long: PairwiseLegSimulation, short: PairwiseLegSimulation): number {
  if (!hasFunding(route)) return 0;
  let net = 0;
  for (const value of route.funding) {
    if (value.instrumentId === long.instrumentId) net -= (long.quoteNotional * value.cumulativeRateBps) / 10_000;
    else if (value.instrumentId === short.instrumentId) net += (short.quoteNotional * value.cumulativeRateBps) / 10_000;
  }
  return net;
}

function shortResourceLimit(route: PairwiseRoute): number | undefined {
  if (route.strategyKind === "spot-spot") return route.shortAccess.availableBaseQuantity;
  if (route.strategyKind === "reverse-cash-and-carry") return route.borrow.availableBaseQuantity;
  return undefined;
}

function affordableLongTarget(route: PairwiseRoute, long: PairwiseInstrument, longBook: PairwiseBookSnapshot, requested: number): number | undefined {
  if (route.strategyKind !== "spot-spot" && route.strategyKind !== "spot-dated-future") return undefined;
  return affordablePairwiseBaseQuantity(long, longBook, requested, route.longCapital.availableQuoteQuantity);
}

function capitalAssumptionProblem(route: PairwiseRoute, value: import("./types.js").PairwiseCapitalAssumption | undefined, options: PairwiseEvaluationOptions): PairwiseRejection | undefined {
  if (!value || value.kind !== "capital" || value.availabilityVerified !== true || !positive(value.availableQuoteQuantity)) {
    return { routeId: route.routeId, code: "capital-unavailable", message: "Spot buy requires explicitly verified positive quote capital" };
  }
  const problem = constAssumptionProblem(value, options);
  return problem ? { routeId: route.routeId, code: "stale-assumption", message: problem } : undefined;
}

function hasFunding(route: PairwiseRoute): route is Extract<PairwiseRoute, { strategyKind: "perpetual-perpetual" | "reverse-cash-and-carry" | "perpetual-future" }> {
  return route.strategyKind === "perpetual-perpetual" || route.strategyKind === "reverse-cash-and-carry" || route.strategyKind === "perpetual-future";
}

function hasDelivery(route: PairwiseRoute): route is Extract<PairwiseRoute, { strategyKind: "spot-dated-future" | "perpetual-future" | "calendar-spread" | "dated-futures-spread" }> {
  return route.strategyKind === "spot-dated-future" || route.strategyKind === "perpetual-future" || route.strategyKind === "calendar-spread" || route.strategyKind === "dated-futures-spread";
}

function levelsProblem(levels: readonly (readonly [number, number])[], side: "bids" | "asks") {
  if (levels.length === 0) return true;
  let previous: number | undefined;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) return true;
    const [price, quantity] = level;
    if (!positive(price) || !positive(quantity)) return true;
    if (previous !== undefined && (side === "bids" ? price >= previous : price <= previous)) return true;
    previous = price;
  }
  return false;
}

function planRejected(route: PairwiseRoute, failure: PairwisePlanFailure): PairwiseEvaluationResult {
  return rejected(route, failure.code, failure.message, failure.instrumentId);
}

function residualBps(residual: number, base: number) {
  return base > 0 ? (residual / base) * 10_000 : Number.POSITIVE_INFINITY;
}

function validInventory(value: { availableBaseQuantity: number; availabilityVerified: true } | undefined) {
  return value?.availabilityVerified === true && positive(value.availableBaseQuantity);
}

function tag(kind: string, value: { source: string; asOf: number }) {
  return { kind, source: value.source, asOf: value.asOf };
}

function invalidKind(route: PairwiseRoute, message: string): PairwiseRejection {
  return { routeId: route.routeId, code: "invalid-route", message };
}

function missing(route: PairwiseRoute, message: string): PairwiseRejection {
  return { routeId: route.routeId, code: "missing-assumption", message };
}

function assumptionRejected(route: PairwiseRoute, value: { source: string; asOf: number }, options: PairwiseEvaluationOptions): PairwiseRejection {
  const problem = constAssumptionProblem(value, options) ?? "Assumption is invalid";
  return { routeId: route.routeId, code: problem.includes("stale") || problem.includes("timestamp") ? "stale-assumption" : "missing-assumption", message: problem };
}

function rejected(route: PairwiseRoute, code: PairwiseRejection["code"], message: string, instrumentId?: string): { rejection: PairwiseRejection } {
  return { rejection: { routeId: route.routeId, instrumentId, code, message } };
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
