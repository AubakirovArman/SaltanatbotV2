import { parseBasisIdentityCoverage, parseBasisOpportunityTiming, type BasisClockCorrection, type BasisIdentityCoverage } from "@saltanatbotv2/arbitrage-sdk";

export type ArbitrageExchange = "binance" | "bybit";

export interface ArbitrageOpportunity {
  id: string;
  strategyKind: "cash-and-carry";
  edgeKind: "projected";
  identityScope: "venue-native" | "cross-venue-reviewed";
  symbol: string;
  assetId: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  spotBid: number;
  spotAsk: number;
  spotAskSize: number;
  futuresBid: number;
  futuresAsk: number;
  futuresBidSize: number;
  grossSpreadBps: number;
  estimatedTotalCostBps: number;
  netEdgeBps: number;
  topBookCapacityUsd: number;
  topBookMatchedQuantity: number;
  expectedNetProfitUsd: number;
  fundingRate: number;
  nextFundingTime?: number;
  fundingIntervalMinutes?: number;
  fundingScheduleVerified: boolean;
  spotExchangeTs?: number;
  spotExchangeTimestampVerified: boolean;
  spotReceivedAt: number;
  futuresExchangeTs?: number;
  futuresExchangeTimestampVerified: boolean;
  futuresReceivedAt: number;
  quoteAgeMs: number;
  legSkewMs: number;
  dataQuality: "fresh" | "stale" | "skewed" | "unverified";
  clockCorrection?: BasisClockCorrection;
  capturedAt: number;
}

export interface ArbitrageDepthLeg {
  exchange: ArbitrageExchange;
  market: "spot" | "perpetual";
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  quantity: number;
  averagePrice: number;
  worstPrice: number;
  topPrice: number;
  slippageBps: number;
  levelsUsed: number;
  complete: boolean;
  capturedAt: number;
}

export interface ArbitrageDepthBookTiming {
  exchangeTs?: number;
  receivedAt: number;
  ageMs: number;
  sequence?: number;
}

export interface ArbitrageDepthTiming {
  spot: ArbitrageDepthBookTiming;
  perpetual: ArbitrageDepthBookTiming;
  ageMs: number;
  receiveSkewMs: number;
  exchangeSkewMs?: number;
  legSkewMs: number;
  exchangeTimestampsVerified: boolean;
  quality: "fresh" | "stale" | "skewed" | "unverified";
}

export interface ArbitrageDepthConstraints {
  metadataVerified: boolean;
  minimumsSatisfied: boolean;
  verified: boolean;
  failures: string[];
}

export interface ArbitrageDepthResponse {
  identityScope: "venue-native" | "cross-venue-reviewed";
  assetId: string;
  economicAssetId?: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
  symbol: string;
  direction: "entry" | "exit";
  requestedNotionalUsd: number;
  targetQuantity: number;
  matchedQuantity: number;
  quantityStep: number;
  quantityStepSource: "instrument" | "fallback";
  precisionVerified: boolean;
  roundingDustQuantity: number;
  liquidityShortfallQuantity: number;
  residualDeltaQuantity: number;
  spot: ArbitrageDepthLeg;
  perpetual: ArbitrageDepthLeg;
  timing: ArbitrageDepthTiming;
  constraints: ArbitrageDepthConstraints;
  grossSpreadBps: number;
  complete: boolean;
  capturedAt: number;
}

export interface ArbitrageDepthRouteRef {
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  identityScope: ArbitrageOpportunity["identityScope"];
  assetId: string;
  economicAssetId?: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
}

export interface ArbitrageScanResponse {
  updatedAt: number;
  stale: boolean;
  scannedSymbols: number;
  totalOpportunities: number;
  truncated: boolean;
  estimatedTotalCostBps: number;
  opportunities: ArbitrageOpportunity[];
  sources: Array<{ exchange: ArbitrageExchange; market: "spot" | "perpetual"; ok: boolean; message?: string }>;
  identityCoverage?: BasisIdentityCoverage;
}

export interface ArbitrageHistoryPoint {
  routeId: string;
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  grossSpreadBps: number;
  topBookCapacityUsd: number;
  fundingRate: number;
  ts: number;
}

export async function fetchArbitrageScan(costBps: number, signal?: AbortSignal): Promise<ArbitrageScanResponse> {
  const query = new URLSearchParams({ costBps: String(costBps), minSpreadBps: "-1000", limit: "2000", sort: "expected-profit" });
  const response = await fetch(`/api/arbitrage?${query}`, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Arbitrage API ${response.status}`);
  }
  return parseArbitrageScan(await response.json());
}

export async function fetchArbitrageDepth(row: ArbitrageDepthRouteRef, notionalUsd: number, signal?: AbortSignal): Promise<ArbitrageDepthResponse> {
  const query = new URLSearchParams({ symbol: row.symbol, spotExchange: row.spotExchange, futuresExchange: row.futuresExchange, notionalUsd: String(notionalUsd) });
  return fetchDepthQuery(query, row, "entry", notionalUsd, undefined, signal);
}

export async function fetchArbitrageExitDepth(row: ArbitrageDepthRouteRef, notionalUsd: number, quantity: number, signal?: AbortSignal): Promise<ArbitrageDepthResponse> {
  const query = new URLSearchParams({
    symbol: row.symbol,
    spotExchange: row.spotExchange,
    futuresExchange: row.futuresExchange,
    notionalUsd: String(notionalUsd),
    direction: "exit",
    quantity: String(quantity)
  });
  return fetchDepthQuery(query, row, "exit", notionalUsd, quantity, signal);
}

async function fetchDepthQuery(query: URLSearchParams, route: ArbitrageDepthRouteRef, direction: "entry" | "exit", notionalUsd: number, quantity: number | undefined, signal?: AbortSignal): Promise<ArbitrageDepthResponse> {
  const response = await fetch(`/api/arbitrage/depth?${query}`, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Arbitrage depth API ${response.status}`);
  }
  const parsed = parseArbitrageDepth(await response.json(), route, direction);
  if (parsed.requestedNotionalUsd !== notionalUsd || (direction === "exit" && parsed.targetQuantity !== quantity)) {
    throw new Error("Arbitrage depth response does not match the requested size");
  }
  return parsed;
}

export async function fetchArbitrageHistory(routeId: string, hours = 24, signal?: AbortSignal): Promise<ArbitrageHistoryPoint[]> {
  const query = new URLSearchParams({ routeId, hours: String(hours), limit: "500" });
  const response = await fetch(`/api/arbitrage/history?${query}`, { signal });
  if (!response.ok) throw new Error(`Arbitrage history API ${response.status}`);
  const envelope = record(await response.json(), "arbitrage history response");
  return array(envelope.points, "points", 1_000).map((value, index) => {
    const row = record(value, `points[${index}]`);
    return {
      routeId: string(row.routeId, "routeId"),
      symbol: string(row.symbol, "symbol"),
      spotExchange: exchangeId(row.spotExchange, "spotExchange"),
      futuresExchange: exchangeId(row.futuresExchange, "futuresExchange"),
      grossSpreadBps: finite(row.grossSpreadBps, "grossSpreadBps"),
      topBookCapacityUsd: finite(row.topBookCapacityUsd, "topBookCapacityUsd"),
      fundingRate: finite(row.fundingRate, "fundingRate"),
      ts: finite(row.ts, "ts")
    };
  });
}

export function createArbitrageSocket(): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/arbitrage-stream`);
}

export function parseArbitrageStreamMessage(value: unknown): { type: "snapshot"; data: ArbitrageScanResponse } | { type: "error"; message: string } {
  const input = record(value, "arbitrage stream message");
  if (input.type === "arbitrage_snapshot") return { type: "snapshot", data: parseArbitrageScan(input.data) };
  if (input.type === "arbitrage_error") return { type: "error", message: string(input.message, "message") };
  throw new Error("Unsupported arbitrage stream message");
}

export function parseArbitrageScan(value: unknown): ArbitrageScanResponse {
  const input = record(value, "arbitrage response");
  const rawOpportunities = array(input.opportunities, "opportunities", 2_000);
  const rawSources = array(input.sources, "sources", 8);
  const stale = boolean(input.stale, "stale");
  const identityCoverage = parseBasisIdentityCoverage(input.identityCoverage);
  const sources: ArbitrageScanResponse["sources"] = rawSources.map((value, index) => {
    const source = record(value, `sources[${index}]`);
    const exchange = exchangeId(source.exchange, `sources[${index}].exchange`);
    const market = string(source.market, `sources[${index}].market`);
    if (market !== "spot" && market !== "perpetual") throw new Error(`sources[${index}].market is unsupported`);
    return { exchange, market, ok: boolean(source.ok, `sources[${index}].ok`), message: optionalString(source.message, `sources[${index}].message`) };
  });
  const sourceKeys = sources.map((source) => `${source.exchange}:${source.market}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("sources contains duplicate venue-market status");
  return {
    updatedAt: finite(input.updatedAt, "updatedAt"),
    stale,
    scannedSymbols: finite(input.scannedSymbols, "scannedSymbols"),
    totalOpportunities: optionalFinite(input.totalOpportunities, "totalOpportunities") ?? rawOpportunities.length,
    truncated: optionalBoolean(input.truncated, "truncated") ?? false,
    estimatedTotalCostBps: finite(input.estimatedTotalCostBps, "estimatedTotalCostBps"),
    opportunities: rawOpportunities.map((value, index) => opportunity(value, index, stale, sources)),
    sources,
    ...(identityCoverage ? { identityCoverage } : {})
  };
}

function opportunity(value: unknown, index: number, scanStale: boolean, sources: ArbitrageScanResponse["sources"]): ArbitrageOpportunity {
  const row = record(value, `opportunities[${index}]`);
  const symbol = string(row.symbol, "symbol");
  const id = string(row.id, "id");
  const spotExchange = exchangeId(row.spotExchange, "spotExchange");
  const futuresExchange = exchangeId(row.futuresExchange, "futuresExchange");
  const capturedAt = positiveFinite(row.capturedAt, "capturedAt");
  const spotAskSize = finite(row.spotAskSize, "spotAskSize");
  const futuresBidSize = finite(row.futuresBidSize, "futuresBidSize");
  const spotAsk = finite(row.spotAsk, "spotAsk");
  const assetId = string(row.assetId, "assetId");
  if (!/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/.test(assetId)) throw new Error("assetId is unsupported");
  const identityScope = string(row.identityScope, "identityScope");
  if (identityScope !== "venue-native" && identityScope !== "cross-venue-reviewed") throw new Error("identityScope is unsupported");
  if (spotExchange === futuresExchange) {
    if (identityScope !== "venue-native" || !assetId.startsWith(`${spotExchange}:`)) throw new Error("identityScope does not match same-venue identity");
  } else if (identityScope !== "cross-venue-reviewed" || (assetId !== "crypto:bitcoin" && assetId !== "crypto:ethereum")) {
    throw new Error("identityScope does not match reviewed cross-venue identity");
  }
  const netEdgeBps = finite(row.netEdgeBps, "netEdgeBps");
  const topBookCapacityUsd = finite(row.topBookCapacityUsd, "topBookCapacityUsd");
  const dataQuality = string(row.dataQuality, "dataQuality");
  if (dataQuality !== "fresh" && dataQuality !== "stale" && dataQuality !== "skewed" && dataQuality !== "unverified") throw new Error("dataQuality is unsupported");
  const spotExchangeTimestampVerified = boolean(row.spotExchangeTimestampVerified, "spotExchangeTimestampVerified");
  const spotExchangeTs = venueTimestamp(row.spotExchangeTs, spotExchangeTimestampVerified, "spotExchangeTs");
  const spotReceivedAt = nonNegativeFinite(row.spotReceivedAt, "spotReceivedAt");
  const futuresExchangeTimestampVerified = boolean(row.futuresExchangeTimestampVerified, "futuresExchangeTimestampVerified");
  const futuresExchangeTs = venueTimestamp(row.futuresExchangeTs, futuresExchangeTimestampVerified, "futuresExchangeTs");
  const futuresReceivedAt = nonNegativeFinite(row.futuresReceivedAt, "futuresReceivedAt");
  const quoteAgeMs = nonNegativeFinite(row.quoteAgeMs, "quoteAgeMs");
  const legSkewMs = nonNegativeFinite(row.legSkewMs, "legSkewMs");
  const timing = parseBasisOpportunityTiming({ correction: row.clockCorrection, capturedAt, spotExchange, futuresExchange, spotExchangeTs, futuresExchangeTs, spotReceivedAt, futuresReceivedAt, quoteAgeMs, legSkewMs });
  const measuredQuality = timing.measuredQuality;
  // The REST service explicitly marks reused cached rows stale. A WebSocket
  // envelope can meanwhile be globally stale because an unrelated source is
  // down, so the envelope bit alone must not downgrade an independent route.
  const serverMarkedCachedSnapshot = scanStale && measuredQuality === "fresh" && dataQuality === "stale";
  if (dataQuality !== measuredQuality && !serverMarkedCachedSnapshot) {
    throw new Error("opportunity quality fields are inconsistent with source timestamps");
  }
  const dependenciesHealthy = sourceHealthy(sources, spotExchange, "spot") && sourceHealthy(sources, futuresExchange, "perpetual");
  const expectedQuality = measuredQuality === "fresh" && (!dependenciesHealthy || serverMarkedCachedSnapshot) ? "stale" : measuredQuality;
  return {
    id,
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope,
    symbol,
    assetId,
    spotInstrumentId: canonicalInstrumentId(row.spotInstrumentId, spotExchange, "spot", symbol, "spotInstrumentId"),
    futuresInstrumentId: canonicalInstrumentId(row.futuresInstrumentId, futuresExchange, "perpetual", symbol, "futuresInstrumentId"),
    spotExchange,
    futuresExchange,
    spotBid: finite(row.spotBid, "spotBid"),
    spotAsk,
    spotAskSize,
    futuresBid: finite(row.futuresBid, "futuresBid"),
    futuresAsk: finite(row.futuresAsk, "futuresAsk"),
    futuresBidSize,
    grossSpreadBps: finite(row.grossSpreadBps, "grossSpreadBps"),
    estimatedTotalCostBps: finite(row.estimatedTotalCostBps, "estimatedTotalCostBps"),
    netEdgeBps,
    topBookCapacityUsd,
    topBookMatchedQuantity: optionalFinite(row.topBookMatchedQuantity, "topBookMatchedQuantity") ?? Math.min(spotAskSize, futuresBidSize),
    expectedNetProfitUsd: optionalFinite(row.expectedNetProfitUsd, "expectedNetProfitUsd") ?? (topBookCapacityUsd * netEdgeBps) / 10_000,
    fundingRate: finite(row.fundingRate, "fundingRate"),
    nextFundingTime: row.nextFundingTime === undefined ? undefined : finite(row.nextFundingTime, "nextFundingTime"),
    fundingIntervalMinutes: row.fundingIntervalMinutes === undefined ? undefined : finite(row.fundingIntervalMinutes, "fundingIntervalMinutes"),
    fundingScheduleVerified: optionalBoolean(row.fundingScheduleVerified, "fundingScheduleVerified") ?? false,
    ...(spotExchangeTs === undefined ? {} : { spotExchangeTs }),
    spotExchangeTimestampVerified,
    spotReceivedAt,
    ...(futuresExchangeTs === undefined ? {} : { futuresExchangeTs }),
    futuresExchangeTimestampVerified,
    futuresReceivedAt,
    quoteAgeMs,
    legSkewMs,
    dataQuality: expectedQuality,
    ...(timing.clockCorrection ? { clockCorrection: timing.clockCorrection } : {}),
    capturedAt
  };
}

function sourceHealthy(sources: ArbitrageScanResponse["sources"], exchange: ArbitrageExchange, market: "spot" | "perpetual") {
  const matching = sources.filter((source) => source.exchange === exchange && source.market === market);
  return matching.length === 1 && matching[0]?.ok === true;
}

export function parseArbitrageDepth(value: unknown, route?: ArbitrageDepthRouteRef, expectedDirection?: "entry" | "exit"): ArbitrageDepthResponse {
  const input = record(value, "arbitrage depth response");
  const spot = depthLeg(input.spot, "spot");
  const perpetual = depthLeg(input.perpetual, "perpetual");
  const symbol = string(input.symbol, "symbol");
  const direction = input.direction === undefined ? "entry" : depthDirection(input.direction);
  const identityScope = depthIdentityScope(input.identityScope);
  const assetId = string(input.assetId, "assetId");
  const economicAssetId = optionalString(input.economicAssetId, "economicAssetId");
  const capturedAt = positiveFinite(input.capturedAt, "capturedAt");
  const legacyMatchedQuantity = Math.min(spot.quantity, perpetual.quantity);
  const quantityStepSource = optionalString(input.quantityStepSource, "quantityStepSource") ?? "fallback";
  if (quantityStepSource !== "instrument" && quantityStepSource !== "fallback") throw new Error("quantityStepSource is unsupported");
  const parsed: ArbitrageDepthResponse = {
    identityScope,
    assetId,
    ...(economicAssetId ? { economicAssetId } : {}),
    spotInstrumentId: canonicalInstrumentId(input.spotInstrumentId, spot.exchange, "spot", symbol, "spotInstrumentId"),
    futuresInstrumentId: canonicalInstrumentId(input.futuresInstrumentId, perpetual.exchange, "perpetual", symbol, "futuresInstrumentId"),
    symbol,
    direction,
    requestedNotionalUsd: finite(input.requestedNotionalUsd, "requestedNotionalUsd"),
    targetQuantity: optionalFinite(input.targetQuantity, "targetQuantity") ?? spot.quantity,
    matchedQuantity: optionalFinite(input.matchedQuantity, "matchedQuantity") ?? legacyMatchedQuantity,
    quantityStep: optionalFinite(input.quantityStep, "quantityStep") ?? 1e-8,
    quantityStepSource,
    precisionVerified: optionalBoolean(input.precisionVerified, "precisionVerified") ?? false,
    roundingDustQuantity: optionalFinite(input.roundingDustQuantity, "roundingDustQuantity") ?? Math.abs(spot.quantity - perpetual.quantity),
    liquidityShortfallQuantity: optionalFinite(input.liquidityShortfallQuantity, "liquidityShortfallQuantity") ?? 0,
    residualDeltaQuantity: optionalFinite(input.residualDeltaQuantity, "residualDeltaQuantity") ?? spot.quantity - perpetual.quantity,
    spot,
    perpetual,
    timing: depthTiming(input.timing, capturedAt),
    constraints: depthConstraints(input.constraints),
    grossSpreadBps: finite(input.grossSpreadBps, "grossSpreadBps"),
    complete: boolean(input.complete, "complete"),
    capturedAt
  };
  if (parsed.complete && (!parsed.timing.exchangeTimestampsVerified || parsed.timing.quality !== "fresh")) {
    throw new Error("complete arbitrage depth requires fresh verified exchange timestamps");
  }
  assertArbitrageDepthBinding(parsed, route, expectedDirection ?? direction);
  return parsed;
}

export function assertArbitrageDepthBinding(depth: ArbitrageDepthResponse, route: ArbitrageDepthRouteRef | undefined, direction: "entry" | "exit") {
  const spotSide = direction === "entry" ? "buy" : "sell";
  const perpetualSide = direction === "entry" ? "sell" : "buy";
  const reviewedEconomicAssetId = depth.symbol === "BTCUSDT" ? "crypto:bitcoin" : depth.symbol === "ETHUSDT" ? "crypto:ethereum" : undefined;
  if (depth.direction !== direction || depth.spot.market !== "spot" || depth.perpetual.market !== "perpetual" || depth.spot.side !== spotSide || depth.perpetual.side !== perpetualSide) {
    throw new Error("Arbitrage depth legs do not match the requested direction");
  }
  if (depth.economicAssetId !== undefined && depth.economicAssetId !== reviewedEconomicAssetId) throw new Error("Arbitrage depth economic identity is unreviewed");
  if (depth.spot.exchange === depth.perpetual.exchange) {
    if (depth.identityScope !== "venue-native" || !depth.assetId.startsWith(`${depth.spot.exchange}:`)) throw new Error("Arbitrage depth native identity is inconsistent");
  } else if (depth.identityScope !== "cross-venue-reviewed" || depth.economicAssetId !== reviewedEconomicAssetId || depth.assetId !== reviewedEconomicAssetId) {
    throw new Error("Arbitrage depth economic identity is unreviewed");
  }
  if (!route) return;
  if (
    depth.symbol !== route.symbol ||
    depth.spot.exchange !== route.spotExchange ||
    depth.perpetual.exchange !== route.futuresExchange ||
    depth.identityScope !== route.identityScope ||
    depth.assetId !== route.assetId ||
    depth.spotInstrumentId !== route.spotInstrumentId ||
    depth.futuresInstrumentId !== route.futuresInstrumentId ||
    (route.economicAssetId !== undefined && depth.economicAssetId !== route.economicAssetId)
  ) {
    throw new Error("Arbitrage depth response does not match the selected route");
  }
}

function depthTiming(value: unknown, evaluatedAt: number): ArbitrageDepthTiming {
  const row = record(value, "timing");
  const quality = string(row.quality, "timing.quality");
  if (quality !== "fresh" && quality !== "stale" && quality !== "skewed" && quality !== "unverified") {
    throw new Error("timing.quality is unsupported");
  }
  const parsed: ArbitrageDepthTiming = {
    spot: depthBookTiming(row.spot, "timing.spot"),
    perpetual: depthBookTiming(row.perpetual, "timing.perpetual"),
    ageMs: nonNegativeFinite(row.ageMs, "timing.ageMs"),
    receiveSkewMs: nonNegativeFinite(row.receiveSkewMs, "timing.receiveSkewMs"),
    exchangeSkewMs: row.exchangeSkewMs === undefined ? undefined : nonNegativeFinite(row.exchangeSkewMs, "timing.exchangeSkewMs"),
    legSkewMs: nonNegativeFinite(row.legSkewMs, "timing.legSkewMs"),
    exchangeTimestampsVerified: boolean(row.exchangeTimestampsVerified, "timing.exchangeTimestampsVerified"),
    quality
  };
  assertDepthTimingConsistency(parsed, evaluatedAt);
  return parsed;
}

function assertDepthTimingConsistency(timing: ArbitrageDepthTiming, evaluatedAt: number) {
  const expectedSpotAge = Math.max(0, evaluatedAt - timing.spot.receivedAt, timing.spot.exchangeTs === undefined ? 0 : evaluatedAt - timing.spot.exchangeTs);
  const expectedPerpetualAge = Math.max(0, evaluatedAt - timing.perpetual.receivedAt, timing.perpetual.exchangeTs === undefined ? 0 : evaluatedAt - timing.perpetual.exchangeTs);
  const expectedAge = Math.max(expectedSpotAge, expectedPerpetualAge);
  const expectedReceiveSkew = Math.abs(timing.spot.receivedAt - timing.perpetual.receivedAt);
  const hasBothExchangeTimestamps = timing.spot.exchangeTs !== undefined && timing.perpetual.exchangeTs !== undefined;
  const expectedExchangeSkew = hasBothExchangeTimestamps ? Math.abs((timing.spot.exchangeTs as number) - (timing.perpetual.exchangeTs as number)) : undefined;
  const expectedLegSkew = Math.max(expectedReceiveSkew, expectedExchangeSkew ?? 0);
  const localTimesValid = timing.spot.receivedAt <= evaluatedAt && timing.perpetual.receivedAt <= evaluatedAt;
  const venueTimesPlausible = hasBothExchangeTimestamps && (timing.spot.exchangeTs as number) <= evaluatedAt + 1_000 && (timing.perpetual.exchangeTs as number) <= evaluatedAt + 1_000;
  const expectedQuality = !localTimesValid || !venueTimesPlausible ? "unverified" : expectedAge > 10_000 ? "stale" : expectedLegSkew > 3_000 ? "skewed" : "fresh";
  if (
    timing.spot.ageMs !== expectedSpotAge ||
    timing.perpetual.ageMs !== expectedPerpetualAge ||
    timing.ageMs !== expectedAge ||
    timing.receiveSkewMs !== expectedReceiveSkew ||
    timing.exchangeTimestampsVerified !== hasBothExchangeTimestamps ||
    timing.exchangeSkewMs !== expectedExchangeSkew ||
    timing.legSkewMs !== expectedLegSkew ||
    timing.quality !== expectedQuality
  ) {
    throw new Error("timing fields are inconsistent with the source book timestamps");
  }
}

function depthBookTiming(value: unknown, label: string): ArbitrageDepthBookTiming {
  const row = record(value, label);
  return {
    exchangeTs: row.exchangeTs === undefined ? undefined : positiveFinite(row.exchangeTs, `${label}.exchangeTs`),
    receivedAt: positiveFinite(row.receivedAt, `${label}.receivedAt`),
    ageMs: nonNegativeFinite(row.ageMs, `${label}.ageMs`),
    sequence: row.sequence === undefined ? undefined : positiveSafeInteger(row.sequence, `${label}.sequence`)
  };
}

function depthConstraints(value: unknown): ArbitrageDepthConstraints {
  const row = record(value, "constraints");
  const metadataVerified = boolean(row.metadataVerified, "constraints.metadataVerified");
  const minimumsSatisfied = boolean(row.minimumsSatisfied, "constraints.minimumsSatisfied");
  const verified = boolean(row.verified, "constraints.verified");
  const failures = array(row.failures, "constraints.failures", 32).map((failure, index) => string(failure, `constraints.failures[${index}]`));
  if (verified !== (metadataVerified && minimumsSatisfied && failures.length === 0)) {
    throw new Error("constraints verification fields are inconsistent");
  }
  return { metadataVerified, minimumsSatisfied, verified, failures };
}

function depthDirection(value: unknown): "entry" | "exit" {
  if (value !== "entry" && value !== "exit") throw new Error("direction is unsupported");
  return value;
}

function depthIdentityScope(value: unknown): ArbitrageDepthResponse["identityScope"] {
  if (value !== "venue-native" && value !== "cross-venue-reviewed") throw new Error("identityScope is unsupported");
  return value;
}

function depthLeg(value: unknown, label: string): ArbitrageDepthLeg {
  const row = record(value, label);
  const market = string(row.market, `${label}.market`);
  const side = string(row.side, `${label}.side`);
  if (market !== "spot" && market !== "perpetual") throw new Error(`${label}.market is unsupported`);
  if (side !== "buy" && side !== "sell") throw new Error(`${label}.side is unsupported`);
  return {
    exchange: exchangeId(row.exchange, `${label}.exchange`),
    market,
    side,
    requestedNotionalUsd: finite(row.requestedNotionalUsd, `${label}.requestedNotionalUsd`),
    filledNotionalUsd: finite(row.filledNotionalUsd, `${label}.filledNotionalUsd`),
    quantity: finite(row.quantity, `${label}.quantity`),
    averagePrice: finite(row.averagePrice, `${label}.averagePrice`),
    worstPrice: finite(row.worstPrice, `${label}.worstPrice`),
    topPrice: finite(row.topPrice, `${label}.topPrice`),
    slippageBps: finite(row.slippageBps, `${label}.slippageBps`),
    levelsUsed: finite(row.levelsUsed, `${label}.levelsUsed`),
    complete: boolean(row.complete, `${label}.complete`),
    capturedAt: finite(row.capturedAt, `${label}.capturedAt`)
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} rows`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finite(value, label);
}
function positiveFinite(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}
function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = positiveFinite(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}
function nonNegativeFinite(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, label);
}

function venueTimestamp(value: unknown, verified: boolean, label: string): number | undefined {
  if (value === undefined) {
    if (verified) throw new Error(`${label} is required when its provenance is verified`);
    return undefined;
  }
  const parsed = positiveFinite(value, label);
  if (!verified) throw new Error(`${label} must be omitted when its provenance is unverified`);
  return parsed;
}

function exchangeId(value: unknown, label: string): ArbitrageExchange {
  if (value !== "binance" && value !== "bybit") throw new Error(`${label} is unsupported`);
  return value;
}

function canonicalInstrumentId(value: unknown, exchange: ArbitrageExchange, market: "spot" | "perpetual", symbol: string, label: string): string {
  const parsed = string(value, label);
  if (parsed !== `${exchange}:${market}:${symbol}`) throw new Error(`${label} does not match the route identity`);
  return parsed;
}
