import { buildTriangularGraph, evaluateTriangularCycle } from "../engines/triangular/index.js";
import type { TriangularMarketMetadata, TriangularOpportunity, TriangularRejection } from "../engines/triangular/index.js";
import { evaluatePairwiseRoute, pairwiseOpportunityOrder, validatePairwiseInstrument } from "../engines/pairwise/index.js";
import type { PairwiseEngineOptions, PairwiseInstrument, PairwiseOpportunity, PairwiseRejection, PairwiseRoute } from "../engines/pairwise/index.js";
import { assertReplayInstrumentBindings, recordedDepthBooks } from "./evidenceBooks.js";
import { makeEngineReplayResult, requireEvidence, validateEngineReplayManifest } from "./engineManifest.js";
import type { EngineReplayManifestV1, EngineReplayResult } from "./engineManifest.js";
import type { ReplayDataset } from "./types.js";

const MAX_ROUTE_REPLAY_MARKETS = 64;
const MAX_TRIANGULAR_REPLAY_CYCLES = 1_024;
const MAX_PAIRWISE_REPLAY_ROUTES = 256;

export interface TriangularReplayInput {
  markets: TriangularMarketMetadata[];
  startQuantities: Record<string, number>;
  minNetReturnBps: number;
  maxQuoteAgeMs: number;
  maxLegSkewMs: number;
  maxFutureClockSkewMs: number;
  depthSearchIterations: number;
}

export interface TriangularReplayOutput {
  cycleCount: number;
  opportunities: TriangularOpportunity[];
  rejections: TriangularRejection[];
}

export interface PairwiseReplayInput {
  instruments: PairwiseInstrument[];
  routes: PairwiseRoute[];
  evaluation: Required<Omit<PairwiseEngineOptions, "now">>;
}

export interface PairwiseReplayOutput {
  routeCount: number;
  opportunities: PairwiseOpportunity[];
  rejections: PairwiseRejection[];
}

export function replayTriangularEvaluation(dataset: ReplayDataset, manifest: EngineReplayManifestV1, input: TriangularReplayInput): EngineReplayResult<TriangularReplayOutput> {
  bounds(input.markets.length, 3, MAX_ROUTE_REPLAY_MARKETS, "triangular markets");
  const events = validateEngineReplayManifest(dataset, manifest, "triangular", input);
  const marketIds = input.markets.map((market) => market.marketId);
  requireEvidence(events, marketIds);
  assertReplayInstrumentBindings(
    dataset,
    manifest.evaluatedAt,
    input.markets.map((market) => ({
      instrumentId: market.marketId,
      venue: market.venue,
      symbol: market.symbol,
      marketType: "spot",
      quantityStep: market.quantityStep,
      minimumQuantity: market.minimumQuantity,
      minimumNotional: market.minimumNotional
    }))
  );
  const graph = buildTriangularGraph(input.markets, new Set(Object.keys(input.startQuantities)));
  if (graph.metadataRejections.length > 0) throw new Error(`triangular replay metadata rejected: ${graph.metadataRejections[0]!.message}`);
  if (graph.cycles.length > MAX_TRIANGULAR_REPLAY_CYCLES) throw new Error(`triangular replay exceeds ${MAX_TRIANGULAR_REPLAY_CYCLES} cycles`);
  const recorded = recordedDepthBooks(events);
  const books = new Map(
    [...recorded].map(([instrumentId, book]) => [
      instrumentId,
      {
        marketId: instrumentId,
        bids: book.bids,
        asks: book.asks,
        exchangeTs: book.exchangeTs,
        exchangeTimestampVerified: true,
        receivedAt: book.receivedAt,
        complete: true,
        sequence: book.sequence,
        sequenceVerified: true
      }
    ])
  );
  const opportunities: TriangularOpportunity[] = [];
  const rejections: TriangularRejection[] = [];
  for (const cycle of graph.cycles) {
    const result = evaluateTriangularCycle(cycle, graph.markets, books, {
      requestedStartQuantity: input.startQuantities[cycle.startAsset] ?? 0,
      minNetReturnBps: input.minNetReturnBps,
      maxQuoteAgeMs: input.maxQuoteAgeMs,
      maxLegSkewMs: input.maxLegSkewMs,
      maxFutureClockSkewMs: input.maxFutureClockSkewMs,
      evaluatedAt: manifest.evaluatedAt,
      depthSearchIterations: boundedInteger(input.depthSearchIterations, 8, 80, "depthSearchIterations"),
      marketDataMode: "sequence-verified-depth"
    });
    if (result.opportunity) opportunities.push(result.opportunity);
    else rejections.push(result.rejection);
  }
  opportunities.sort((left, right) => right.netReturnBps - left.netReturnBps || left.id.localeCompare(right.id));
  rejections.sort((left, right) => (left.cycleId ?? "").localeCompare(right.cycleId ?? "") || left.code.localeCompare(right.code));
  return makeEngineReplayResult(manifest, { cycleCount: graph.cycles.length, opportunities, rejections });
}

export function replayPairwiseEvaluation(dataset: ReplayDataset, manifest: EngineReplayManifestV1, input: PairwiseReplayInput): EngineReplayResult<PairwiseReplayOutput> {
  bounds(input.instruments.length, 2, MAX_ROUTE_REPLAY_MARKETS, "pairwise instruments");
  bounds(input.routes.length, 1, MAX_PAIRWISE_REPLAY_ROUTES, "pairwise routes");
  const events = validateEngineReplayManifest(dataset, manifest, "pairwise", input);
  const instrumentIds = input.instruments.map((instrument) => instrument.instrumentId);
  requireEvidence(events, instrumentIds);
  const instruments = new Map<string, PairwiseInstrument>();
  for (const instrument of input.instruments) {
    const problem = validatePairwiseInstrument(instrument);
    if (problem) throw new Error(`pairwise replay instrument ${instrument.instrumentId} is invalid: ${problem}`);
    if (instruments.has(instrument.instrumentId)) throw new Error(`duplicate pairwise replay instrument ${instrument.instrumentId}`);
    instruments.set(instrument.instrumentId, structuredClone(instrument));
  }
  assertReplayInstrumentBindings(
    dataset,
    manifest.evaluatedAt,
    input.instruments.map((instrument) => ({
      instrumentId: instrument.instrumentId,
      venue: instrument.venue,
      symbol: instrument.symbol,
      marketType: instrument.marketType,
      economicAssetId: instrument.economicAssetId,
      quantityStep: instrument.quantityStep,
      minimumQuantity: instrument.minimumQuantity,
      minimumNotional: instrument.minimumNotional
    }))
  );
  const recorded = recordedDepthBooks(events);
  const books = new Map(
    input.instruments.map((instrument) => {
      const book = recorded.get(instrument.instrumentId)!;
      return [
        instrument.instrumentId,
        {
          instrumentId: instrument.instrumentId,
          quantityUnit: instrument.quantityModel.unit,
          bids: book.bids,
          asks: book.asks,
          exchangeTs: book.exchangeTs,
          receivedAt: book.receivedAt,
          complete: true,
          sequence: book.sequence,
          source: "fixture" as const,
          sourceId: book.sourceId
        }
      ];
    })
  );
  const routeIds = new Set<string>();
  const opportunities: PairwiseOpportunity[] = [];
  const rejections: PairwiseRejection[] = [];
  for (const route of [...input.routes].sort((left, right) => left.routeId.localeCompare(right.routeId))) {
    if (!route.routeId || routeIds.has(route.routeId)) throw new Error(`duplicate or empty pairwise replay route ${route.routeId}`);
    routeIds.add(route.routeId);
    if (!instruments.has(route.longInstrumentId) || !instruments.has(route.shortInstrumentId)) throw new Error(`pairwise replay route ${route.routeId} references missing instrument evidence`);
    const result = evaluatePairwiseRoute(route, instruments, books, {
      evaluatedAt: manifest.evaluatedAt,
      minNetReturnBps: finite(input.evaluation.minNetReturnBps, "minNetReturnBps"),
      maxQuoteAgeMs: nonNegative(input.evaluation.maxQuoteAgeMs, "maxQuoteAgeMs"),
      maxLegSkewMs: nonNegative(input.evaluation.maxLegSkewMs, "maxLegSkewMs"),
      maxFutureClockSkewMs: nonNegative(input.evaluation.maxFutureClockSkewMs, "maxFutureClockSkewMs"),
      maxAssumptionAgeMs: nonNegative(input.evaluation.maxAssumptionAgeMs, "maxAssumptionAgeMs"),
      maxEconomicIdentityAgeMs: nonNegative(input.evaluation.maxEconomicIdentityAgeMs, "maxEconomicIdentityAgeMs"),
      maxResidualDeltaBps: nonNegative(input.evaluation.maxResidualDeltaBps, "maxResidualDeltaBps"),
      pairingIterations: boundedInteger(input.evaluation.pairingIterations, 4, 64, "pairingIterations")
    });
    if (result.opportunity) opportunities.push(result.opportunity);
    else rejections.push(result.rejection);
  }
  opportunities.sort(pairwiseOpportunityOrder);
  rejections.sort((left, right) => (left.routeId ?? "").localeCompare(right.routeId ?? "") || left.code.localeCompare(right.code));
  return makeEngineReplayResult(manifest, { routeCount: input.routes.length, opportunities, rejections });
}

function bounds(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}
