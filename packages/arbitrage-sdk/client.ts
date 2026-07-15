import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { parseBasisOpportunityTiming } from "./basisClock.js";
import { parseBasisIdentityCoverage } from "./basisCoverage.js";
import type {
  BasisOpportunity,
  BasisScan,
  InstrumentRegistryResponse,
  NativeSpreadContractType,
  NativeSpreadScan,
  PairwiseEvaluationRequest,
  PairwiseEvaluationResponse,
  PublicVenueDepthResponse,
  PublicVenueFundingResponse,
  PublicVenueInstrumentResponse,
  PublicVenueTickerResponse,
  PublicVenueTopBook,
  TriangularLeg,
  TriangularOpportunity,
  TriangularScan,
  VenueCapabilitiesResponse
} from "./types.js";
import { parseVenueClockHealth, type VenueClockHealth } from "./clockHealth.js";
import { parseContinuousRouteLiveResponse, type ContinuousRouteLiveResponse } from "./continuousRoutes.js";
import { parseContinuousFeedHealthResponse, type ContinuousFeedHealthResponse } from "./continuousFeedHealth.js";
import { parseFundingCurveResponse, parseFundingCurveUniverseResponse } from "./fundingCurve.js";
import type { FundingCurveRequest, FundingCurveResponse, FundingCurveUniverseResponse } from "./fundingCurveTypes.js";
import { parseNativeSpreadScan } from "./nativeSpreads.js";
import { parseNetworkIdentityRegistryResponse, parseNetworkTransferCompatibilityResult } from "./networkIdentity.js";
import type { NetworkIdentityRegistryResponse, NetworkTransferCompatibilityRequest, NetworkTransferCompatibilityResult } from "./networkIdentityTypes.js";
import { parseOptionsParityEvaluation } from "./optionsParity.js";
import type { OptionsParityEvaluationRequest, OptionsParityEvaluationResponse } from "./optionsParityTypes.js";
import { parseLifecycleResponse, type LifecycleQuery, type LifecycleResponse } from "./lifecycle.js";
import { parseNLegResearchResponse } from "./nLeg.js";
import type { NLegResearchRequest, NLegResearchResponse } from "./nLegTypes.js";
import { parseTriangularDepthVerification } from "./triangularDepth.js";
import type { TriangularDepthVerificationRequest, TriangularDepthVerificationResponse } from "./triangularDepthTypes.js";
import { assertPairwiseRequestEconomicIdentity, parsePairwiseEvaluation } from "./pairwise.js";
import { parsePublicVenueDepth, parsePublicVenueFunding, parsePublicVenueInstruments, parsePublicVenueTickers, parsePublicVenueTopBook } from "./publicMarketData.js";
import { parseInstrumentRegistry, parseVenueCapabilities } from "./registry.js";
import { array, bool, exact, finite, integer, nonNegative, optionalFinite, optionalText, positive, record, text } from "./validation.js";

export { parsePublicVenueDepth, parsePublicVenueFunding, parsePublicVenueInstruments, parsePublicVenueTickers, parsePublicVenueTopBook } from "./publicMarketData.js";
export { parseNativeSpreadScan };

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_BASIS_FUTURE_CLOCK_SKEW_MS = 1_000;

export class ArbitrageSdkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: "cancelled" | "timeout" | "http" | "validation" = "http"
  ) {
    super(message);
    this.name = "ArbitrageSdkError";
  }
}

export interface ArbitrageClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

/** Public/read-only SDK. It intentionally contains no credential or order APIs. */
export class SaltanatArbitrageClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(options: ArbitrageClientOptions) {
    this.baseUrl = validBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
  }

  async basis(options: { costBps?: number; minSpreadBps?: number; minCapacityUsd?: number; sort?: "expected-profit" | "net-edge" | "capacity"; limit?: number } = {}, signal: AbortSignal | undefined = undefined): Promise<BasisScan> {
    return parseBasisScan(await this.get("/api/arbitrage", options, signal));
  }

  async triangular(options: { venue: "binance" | "bybit"; startAsset: string; startQuantity: number; takerFeeBps?: number; minimumNetReturnBps?: number; limit?: number }, signal?: AbortSignal): Promise<TriangularScan> {
    return parseTriangularScan(await this.get("/api/arbitrage/triangular", options, signal));
  }

  async verifyTriangularDepth(request: TriangularDepthVerificationRequest, signal?: AbortSignal): Promise<TriangularDepthVerificationResponse> {
    return parseTriangularDepthVerification(await this.post("/api/arbitrage/triangular/verify-depth", request, signal));
  }

  async nativeSpreads(options: { contractType?: NativeSpreadContractType; baseCoin?: string; minimumQuantity?: number; sort?: "capacity" | "tightness" | "freshness"; maxCandidates?: number; limit?: number } = {}, signal: AbortSignal | undefined = undefined): Promise<NativeSpreadScan> {
    return parseNativeSpreadScan(await this.get("/api/arbitrage/native-spreads", options, signal));
  }

  async optionsParity(request: OptionsParityEvaluationRequest, signal?: AbortSignal): Promise<OptionsParityEvaluationResponse> {
    return parseOptionsParityEvaluation(await this.post("/api/arbitrage/options-parity/evaluate", request, signal));
  }

  async pairwise(request: PairwiseEvaluationRequest, signal?: AbortSignal): Promise<PairwiseEvaluationResponse> {
    try {
      assertPairwiseRequestEconomicIdentity(request);
    } catch (error) {
      throw new ArbitrageSdkError(error instanceof Error ? error.message : "pairwise request identity is invalid", undefined, "validation");
    }
    return parsePairwiseEvaluation(await this.post("/api/arbitrage/pairwise/evaluate", request, signal));
  }

  async instruments(
    options: {
      venue?: string;
      marketType?: RegistryInstrument["marketType"];
      symbol?: string;
      assetId?: string;
      status?: RegistryInstrument["status"];
      includeStale?: boolean;
      limit?: number;
    } = {},
    signal: AbortSignal | undefined = undefined
  ): Promise<InstrumentRegistryResponse> {
    return parseInstrumentRegistry(await this.get("/api/instruments", options, signal));
  }

  async venues(signal?: AbortSignal): Promise<VenueCapabilitiesResponse> {
    return parseVenueCapabilities(await this.get("/api/venues", {}, signal));
  }

  async networkIdentityRegistry(signal?: AbortSignal): Promise<NetworkIdentityRegistryResponse> {
    return parseNetworkIdentityRegistryResponse(await this.get("/api/network-identity/registry", {}, signal));
  }

  async networkTransferPreflight(request: NetworkTransferCompatibilityRequest, signal?: AbortSignal): Promise<NetworkTransferCompatibilityResult> {
    return parseNetworkTransferCompatibilityResult(await this.post("/api/network-identity/preflight", request, signal));
  }

  async clockHealth(signal?: AbortSignal): Promise<VenueClockHealth> {
    return parseVenueClockHealth(await this.get("/api/arbitrage/clock-health", {}, signal));
  }

  async lifecycle(options?: LifecycleQuery, signal?: AbortSignal): Promise<LifecycleResponse> {
    return parseLifecycleResponse(await this.get("/api/arbitrage/lifecycle", { ...(options ?? {}) }, signal));
  }

  async continuousRoutes(signal?: AbortSignal): Promise<ContinuousRouteLiveResponse> {
    return parseContinuousRouteLiveResponse(await this.get("/api/arbitrage/route-families/live", {}, signal));
  }
  async continuousFeedHealth(signal?: AbortSignal): Promise<ContinuousFeedHealthResponse> {
    return parseContinuousFeedHealthResponse(await this.get("/api/arbitrage/continuous-feed-health", {}, signal));
  }
  async nLeg(request: NLegResearchRequest, signal?: AbortSignal): Promise<NLegResearchResponse> {
    return parseNLegResearchResponse(await this.post("/api/arbitrage/n-leg/evaluate", request, signal));
  }
  async fundingCurve(request: FundingCurveRequest, signal?: AbortSignal): Promise<FundingCurveResponse> {
    return parseFundingCurveResponse(await this.post("/api/arbitrage/funding-curve", request, signal));
  }
  async fundingCurveUniverse(signal?: AbortSignal): Promise<FundingCurveUniverseResponse> {
    return parseFundingCurveUniverseResponse(await this.get("/api/arbitrage/funding-curve/universe", {}, signal));
  }
  async venueInstruments(venue: string, options: { marketType: PublicVenueInstrumentResponse["marketType"]; status?: string; assetId?: string; limit?: number }, signal?: AbortSignal): Promise<PublicVenueInstrumentResponse> {
    return parsePublicVenueInstruments(await this.get(`/api/market-data/${venuePath(venue)}/instruments`, options, signal));
  }

  async venueTickers(venue: string, options: { marketType: PublicVenueTickerResponse["marketType"]; limit?: number }, signal?: AbortSignal): Promise<PublicVenueTickerResponse> {
    return parsePublicVenueTickers(await this.get(`/api/market-data/${venuePath(venue)}/tickers`, options, signal));
  }

  async venueTicker(venue: string, options: { marketType: PublicVenueTopBook["marketType"]; instrumentId: string }, signal?: AbortSignal): Promise<PublicVenueTopBook & { readOnly: true }> {
    return parsePublicVenueTopBook(await this.get(`/api/market-data/${venuePath(venue)}/ticker`, options, signal), true) as PublicVenueTopBook & { readOnly: true };
  }

  async venueDepth(venue: string, options: { marketType: PublicVenueDepthResponse["marketType"]; instrumentId: string; limit?: number }, signal?: AbortSignal): Promise<PublicVenueDepthResponse> {
    return parsePublicVenueDepth(await this.get(`/api/market-data/${venuePath(venue)}/depth`, options, signal));
  }

  async venueFunding(venue: string, options: { marketType: PublicVenueFundingResponse["marketType"]; instrumentId: string; historyLimit?: number }, signal?: AbortSignal): Promise<PublicVenueFundingResponse> {
    return parsePublicVenueFunding(await this.get(`/api/market-data/${venuePath(venue)}/funding`, options, signal));
  }

  private get(path: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.request(url, { method: "GET", headers: { Accept: "application/json" } }, signal);
  }

  private post(path: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    let body: string | undefined;
    try {
      body = JSON.stringify(value);
    } catch {
      throw new ArbitrageSdkError("request is not valid JSON", undefined, "validation");
    }
    if (body === undefined) throw new ArbitrageSdkError("request is not valid JSON", undefined, "validation");
    if (new TextEncoder().encode(body).byteLength > this.maxPayloadBytes) {
      throw new ArbitrageSdkError("request is too large", undefined, "validation");
    }
    return this.request(new URL(path, this.baseUrl), { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body }, signal);
  }

  private async request(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ArbitrageSdkError("request cancelled", undefined, "cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      const body = await readBoundedResponseText(response, this.maxPayloadBytes);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw new ArbitrageSdkError("response is not valid JSON", response.status, "validation");
      }
      if (!response.ok) {
        const error = value && typeof value === "object" && !Array.isArray(value) && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : `HTTP ${response.status}`;
        throw new ArbitrageSdkError(error, response.status, "http");
      }
      return value;
    } catch (error) {
      if (error instanceof ArbitrageSdkError) throw error;
      if (signal?.aborted) throw new ArbitrageSdkError("request cancelled", undefined, "cancelled");
      if (timedOut) throw new ArbitrageSdkError(`request exceeded ${this.timeoutMs}ms`, undefined, "timeout");
      throw new ArbitrageSdkError(error instanceof Error ? error.message : "network request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new ArbitrageSdkError("response is too large", response.status, "validation");
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function parseBasisScan(value: unknown): BasisScan {
  const row = record(value, "basis scan");
  const updatedAt = positiveSafeTimestamp(row.updatedAt, "updatedAt");
  const stale = bool(row.stale, "stale");
  const identityCoverage = parseBasisIdentityCoverage(row.identityCoverage);
  const estimatedTotalCostBps = nonNegative(row.estimatedTotalCostBps, "estimatedTotalCostBps");
  const rawOpportunities = array(row.opportunities, "opportunities", 10_000);
  const sources = array(row.sources, "sources", 100).map((value, index) => {
    const source = record(value, `sources[${index}]`);
    const message = optionalText(source.message, `sources[${index}].message`);
    return {
      exchange: exact(source.exchange, ["binance", "bybit"] as const, `sources[${index}].exchange`),
      market: exact(source.market, ["spot", "perpetual"] as const, `sources[${index}].market`),
      ok: bool(source.ok, `sources[${index}].ok`),
      ...(message ? { message } : {})
    };
  });
  assertUnique(
    sources.map((source) => `${source.exchange}:${source.market}`),
    "basis source keys"
  );
  if (sources.some((source) => !source.ok) && !stale) throw new Error("basis stale flag must cover unhealthy sources");
  const opportunities = rawOpportunities.map((opportunity) => parseBasisOpportunity(opportunity, stale, sources));
  assertUnique(
    opportunities.map((opportunity) => opportunity.id),
    "basis opportunity IDs"
  );
  const totalOpportunities = integer(row.totalOpportunities, "totalOpportunities");
  const truncated = bool(row.truncated, "truncated");
  const scannedSymbols = integer(row.scannedSymbols, "scannedSymbols");
  if (totalOpportunities < opportunities.length) throw new Error("basis totalOpportunities cannot be smaller than returned rows");
  if (truncated !== totalOpportunities > opportunities.length) throw new Error("basis truncated must match totalOpportunities and returned rows");
  const returnedSymbols = new Set(opportunities.map((opportunity) => opportunity.symbol)).size;
  if (scannedSymbols < returnedSymbols || scannedSymbols > totalOpportunities || (!truncated && scannedSymbols !== returnedSymbols)) {
    throw new Error("basis scannedSymbols is inconsistent with opportunity counts");
  }
  for (const opportunity of opportunities) {
    assertApproximately(opportunity.estimatedTotalCostBps, estimatedTotalCostBps, "estimatedTotalCostBps envelope");
    if (opportunity.capturedAt < updatedAt) throw new Error("basis opportunity capturedAt cannot precede scan updatedAt");
  }
  return {
    updatedAt,
    stale,
    scannedSymbols,
    totalOpportunities,
    truncated,
    estimatedTotalCostBps,
    opportunities,
    sources,
    ...(identityCoverage ? { identityCoverage } : {})
  };
}

function parseBasisOpportunity(value: unknown, scanStale: boolean, sources: BasisScan["sources"]): BasisOpportunity {
  const row = record(value, "basis opportunity");
  const nextFundingTime = optionalFinite(row.nextFundingTime, "nextFundingTime");
  const fundingIntervalMinutes = optionalFinite(row.fundingIntervalMinutes, "fundingIntervalMinutes");
  const symbol = text(row.symbol, "symbol");
  const assetId = economicAssetId(row.assetId, "assetId");
  const identityScope = exact(row.identityScope, ["venue-native", "cross-venue-reviewed"] as const, "identityScope");
  const spotExchange = exact(row.spotExchange, ["binance", "bybit"] as const, "spotExchange");
  const futuresExchange = exact(row.futuresExchange, ["binance", "bybit"] as const, "futuresExchange");
  assertBasisIdentity(identityScope, assetId, spotExchange, futuresExchange);
  const spotInstrumentId = basisInstrumentId(row.spotInstrumentId, spotExchange, "spot", symbol, "spotInstrumentId");
  const futuresInstrumentId = basisInstrumentId(row.futuresInstrumentId, futuresExchange, "perpetual", symbol, "futuresInstrumentId");
  const spotBid = positive(row.spotBid, "spotBid");
  const spotAsk = positive(row.spotAsk, "spotAsk");
  const futuresBid = positive(row.futuresBid, "futuresBid");
  const futuresAsk = positive(row.futuresAsk, "futuresAsk");
  if (spotBid >= spotAsk) throw new Error("spot top book must have bid below ask");
  if (futuresBid >= futuresAsk) throw new Error("futures top book must have bid below ask");
  const spotAskSize = positive(row.spotAskSize, "spotAskSize");
  const futuresBidSize = positive(row.futuresBidSize, "futuresBidSize");
  const grossSpreadBps = finite(row.grossSpreadBps, "grossSpreadBps");
  const estimatedTotalCostBps = nonNegative(row.estimatedTotalCostBps, "estimatedTotalCostBps");
  const netEdgeBps = finite(row.netEdgeBps, "netEdgeBps");
  const topBookMatchedQuantity = nonNegative(row.topBookMatchedQuantity, "topBookMatchedQuantity");
  const topBookCapacityUsd = nonNegative(row.topBookCapacityUsd, "topBookCapacityUsd");
  const expectedNetProfitUsd = finite(row.expectedNetProfitUsd, "expectedNetProfitUsd");
  const expectedGrossSpreadBps = (futuresBid / spotAsk - 1) * 10_000;
  const expectedMatchedQuantity = Math.min(spotAskSize, futuresBidSize);
  const expectedCapacityUsd = spotAsk * expectedMatchedQuantity;
  assertApproximately(grossSpreadBps, expectedGrossSpreadBps, "grossSpreadBps");
  assertApproximately(netEdgeBps, grossSpreadBps - estimatedTotalCostBps, "netEdgeBps");
  assertApproximately(topBookMatchedQuantity, expectedMatchedQuantity, "topBookMatchedQuantity");
  assertApproximately(topBookCapacityUsd, expectedCapacityUsd, "topBookCapacityUsd");
  assertApproximately(expectedNetProfitUsd, (topBookCapacityUsd * netEdgeBps) / 10_000, "expectedNetProfitUsd");

  const capturedAt = positiveSafeTimestamp(row.capturedAt, "capturedAt");
  const spotReceivedAt = positiveSafeTimestamp(row.spotReceivedAt, "spotReceivedAt");
  const futuresReceivedAt = positiveSafeTimestamp(row.futuresReceivedAt, "futuresReceivedAt");
  if (spotReceivedAt > capturedAt || futuresReceivedAt > capturedAt) throw new Error("basis receive timestamp cannot be in the future");
  const spotExchangeTimestampVerified = bool(row.spotExchangeTimestampVerified, "spotExchangeTimestampVerified");
  const clockCorrected = row.clockCorrection !== undefined;
  const spotExchangeTs = verifiedTimestamp(row.spotExchangeTs, spotExchangeTimestampVerified, "spot", capturedAt, clockCorrected);
  const futuresExchangeTimestampVerified = bool(row.futuresExchangeTimestampVerified, "futuresExchangeTimestampVerified");
  const futuresExchangeTs = verifiedTimestamp(row.futuresExchangeTs, futuresExchangeTimestampVerified, "futures", capturedAt, clockCorrected);
  const quoteAgeMs = safeNonNegativeInteger(row.quoteAgeMs, "quoteAgeMs");
  const legSkewMs = safeNonNegativeInteger(row.legSkewMs, "legSkewMs");
  const timing = parseBasisOpportunityTiming({ correction: row.clockCorrection, capturedAt, spotExchange, futuresExchange, spotExchangeTs, futuresExchangeTs, spotReceivedAt, futuresReceivedAt, quoteAgeMs, legSkewMs });
  const measuredQuality = timing.measuredQuality;
  const dataQuality = exact(row.dataQuality, ["fresh", "stale", "skewed", "unverified"] as const, "dataQuality");
  const dependencyHealthy = basisSourceHealthy(sources, spotExchange, "spot") && basisSourceHealthy(sources, futuresExchange, "perpetual");
  const serverMarkedCachedSnapshot = scanStale && measuredQuality === "fresh" && dataQuality === "stale";
  if (dataQuality !== measuredQuality && !serverMarkedCachedSnapshot) {
    throw new Error("basis dataQuality is inconsistent with receive timestamps");
  }
  if (!dependencyHealthy && dataQuality !== "stale") throw new Error("basis route depends on an unhealthy source but is not marked stale");
  const expectedId = `${symbol}:${spotExchange}:${futuresExchange}`;
  const routeId = text(row.id, "id");
  if (routeId !== expectedId) throw new Error("basis opportunity id does not match its ordered route");
  return {
    id: routeId,
    strategyKind: exact(row.strategyKind, ["cash-and-carry"] as const, "strategyKind"),
    edgeKind: exact(row.edgeKind, ["projected"] as const, "edgeKind"),
    identityScope,
    symbol,
    assetId,
    spotInstrumentId,
    futuresInstrumentId,
    spotExchange,
    futuresExchange,
    spotBid,
    spotAsk,
    spotAskSize,
    futuresBid,
    futuresAsk,
    futuresBidSize,
    grossSpreadBps,
    estimatedTotalCostBps,
    netEdgeBps,
    topBookCapacityUsd,
    topBookMatchedQuantity,
    expectedNetProfitUsd,
    fundingRate: finite(row.fundingRate, "fundingRate"),
    fundingScheduleVerified: bool(row.fundingScheduleVerified, "fundingScheduleVerified"),
    ...(nextFundingTime === undefined ? {} : { nextFundingTime }),
    ...(fundingIntervalMinutes === undefined ? {} : { fundingIntervalMinutes }),
    ...(spotExchangeTs === undefined ? {} : { spotExchangeTs }),
    spotExchangeTimestampVerified,
    spotReceivedAt,
    ...(futuresExchangeTs === undefined ? {} : { futuresExchangeTs }),
    futuresExchangeTimestampVerified,
    futuresReceivedAt,
    quoteAgeMs,
    legSkewMs,
    dataQuality,
    ...(timing.clockCorrection ? { clockCorrection: timing.clockCorrection } : {}),
    capturedAt
  };
}

export function parseTriangularScan(value: unknown): TriangularScan {
  const row = record(value, "triangular scan");
  if (row.snapshotSource !== "rest-snapshot") throw new Error("triangular snapshotSource must be rest-snapshot");
  if (row.executionStatus !== "non-executable-candidate") throw new Error("triangular REST scan must be non-executable");
  if (row.sequenceVerified !== false) throw new Error("triangular REST scan cannot be sequence verified");
  return {
    updatedAt: positive(row.updatedAt, "updatedAt"),
    venue: exact(row.venue, ["binance", "bybit"] as const, "venue"),
    startAsset: text(row.startAsset, "startAsset"),
    requestedStartQuantity: positive(row.requestedStartQuantity, "requestedStartQuantity"),
    scannedMarkets: integer(row.scannedMarkets, "scannedMarkets"),
    scannedCycles: integer(row.scannedCycles, "scannedCycles"),
    totalOpportunities: integer(row.totalOpportunities, "totalOpportunities"),
    truncated: bool(row.truncated, "truncated"),
    marketDataMode: exact(row.marketDataMode, ["rest-top-book"] as const, "marketDataMode"),
    snapshotSource: "rest-snapshot",
    executionStatus: "non-executable-candidate",
    sequenceVerified: false,
    opportunities: array(row.opportunities, "opportunities", 250).map(parseTriangularOpportunity)
  };
}

function parseTriangularOpportunity(value: unknown): TriangularOpportunity {
  const row = record(value, "triangular opportunity");
  const rawLegs = array(row.legs, "legs", 3);
  if (rawLegs.length !== 3) throw new Error("triangular opportunity requires three legs");
  const capacity = record(row.limitingCapacity, "limitingCapacity");
  const timestamps = record(row.timestamps, "timestamps");
  const riskFlags = array(row.riskFlags, "riskFlags", 20).map((flag) => text(flag, "riskFlag"));
  if (row.edgeKind !== "non-executable-candidate" || row.executionStatus !== "non-executable-candidate" || row.marketDataMode !== "rest-top-book" || row.sequenceVerified !== false) {
    throw new Error("triangular REST opportunity must be an unsequenced non-executable candidate");
  }
  for (const required of ["top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]) if (!riskFlags.includes(required)) throw new Error(`triangular opportunity is missing ${required} provenance`);
  return {
    id: text(row.id, "id"),
    edgeKind: "non-executable-candidate",
    executionStatus: "non-executable-candidate",
    marketDataMode: "rest-top-book",
    sequenceVerified: false,
    venue: exact(row.venue, ["binance", "bybit"] as const, "venue"),
    startAsset: text(row.startAsset, "startAsset"),
    startQuantity: positive(row.startQuantity, "startQuantity"),
    endQuantity: nonNegative(row.endQuantity, "endQuantity"),
    grossReturnBps: finite(row.grossReturnBps, "grossReturnBps"),
    netReturnBps: finite(row.netReturnBps, "netReturnBps"),
    limitingCapacity: { requestedStartQuantity: positive(capacity.requestedStartQuantity, "requestedStartQuantity"), executableStartQuantity: nonNegative(capacity.executableStartQuantity, "executableStartQuantity"), utilizationPct: nonNegative(capacity.utilizationPct, "utilizationPct") },
    legs: rawLegs.map((leg, index) => parseTriangularLeg(leg, index)) as [TriangularLeg, TriangularLeg, TriangularLeg],
    timestamps: { evaluatedAt: positive(timestamps.evaluatedAt, "evaluatedAt"), quoteAgeMs: nonNegative(timestamps.quoteAgeMs, "quoteAgeMs"), legSkewMs: nonNegative(timestamps.legSkewMs, "legSkewMs"), exchangeTimestampsVerified: bool(timestamps.exchangeTimestampsVerified, "exchangeTimestampsVerified") },
    riskFlags
  };
}

function parseTriangularLeg(value: unknown, index: number): TriangularLeg {
  const row = record(value, "triangular leg");
  const wireIndex = integer(row.index, `leg[${index}].index`);
  if (wireIndex > 2) throw new Error(`leg[${index}].index is unsupported`);
  if (wireIndex !== index) throw new Error(`leg[${index}].index must preserve the ordered 0,1,2 route`);
  return {
    index: wireIndex as 0 | 1 | 2,
    symbol: text(row.symbol, "symbol"),
    side: exact(row.side, ["buy", "sell"] as const, "side"),
    fromAsset: text(row.fromAsset, "fromAsset"),
    toAsset: text(row.toAsset, "toAsset"),
    inputQuantity: nonNegative(row.inputQuantity, "inputQuantity"),
    outputQuantity: nonNegative(row.outputQuantity, "outputQuantity"),
    averagePrice: positive(row.averagePrice, "averagePrice"),
    feeBps: nonNegative(row.feeBps, "feeBps"),
    levelsUsed: integer(row.levelsUsed, "levelsUsed")
  };
}

function economicAssetId(value: unknown, label: string) {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error(`${label} is unsupported`);
  return result;
}

function assertBasisIdentity(identityScope: BasisOpportunity["identityScope"], assetId: string, spotExchange: BasisOpportunity["spotExchange"], futuresExchange: BasisOpportunity["futuresExchange"]) {
  if (spotExchange === futuresExchange) {
    if (identityScope !== "venue-native" || !assetId.startsWith(`${spotExchange}:`)) {
      throw new Error("identityScope does not match same-venue identity");
    }
    return;
  }
  if (identityScope !== "cross-venue-reviewed" || (assetId !== "crypto:bitcoin" && assetId !== "crypto:ethereum")) {
    throw new Error("identityScope does not match reviewed cross-venue identity");
  }
}

function basisInstrumentId(value: unknown, exchange: BasisOpportunity["spotExchange"], market: "spot" | "perpetual", symbol: string, label: string) {
  const parsed = text(value, label);
  if (parsed !== `${exchange}:${market}:${symbol}`) throw new Error(`${label} does not match the route identity`);
  return parsed;
}

function verifiedTimestamp(timestamp: unknown, verified: boolean, leg: "spot" | "futures", evaluatedAt: number, clockCorrected = false): number | undefined {
  if (timestamp === undefined) {
    if (verified) throw new Error(`${leg}ExchangeTs is required when exchange timestamp is verified`);
    return undefined;
  }
  const value = positiveSafeTimestamp(timestamp, `${leg}ExchangeTs`);
  if (!verified) throw new Error(`${leg}ExchangeTs must be omitted when exchange timestamp is unverified`);
  if (!clockCorrected && value > evaluatedAt + MAX_BASIS_FUTURE_CLOCK_SKEW_MS) throw new Error(`${leg}ExchangeTs exceeds the future-clock safety boundary`);
  return value;
}

function basisSourceHealthy(sources: BasisScan["sources"], exchange: BasisOpportunity["spotExchange"], market: "spot" | "perpetual") {
  const source = sources.find((candidate) => candidate.exchange === exchange && candidate.market === market);
  if (!source) throw new Error(`basis route is missing source status for ${exchange}:${market}`);
  return source.ok;
}

function assertApproximately(actual: number, expected: number, label: string) {
  const tolerance = 1e-8 * Math.max(1, Math.abs(expected));
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${label} is inconsistent with executable prices and sizes`);
}

function positiveSafeTimestamp(value: unknown, label: string) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function safeNonNegativeInteger(value: unknown, label: string) {
  return integer(value, label);
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function validBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("baseUrl cannot contain credentials, query or fragment");
  return url;
}
function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function venuePath(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(normalized)) throw new Error("venue is unsupported");
  return normalized;
}
