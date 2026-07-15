import { replayDataset, validateReplayDataset } from "./dataset.js";
import { sha256 } from "./canonical.js";
import { DuePositionIndex } from "./duePositionIndex.js";
import { parseHistoricalDepthSnapshot } from "./historicalDepth.js";
import type { HistoricalDepthLevel, HistoricalDepthPayload } from "./historicalDepth.js";
import { buildHistoricalFundingTimeline, fundingSettlementsWithin } from "./fundingTimeline.js";
import type { HistoricalFundingSettlement, HistoricalFundingSettlementProvenance } from "./fundingTimeline.js";
import type { JsonValue, ReplayDataset, ReplayEvent } from "./types.js";

export type { HistoricalDepthLevel, HistoricalDepthPayload } from "./historicalDepth.js";

export interface HistoricalBasisRoute {
  id: string;
  spotInstrumentId: string;
  derivativeInstrumentId: string;
  requestedNotionalUsd: number;
  holdingPeriodMs: number;
  minimumNetEntryBps: number;
  entryFeeBpsPerLeg: number;
  exitFeeBpsPerLeg: number;
  slippageReserveBps: number;
  maximumQuoteAgeMs: number;
  maximumLegSkewMs: number;
}

export interface HistoricalInstrumentIdentityPayload {
  venue: string;
  symbol: string;
  marketType: "spot" | "perpetual" | "future";
  economicAssetId: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  quantityUnit: "base" | "contract";
  baseQuantityMultiplier: number;
  constraintVersion: number;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
}

export interface HistoricalBasisTrade {
  routeId: string;
  economicAssetId: string;
  quantity: number;
  openedAt: number;
  closedAt: number;
  openEventIndex: number;
  closeEventIndex: number;
  spotEntryAskVwap: number;
  derivativeEntryBidVwap: number;
  spotExitBidVwap: number;
  derivativeExitAskVwap: number;
  spotEntryLevelsUsed: number;
  derivativeEntryLevelsUsed: number;
  spotExitLevelsUsed: number;
  derivativeExitLevelsUsed: number;
  spotIdentityDigest: `sha256:${string}`;
  derivativeIdentityDigest: `sha256:${string}`;
  entryGrossBasisBps: number;
  grossPricePnlUsd: number;
  fundingPnlUsd: number;
  feesUsd: number;
  slippageReserveUsd: number;
  netPnlUsd: number;
  fundingSettlementIds: string[];
  fundingSettlementProvenance: HistoricalFundingSettlementProvenance[];
}

type ActiveInstrumentIdentity = HistoricalInstrumentIdentityPayload & {
  listedAt: number;
  exchangeTs: number;
  eventIndex: number;
  constraintEventIndex: number;
  digest: `sha256:${string}`;
};
type StoredBook = HistoricalDepthPayload & {
  instrumentId: string;
  exchangeTs: number;
  receivedAt: number;
  eventIndex: number;
  identityEventIndex: number;
};
type ActiveBasisPosition = {
  routeId: string;
  economicAssetId: string;
  quantity: number;
  openedAt: number;
  dueAt: number;
  openEventIndex: number;
  spotEntryAskVwap: number;
  derivativeEntryBidVwap: number;
  spotEntryLevelsUsed: number;
  derivativeEntryLevelsUsed: number;
  spotIdentityDigest: `sha256:${string}`;
  derivativeIdentityDigest: `sha256:${string}`;
  entryGrossBasisBps: number;
  entryFeesUsd: number;
  slippageReserveUsd: number;
  exitAttempts: number;
  identityInvalidated: boolean;
};
type BasisReplayState = {
  activeInstruments: Record<string, ActiveInstrumentIdentity>;
  books: Record<string, StoredBook>;
  active: Record<string, ActiveBasisPosition>;
  trades: HistoricalBasisTrade[];
  rejectedEntries: number;
  rejectedExits: number;
  rejectedFundingEvents: number;
  duplicateFundingEvents: number;
};

export interface HistoricalBasisBacktestResult {
  datasetId: string;
  eventDigest: `sha256:${string}`;
  economicAssetIds: string[];
  verifiedPointInTime: boolean;
  warnings: string[];
  trades: HistoricalBasisTrade[];
  unresolvedPositions: ActiveBasisPosition[];
  totalNetPnlUsd: number;
  rejectedEntries: number;
  rejectedExits: number;
  rejectedFundingEvents: number;
  duplicateFundingEvents: number;
  finalStateDigest: `sha256:${string}`;
}

export function runHistoricalBasisBacktest(dataset: ReplayDataset, inputRoutes: HistoricalBasisRoute[]): HistoricalBasisBacktestResult {
  validateReplayDataset(dataset);
  if (dataset.manifest.schemaVersion !== 4) {
    throw new Error("historical basis backtest requires replay manifest schema v4 with versioned point-in-time execution constraints");
  }
  if (dataset.manifest.survivorshipPolicy !== "point-in-time") {
    throw new Error("historical basis backtest requires a point-in-time dataset with immutable instrument identities");
  }
  const routes = inputRoutes.map(validateRoute).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(routes.map((route) => route.id)).size !== routes.length) throw new Error("route IDs must be unique");
  validateRouteIdentities(dataset, routes);
  rejectTopBookOnlyDatasets(dataset, routes);
  const funding = buildHistoricalFundingTimeline(
    dataset,
    routes.map((route) => route.derivativeInstrumentId)
  );
  const byInstrument = new Map<string, HistoricalBasisRoute[]>();
  const routeById = new Map(routes.map((route) => [route.id, route]));
  for (const route of routes) {
    for (const instrumentId of [route.spotInstrumentId, route.derivativeInstrumentId]) {
      const values = byInstrument.get(instrumentId) ?? [];
      values.push(route);
      byInstrument.set(instrumentId, values);
    }
  }
  const duePositions = new DuePositionIndex(routes);
  const initial: BasisReplayState = {
    activeInstruments: {},
    books: {},
    active: {},
    trades: [],
    rejectedEntries: 0,
    rejectedExits: 0,
    rejectedFundingEvents: funding.rejected,
    duplicateFundingEvents: funding.duplicates
  };

  const replay = replayDataset(dataset, initial as unknown as JsonValue, (rawState, event, context) => {
    const state = rawState as unknown as BasisReplayState;
    updateInstrumentIdentity(state, event, context.eventIndex, routes);
    if (event.eventType === "depth-snapshot") {
      updateBook(state, event, context.eventIndex);
      const dueRouteIds = duePositions.candidates(context.logicalTime, event.instrumentId!);
      closeDuePositions(state, routeById, dueRouteIds, duePositions, funding.byInstrument, context.logicalTime, context.eventIndex);
    }
    if (event.eventType === "depth-snapshot" && event.instrumentId) {
      for (const route of byInstrument.get(event.instrumentId) ?? []) maybeOpen(state, route, duePositions, context.logicalTime, context.eventIndex);
    }
    return state as unknown as JsonValue;
  });
  const state = replay.finalState as unknown as BasisReplayState;
  return {
    datasetId: replay.datasetId,
    eventDigest: replay.eventDigest,
    economicAssetIds: [...dataset.manifest.economicAssetIds],
    verifiedPointInTime: replay.verifiedPointInTime,
    warnings: replay.warnings,
    trades: state.trades,
    unresolvedPositions: Object.values(state.active).sort((left, right) => left.routeId.localeCompare(right.routeId)),
    totalNetPnlUsd: sum(state.trades.map((trade) => trade.netPnlUsd)),
    rejectedEntries: state.rejectedEntries,
    rejectedExits: state.rejectedExits,
    rejectedFundingEvents: state.rejectedFundingEvents,
    duplicateFundingEvents: state.duplicateFundingEvents,
    finalStateDigest: replay.finalStateDigest
  };
}

function updateInstrumentIdentity(state: BasisReplayState, event: ReplayEvent, eventIndex: number, routes: HistoricalBasisRoute[]) {
  if (!event.instrumentId) return;
  if (event.eventType === "instrument-listed") {
    const payload = instrumentIdentity(event.payload, event.instrumentId);
    state.activeInstruments[event.instrumentId] = {
      ...payload,
      listedAt: event.receivedAt,
      exchangeTs: event.exchangeTs,
      eventIndex,
      constraintEventIndex: eventIndex,
      digest: immutableIdentityDigest(payload)
    };
  } else if (event.eventType === "instrument-constraints-updated") {
    const identity = state.activeInstruments[event.instrumentId];
    if (!identity) throw new Error(`constraint update for inactive instrument ${event.instrumentId}`);
    const constraints = instrumentConstraints(event.payload, event.instrumentId);
    if (constraints.constraintVersion !== identity.constraintVersion + 1) {
      throw new Error(`instrument ${event.instrumentId} constraintVersion did not advance monotonically`);
    }
    Object.assign(identity, constraints, { constraintEventIndex: eventIndex });
  } else if (event.eventType === "instrument-delisted") {
    delete state.activeInstruments[event.instrumentId];
    // A pre-delisting quote is no longer executable once the identity leaves the universe.
    delete state.books[event.instrumentId];
    for (const route of routes) {
      if (route.spotInstrumentId === event.instrumentId || route.derivativeInstrumentId === event.instrumentId) {
        const position = state.active[route.id];
        if (position) position.identityInvalidated = true;
      }
    }
  }
}

function updateBook(state: BasisReplayState, event: ReplayEvent, eventIndex: number) {
  const instrumentId = event.instrumentId!;
  const identity = state.activeInstruments[instrumentId];
  if (!identity) throw new Error(`depth snapshot for inactive instrument ${instrumentId}`);
  if (event.exchangeTs < identity.exchangeTs) throw new Error(`depth snapshot for ${instrumentId} predates its active listing epoch`);
  const payload = parseHistoricalDepthSnapshot(event.payload, instrumentId);
  // A late exchange timestamp is still the newest information available to the
  // strategy when this event arrives. Freshness gates below decide if it is usable.
  state.books[instrumentId] = {
    ...payload,
    instrumentId,
    exchangeTs: event.exchangeTs,
    receivedAt: event.receivedAt,
    eventIndex,
    identityEventIndex: identity.eventIndex
  };
}

function maybeOpen(state: BasisReplayState, route: HistoricalBasisRoute, duePositions: DuePositionIndex, logicalTime: number, eventIndex: number) {
  if (state.active[route.id]) return;
  const spot = state.books[route.spotInstrumentId];
  const derivative = state.books[route.derivativeInstrumentId];
  const spotIdentity = state.activeInstruments[route.spotInstrumentId];
  const derivativeIdentity = state.activeInstruments[route.derivativeInstrumentId];
  if (!spot || !derivative || !spotIdentity || !derivativeIdentity || !qualityIsValid(spot, derivative, logicalTime, route)) {
    state.rejectedEntries += 1;
    return;
  }
  assertRouteIdentity(route, spotIdentity, derivativeIdentity);
  if (spot.identityEventIndex !== spotIdentity.eventIndex || derivative.identityEventIndex !== derivativeIdentity.eventIndex) {
    throw new Error(`route ${route.id} depth does not belong to the active instrument identity epoch`);
  }
  const spotCapacity = baseCapacityWithinQuote(spot.asks, spotIdentity.baseQuantityMultiplier, route.requestedNotionalUsd);
  const derivativeCapacity = totalBaseCapacity(derivative.bids, derivativeIdentity.baseQuantityMultiplier);
  const step = commonDecimalStep(spotIdentity.quantityStep * spotIdentity.baseQuantityMultiplier, derivativeIdentity.quantityStep * derivativeIdentity.baseQuantityMultiplier);
  const quantity = floorStep(Math.min(spotCapacity, derivativeCapacity), step);
  const spotMinimum = spotIdentity.minimumQuantity * spotIdentity.baseQuantityMultiplier;
  const derivativeMinimum = derivativeIdentity.minimumQuantity * derivativeIdentity.baseQuantityMultiplier;
  if (!(quantity > 0) || quantity < spotMinimum || quantity < derivativeMinimum) {
    state.rejectedEntries += 1;
    return;
  }
  const spotEntry = walkDepth(spot.asks, quantity, spotIdentity.baseQuantityMultiplier);
  const derivativeEntry = walkDepth(derivative.bids, quantity, derivativeIdentity.baseQuantityMultiplier);
  if (!spotEntry || !derivativeEntry || spotEntry.quoteNotional < spotIdentity.minimumNotional || derivativeEntry.quoteNotional < derivativeIdentity.minimumNotional) {
    state.rejectedEntries += 1;
    return;
  }
  const grossBasisBps = ((derivativeEntry.vwap - spotEntry.vwap) / spotEntry.vwap) * 10_000;
  const estimatedCostBps = 2 * (route.entryFeeBpsPerLeg + route.exitFeeBpsPerLeg) + route.slippageReserveBps;
  if (grossBasisBps - estimatedCostBps < route.minimumNetEntryBps) return;
  const entryFeesUsd = (spotEntry.quoteNotional + derivativeEntry.quoteNotional) * (route.entryFeeBpsPerLeg / 10_000);
  const entryReferenceNotionalUsd = (spotEntry.quoteNotional + derivativeEntry.quoteNotional) / 2;
  const slippageReserveUsd = entryReferenceNotionalUsd * (route.slippageReserveBps / 10_000);
  state.active[route.id] = {
    routeId: route.id,
    economicAssetId: spotIdentity.economicAssetId,
    quantity,
    openedAt: logicalTime,
    dueAt: logicalTime + route.holdingPeriodMs,
    openEventIndex: eventIndex,
    spotEntryAskVwap: spotEntry.vwap,
    derivativeEntryBidVwap: derivativeEntry.vwap,
    spotEntryLevelsUsed: spotEntry.levelsUsed,
    derivativeEntryLevelsUsed: derivativeEntry.levelsUsed,
    spotIdentityDigest: spotIdentity.digest,
    derivativeIdentityDigest: derivativeIdentity.digest,
    entryGrossBasisBps: grossBasisBps,
    entryFeesUsd,
    slippageReserveUsd,
    exitAttempts: 0,
    identityInvalidated: false
  };
  duePositions.add(state.active[route.id]!);
}

function closeDuePositions(state: BasisReplayState, routeById: ReadonlyMap<string, HistoricalBasisRoute>, dueRouteIds: string[], duePositions: DuePositionIndex, fundingByInstrument: ReadonlyMap<string, HistoricalFundingSettlement[]>, logicalTime: number, eventIndex: number) {
  for (const routeId of dueRouteIds) {
    const route = routeById.get(routeId);
    if (!route) throw new Error(`due-position index returned unknown route ${routeId}`);
    const position = state.active[route.id];
    if (!position || logicalTime < position.dueAt) continue;
    if (position.identityInvalidated) {
      position.exitAttempts += 1;
      state.rejectedExits += 1;
      continue;
    }
    const spot = state.books[route.spotInstrumentId];
    const derivative = state.books[route.derivativeInstrumentId];
    const spotIdentity = state.activeInstruments[route.spotInstrumentId];
    const derivativeIdentity = state.activeInstruments[route.derivativeInstrumentId];
    if (!spot || !derivative || !spotIdentity || !derivativeIdentity || !qualityIsValid(spot, derivative, logicalTime, route)) {
      position.exitAttempts += 1;
      state.rejectedExits += 1;
      continue;
    }
    assertRouteIdentity(route, spotIdentity, derivativeIdentity);
    if (spotIdentity.digest !== position.spotIdentityDigest || derivativeIdentity.digest !== position.derivativeIdentityDigest) {
      position.exitAttempts += 1;
      state.rejectedExits += 1;
      continue;
    }
    if (!quantityMeetsConstraints(position.quantity, spotIdentity) || !quantityMeetsConstraints(position.quantity, derivativeIdentity)) {
      position.exitAttempts += 1;
      state.rejectedExits += 1;
      continue;
    }
    const spotExit = walkDepth(spot.bids, position.quantity, spotIdentity.baseQuantityMultiplier);
    const derivativeExit = walkDepth(derivative.asks, position.quantity, derivativeIdentity.baseQuantityMultiplier);
    if (!spotExit || !derivativeExit || spotExit.quoteNotional < spotIdentity.minimumNotional || derivativeExit.quoteNotional < derivativeIdentity.minimumNotional) {
      position.exitAttempts += 1;
      state.rejectedExits += 1;
      continue;
    }
    const grossPricePnlUsd = spotExit.quoteNotional - position.quantity * position.spotEntryAskVwap + position.quantity * position.derivativeEntryBidVwap - derivativeExit.quoteNotional;
    const exitFeesUsd = (spotExit.quoteNotional + derivativeExit.quoteNotional) * (route.exitFeeBpsPerLeg / 10_000);
    const feesUsd = position.entryFeesUsd + exitFeesUsd;
    const settlements = fundingSettlementsWithin(fundingByInstrument.get(route.derivativeInstrumentId) ?? [], position.openedAt, logicalTime);
    const fundingPnlUsd = sum(settlements.map((settlement) => position.quantity * settlement.referencePrice * settlement.rate));
    state.trades.push({
      routeId: route.id,
      economicAssetId: position.economicAssetId,
      quantity: position.quantity,
      openedAt: position.openedAt,
      closedAt: logicalTime,
      openEventIndex: position.openEventIndex,
      closeEventIndex: eventIndex,
      spotEntryAskVwap: position.spotEntryAskVwap,
      derivativeEntryBidVwap: position.derivativeEntryBidVwap,
      spotExitBidVwap: spotExit.vwap,
      derivativeExitAskVwap: derivativeExit.vwap,
      spotEntryLevelsUsed: position.spotEntryLevelsUsed,
      derivativeEntryLevelsUsed: position.derivativeEntryLevelsUsed,
      spotExitLevelsUsed: spotExit.levelsUsed,
      derivativeExitLevelsUsed: derivativeExit.levelsUsed,
      spotIdentityDigest: position.spotIdentityDigest,
      derivativeIdentityDigest: position.derivativeIdentityDigest,
      entryGrossBasisBps: position.entryGrossBasisBps,
      grossPricePnlUsd,
      fundingPnlUsd,
      feesUsd,
      slippageReserveUsd: position.slippageReserveUsd,
      netPnlUsd: grossPricePnlUsd + fundingPnlUsd - feesUsd - position.slippageReserveUsd,
      fundingSettlementIds: settlements.map((settlement) => settlement.settlementId),
      fundingSettlementProvenance: settlements.map(({ instrumentId: _instrumentId, rate: _rate, referencePrice: _referencePrice, ...provenance }) => provenance)
    });
    delete state.active[route.id];
    duePositions.remove(route.id);
  }
}

function qualityIsValid(left: StoredBook, right: StoredBook, now: number, route: HistoricalBasisRoute) {
  const leftAge = Math.max(now - left.exchangeTs, now - left.receivedAt);
  const rightAge = Math.max(now - right.exchangeTs, now - right.receivedAt);
  const legSkew = Math.max(Math.abs(left.exchangeTs - right.exchangeTs), Math.abs(left.receivedAt - right.receivedAt));
  return leftAge >= 0 && rightAge >= 0 && leftAge <= route.maximumQuoteAgeMs && rightAge <= route.maximumQuoteAgeMs && legSkew <= route.maximumLegSkewMs;
}

function validateRouteIdentities(dataset: ReplayDataset, routes: HistoricalBasisRoute[]) {
  const routeInstruments = new Set(routes.flatMap((route) => [route.spotInstrumentId, route.derivativeInstrumentId]));
  const listed = new Set<string>();
  const economicIdentities = new Map<string, Set<string>>();
  for (const event of dataset.events) {
    if (event.eventType !== "instrument-listed" || !event.instrumentId || !routeInstruments.has(event.instrumentId)) continue;
    const identity = instrumentIdentity(event.payload, event.instrumentId);
    listed.add(event.instrumentId);
    const values = economicIdentities.get(event.instrumentId) ?? new Set<string>();
    values.add(identity.economicAssetId);
    economicIdentities.set(event.instrumentId, values);
  }
  for (const route of routes) {
    for (const instrumentId of [route.spotInstrumentId, route.derivativeInstrumentId]) {
      if (!listed.has(instrumentId)) throw new Error(`route ${route.id} instrument ${instrumentId} has no point-in-time listing event`);
    }
    const spotEconomicIds = economicIdentities.get(route.spotInstrumentId)!;
    const derivativeEconomicIds = economicIdentities.get(route.derivativeInstrumentId)!;
    if (spotEconomicIds.size !== 1 || derivativeEconomicIds.size !== 1 || [...spotEconomicIds][0] !== [...derivativeEconomicIds][0]) {
      throw new Error(`route ${route.id} instrument economic identity mismatch`);
    }
  }
}

function rejectTopBookOnlyDatasets(dataset: ReplayDataset, routes: HistoricalBasisRoute[]) {
  const routeInstruments = new Set(routes.flatMap((route) => [route.spotInstrumentId, route.derivativeInstrumentId]));
  const depths = new Set<string>();
  for (const event of dataset.events) {
    if (!event.instrumentId || !routeInstruments.has(event.instrumentId)) continue;
    if (event.eventType === "top-book") throw new Error(`basis backtest requires depth-snapshot events; top-book event found for ${event.instrumentId}`);
    if (event.eventType === "depth-snapshot") depths.add(event.instrumentId);
  }
  for (const instrumentId of routeInstruments) {
    if (!depths.has(instrumentId)) throw new Error(`basis backtest has no depth-snapshot event for ${instrumentId}`);
  }
}

function instrumentIdentity(value: JsonValue, instrumentId: string): HistoricalInstrumentIdentityPayload {
  const row = record(value, `instrument identity ${instrumentId}`);
  const marketType = row.marketType;
  if (marketType !== "spot" && marketType !== "perpetual" && marketType !== "future") throw new Error(`instrument identity ${instrumentId} marketType is invalid`);
  const quantityUnit = row.quantityUnit;
  if (quantityUnit !== "base" && quantityUnit !== "contract") throw new Error(`instrument identity ${instrumentId} quantityUnit is invalid`);
  const identity: HistoricalInstrumentIdentityPayload = {
    venue: text(row.venue, "identity venue"),
    symbol: text(row.symbol, "identity symbol"),
    marketType,
    economicAssetId: canonicalEconomicAssetId(row.economicAssetId, "identity economicAssetId"),
    baseAsset: canonicalAsset(row.baseAsset, "identity baseAsset"),
    quoteAsset: canonicalAsset(row.quoteAsset, "identity quoteAsset"),
    settleAsset: canonicalAsset(row.settleAsset, "identity settleAsset"),
    quantityUnit,
    baseQuantityMultiplier: positive(row.baseQuantityMultiplier, "baseQuantityMultiplier"),
    constraintVersion: positiveInteger(row.constraintVersion, "constraintVersion"),
    quantityStep: positive(row.quantityStep, "quantityStep"),
    minimumQuantity: positive(row.minimumQuantity, "minimumQuantity"),
    minimumNotional: positive(row.minimumNotional, "minimumNotional")
  };
  if (marketType === "spot" && (quantityUnit !== "base" || identity.baseQuantityMultiplier !== 1)) {
    throw new Error(`instrument identity ${instrumentId} spot quantity must be native base with multiplier 1`);
  }
  return identity;
}

function instrumentConstraints(value: JsonValue, instrumentId: string) {
  const row = record(value, `instrument constraints ${instrumentId}`);
  return {
    constraintVersion: positiveInteger(row.constraintVersion, "constraintVersion"),
    quantityStep: positive(row.quantityStep, "quantityStep"),
    minimumQuantity: positive(row.minimumQuantity, "minimumQuantity"),
    minimumNotional: positive(row.minimumNotional, "minimumNotional")
  };
}

function immutableIdentityDigest(identity: HistoricalInstrumentIdentityPayload) {
  const { constraintVersion: _constraintVersion, quantityStep: _quantityStep, minimumQuantity: _minimumQuantity, minimumNotional: _minimumNotional, ...immutableIdentity } = identity;
  return sha256(immutableIdentity as unknown as JsonValue);
}

function assertRouteIdentity(route: HistoricalBasisRoute, spot: ActiveInstrumentIdentity, derivative: ActiveInstrumentIdentity) {
  if (spot.marketType !== "spot" || derivative.marketType === "spot") throw new Error(`route ${route.id} market types are incompatible with basis trading`);
  if (spot.economicAssetId !== derivative.economicAssetId) throw new Error(`route ${route.id} instrument economic identity mismatch`);
  if (spot.baseAsset !== derivative.baseAsset || spot.quoteAsset !== derivative.quoteAsset) {
    throw new Error(`route ${route.id} instrument base/quote identity mismatch`);
  }
  if (spot.settleAsset !== spot.quoteAsset || derivative.settleAsset !== spot.quoteAsset) {
    throw new Error(`route ${route.id} requires both legs to settle in the common quote asset`);
  }
}

function quantityMeetsConstraints(baseQuantity: number, identity: ActiveInstrumentIdentity) {
  const nativeQuantity = baseQuantity / identity.baseQuantityMultiplier;
  if (nativeQuantity + 1e-12 < identity.minimumQuantity) return false;
  const stepUnits = nativeQuantity / identity.quantityStep;
  return Math.abs(stepUnits - Math.round(stepUnits)) <= Math.max(1e-9, Math.abs(stepUnits) * 1e-10);
}

function totalBaseCapacity(levels: HistoricalDepthLevel[], baseQuantityMultiplier: number) {
  return levels.reduce((total, [, nativeQuantity]) => total + nativeQuantity * baseQuantityMultiplier, 0);
}

function baseCapacityWithinQuote(levels: HistoricalDepthLevel[], baseQuantityMultiplier: number, quoteBudget: number) {
  let remainingQuote = quoteBudget;
  let baseQuantity = 0;
  for (const [price, nativeQuantity] of levels) {
    const levelBase = nativeQuantity * baseQuantityMultiplier;
    const takeBase = Math.min(levelBase, remainingQuote / price);
    baseQuantity += takeBase;
    remainingQuote -= takeBase * price;
    if (remainingQuote <= quoteBudget * 1e-12) break;
  }
  return baseQuantity;
}

function walkDepth(levels: HistoricalDepthLevel[], requestedBaseQuantity: number, baseQuantityMultiplier: number) {
  let remainingBase = requestedBaseQuantity;
  let quoteNotional = 0;
  let levelsUsed = 0;
  for (const [price, nativeQuantity] of levels) {
    if (remainingBase <= requestedBaseQuantity * 1e-12) break;
    const takeBase = Math.min(remainingBase, nativeQuantity * baseQuantityMultiplier);
    quoteNotional += takeBase * price;
    remainingBase -= takeBase;
    levelsUsed += 1;
  }
  if (remainingBase > Math.max(1e-12, requestedBaseQuantity * 1e-10)) return undefined;
  return { quoteNotional, vwap: quoteNotional / requestedBaseQuantity, levelsUsed };
}

function validateRoute(route: HistoricalBasisRoute): HistoricalBasisRoute {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(route.id)) throw new Error("route.id is invalid");
  if (!route.spotInstrumentId || !route.derivativeInstrumentId || route.spotInstrumentId === route.derivativeInstrumentId) throw new Error(`route ${route.id} instruments are invalid`);
  for (const [label, value] of Object.entries(route)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`route ${route.id} ${label} must be non-negative and finite`);
  }
  if (route.requestedNotionalUsd <= 0 || route.holdingPeriodMs <= 0 || route.maximumQuoteAgeMs <= 0) throw new Error(`route ${route.id} requires positive notional, holding period and quote age`);
  return { ...route };
}

function commonDecimalStep(left: number, right: number) {
  const scale = 1_000_000_000_000n;
  const leftUnits = BigInt(Math.round(left * Number(scale)));
  const rightUnits = BigInt(Math.round(right * Number(scale)));
  if (leftUnits <= 0n || rightUnits <= 0n) throw new Error("quantity step is below supported precision");
  return Number(lcm(leftUnits, rightUnits)) / Number(scale);
}
function floorStep(value: number, step: number) {
  return Math.floor((value + step * 1e-10) / step) * step;
}
function lcm(left: bigint, right: bigint) {
  return (left / gcd(left, right)) * right;
}
function gcd(left: bigint, right: bigint): bigint {
  return right === 0n ? left : gcd(right, left % right);
}
function record(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function text(value: JsonValue | undefined, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function canonicalAsset(value: JsonValue | undefined, label: string) {
  const result = text(value, label);
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(result)) throw new Error(`${label} must be a canonical uppercase asset`);
  return result;
}
function canonicalEconomicAssetId(value: JsonValue | undefined, label: string) {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error(`${label} must be a canonical namespace:value identity`);
  return result;
}
function finite(value: JsonValue | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function positive(value: JsonValue | undefined, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}
function positiveInteger(value: JsonValue | undefined, label: string) {
  const result = positive(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be a positive integer`);
  return result;
}
function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
