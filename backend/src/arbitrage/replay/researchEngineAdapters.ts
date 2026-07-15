import { evaluateNLegCycle } from "../engines/nLeg/index.js";
import type { NLegCycle, NLegEvaluationLimits, NLegEvaluationResult, NLegMarketMetadata } from "../engines/nLeg/index.js";
import { evaluateOptionsParity } from "../engines/optionsParity/index.js";
import type { OptionsParityAssumptions, OptionsParityEvaluation, OptionsParityEvaluationLimits, OptionsParityInstrument, OptionsParitySeriesSnapshot, OptionsParityUnderlyingInstrument } from "../engines/optionsParity/index.js";
import type { NativeSpreadInstrument, NativeSpreadOpportunity } from "../nativeSpreads/index.js";
import { assertReplayInstrumentBindings, recordedDepthBooks, recordedSpreadBook } from "./evidenceBooks.js";
import { makeEngineReplayResult, requireEvidence, validateEngineReplayManifest } from "./engineManifest.js";
import type { EngineReplayManifestV1, EngineReplayResult } from "./engineManifest.js";
import type { ReplayDataset } from "./types.js";

export interface NLegReplayInput {
  cycle: NLegCycle;
  markets: NLegMarketMetadata[];
  requestedStartQuantity: number;
  limits?: NLegEvaluationLimits;
}

export interface OptionsReplaySeriesMetadata {
  seriesId: string;
  call?: OptionsParityInstrument;
  put?: OptionsParityInstrument;
}

export interface OptionsParityReplayInput {
  primary: OptionsReplaySeriesMetadata;
  secondary?: OptionsReplaySeriesMetadata;
  underlying: OptionsParityUnderlyingInstrument;
  targetBaseQuantity: number;
  assumptions: OptionsParityAssumptions;
  limits?: OptionsParityEvaluationLimits;
}

export interface NativeSpreadReplayInput {
  instrument: NativeSpreadInstrument;
  minimumQuantity: number;
  maxQuoteAgeMs: number;
  maxFutureClockSkewMs: number;
}

export interface NativeSpreadReplayOutput {
  opportunity?: NativeSpreadOpportunity;
  rejection?: { code: "inactive" | "stale-book" | "future-book" | "invalid-book" | "minimum-quantity"; message: string };
}

export function replayNLegEvaluation(dataset: ReplayDataset, manifest: EngineReplayManifestV1, input: NLegReplayInput): EngineReplayResult<NLegEvaluationResult> {
  if (input.markets.length < 4 || input.markets.length > 8) throw new Error("N-leg replay requires between 4 and 8 exact cycle markets");
  const events = validateEngineReplayManifest(dataset, manifest, "n-leg", input);
  const cycleIds = input.cycle.edges.map((edge) => edge.instrumentId);
  requireEvidence(events, cycleIds);
  if ([...new Set(input.markets.map((market) => market.instrumentId))].sort().join("\u001f") !== [...cycleIds].sort().join("\u001f")) {
    throw new Error("N-leg replay markets must exactly match cycle instruments");
  }
  assertReplayInstrumentBindings(
    dataset,
    manifest.evaluatedAt,
    input.markets.map((market) => ({
      instrumentId: market.instrumentId,
      venue: market.venue,
      symbol: market.symbol,
      marketType: market.marketType,
      quantityStep: market.quantityStep,
      minimumQuantity: market.minimumQuantity,
      minimumNotional: market.minimumNotional
    }))
  );
  const recorded = recordedDepthBooks(events);
  const markets = new Map(input.markets.map((market) => [market.instrumentId, structuredClone(market)]));
  const books = new Map(
    input.markets.map((market) => {
      const book = recorded.get(market.instrumentId)!;
      return [
        market.instrumentId,
        {
          instrumentId: market.instrumentId,
          base: structuredClone(market.base),
          quote: structuredClone(market.quote),
          bids: book.bids,
          asks: book.asks,
          exchangeTs: book.exchangeTs,
          exchangeTimestampVerified: true,
          receivedAt: book.receivedAt,
          complete: true,
          sequence: book.sequence,
          sequenceVerified: true,
          sourceId: book.sourceId
        }
      ];
    })
  );
  const output = evaluateNLegCycle({
    cycle: structuredClone(input.cycle),
    markets,
    books,
    requestedStartQuantity: input.requestedStartQuantity,
    evaluatedAt: manifest.evaluatedAt,
    ...(input.limits ? { limits: structuredClone(input.limits) } : {})
  });
  return makeEngineReplayResult(manifest, output);
}

export function replayOptionsParityEvaluation(dataset: ReplayDataset, manifest: EngineReplayManifestV1, input: OptionsParityReplayInput): EngineReplayResult<OptionsParityEvaluation> {
  const events = validateEngineReplayManifest(dataset, manifest, "options-parity", input);
  const options = optionInstruments(input);
  const instrumentIds = [...options.map((instrument) => instrument.instrumentId), input.underlying.instrumentId];
  requireEvidence(events, instrumentIds);
  assertReplayInstrumentBindings(dataset, manifest.evaluatedAt, [
    ...options.map((instrument) => ({
      instrumentId: instrument.instrumentId,
      venue: instrument.venue,
      marketType: "option",
      quantityStep: instrument.quantityStep,
      minimumQuantity: instrument.minimumQuantity
    })),
    {
      instrumentId: input.underlying.instrumentId,
      venue: input.underlying.venue,
      marketType: "spot",
      quantityStep: input.underlying.quantityStep,
      minimumQuantity: input.underlying.minimumQuantity
    }
  ]);
  const recorded = recordedDepthBooks(events);
  const primary = seriesWithBooks(input.primary, recorded);
  const secondary = input.secondary ? seriesWithBooks(input.secondary, recorded) : undefined;
  const underlyingBook = recorded.get(input.underlying.instrumentId)!;
  const output = evaluateOptionsParity({
    primary,
    ...(secondary ? { secondary } : {}),
    underlying: {
      instrument: structuredClone(input.underlying),
      book: {
        instrumentId: input.underlying.instrumentId,
        bids: underlyingBook.bids,
        asks: underlyingBook.asks,
        exchangeTs: underlyingBook.exchangeTs,
        receivedAt: underlyingBook.receivedAt,
        complete: true
      }
    },
    targetBaseQuantity: input.targetBaseQuantity,
    evaluatedAt: manifest.evaluatedAt,
    assumptions: structuredClone(input.assumptions),
    ...(input.limits ? { limits: structuredClone(input.limits) } : {})
  });
  return makeEngineReplayResult(manifest, output);
}

export function replayNativeSpreadEvaluation(dataset: ReplayDataset, manifest: EngineReplayManifestV1, input: NativeSpreadReplayInput): EngineReplayResult<NativeSpreadReplayOutput> {
  const events = validateEngineReplayManifest(dataset, manifest, "native-spread", input);
  requireEvidence(events, [input.instrument.symbol]);
  assertReplayInstrumentBindings(dataset, manifest.evaluatedAt, [
    {
      instrumentId: input.instrument.symbol,
      venue: "bybit",
      symbol: input.instrument.symbol,
      marketType: "native-spread",
      quantityStep: input.instrument.quantityStep,
      minimumQuantity: input.instrument.minimumQuantity
    }
  ]);
  const sourceEvent = events.get(input.instrument.symbol)!;
  const book = recordedSpreadBook(sourceEvent, input.instrument.symbol);
  const metadataProblem = nativeMetadataProblem(input.instrument);
  if (metadataProblem) throw new Error(metadataProblem);
  const quoteAgeMs = manifest.evaluatedAt - book.exchangeTs;
  let output: NativeSpreadReplayOutput;
  if (input.instrument.status !== "Trading") output = { rejection: { code: "inactive", message: "Native spread was not Trading at evaluatedAt" } };
  else if (!nonNegative(input.maxQuoteAgeMs) || quoteAgeMs > input.maxQuoteAgeMs) output = { rejection: { code: "stale-book", message: `Native spread book is ${quoteAgeMs} ms old` } };
  else if (!nonNegative(input.maxFutureClockSkewMs) || quoteAgeMs < -input.maxFutureClockSkewMs) output = { rejection: { code: "future-book", message: "Native spread exchange timestamp exceeds the future-clock boundary" } };
  else {
    const bid = book.bids[0]!;
    const ask = book.asks[0]!;
    const executableQuantity = floorToStep(Math.min(bid[1], ask[1], input.instrument.maximumQuantity), input.instrument.quantityStep);
    if (executableQuantity < Math.max(input.minimumQuantity, input.instrument.minimumQuantity)) {
      output = { rejection: { code: "minimum-quantity", message: "Native spread visible capacity is below the requested minimum" } };
    } else {
      const bookWidth = ask[0] - bid[0];
      const midpoint = (ask[0] + bid[0]) / 2;
      output = {
        opportunity: {
          ...structuredClone(input.instrument),
          id: `bybit:native-spread:${input.instrument.symbol}`,
          venue: "bybit",
          bidPrice: bid[0],
          bidQuantity: bid[1],
          askPrice: ask[0],
          askQuantity: ask[1],
          bookWidth,
          ...(Math.abs(midpoint) > input.instrument.tickSize ? { relativeBookWidthBps: (bookWidth / Math.abs(midpoint)) * 10_000 } : {}),
          executableQuantity,
          sequence: book.sequence,
          exchangeTs: book.exchangeTs,
          matchingEngineTs: matchingEngineTs(sourceEvent),
          receivedAt: book.receivedAt,
          quoteAgeMs: Math.max(0, quoteAgeMs),
          riskFlags: ["read-only", "depth-replay", "venue-native-combination", "historical-not-executable"]
        }
      };
    }
  }
  return makeEngineReplayResult(manifest, output);
}

function optionInstruments(input: OptionsParityReplayInput): OptionsParityInstrument[] {
  const output = [input.primary.call, input.primary.put, input.secondary?.call, input.secondary?.put].filter((value): value is OptionsParityInstrument => value !== undefined);
  if (output.length < 2 || output.length > 4) throw new Error("options parity replay requires one or two complete option series");
  if (new Set(output.map((value) => value.instrumentId)).size !== output.length) throw new Error("options parity replay contains duplicate instruments");
  return output;
}

function seriesWithBooks(series: OptionsReplaySeriesMetadata, books: ReturnType<typeof recordedDepthBooks>): OptionsParitySeriesSnapshot {
  const leg = (instrument: OptionsParityInstrument | undefined) => {
    if (!instrument) return undefined;
    const book = books.get(instrument.instrumentId)!;
    return {
      instrument: structuredClone(instrument),
      book: { instrumentId: instrument.instrumentId, bids: book.bids, asks: book.asks, exchangeTs: book.exchangeTs, receivedAt: book.receivedAt, complete: true }
    };
  };
  return { seriesId: series.seriesId, ...(series.call ? { call: leg(series.call) } : {}), ...(series.put ? { put: leg(series.put) } : {}) };
}

function nativeMetadataProblem(value: NativeSpreadInstrument): string | undefined {
  if (!value.symbol || value.legs.length !== 2 || !value.baseCoin || !value.quoteCoin || !value.settleCoin) return "Native spread metadata identity is incomplete";
  for (const [field, candidate] of Object.entries({
    tickSize: value.tickSize,
    minimumPrice: value.minimumPrice,
    maximumPrice: value.maximumPrice,
    quantityStep: value.quantityStep,
    minimumQuantity: value.minimumQuantity,
    maximumQuantity: value.maximumQuantity,
    launchTime: value.launchTime
  })) {
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return `Native spread ${field} is invalid`;
  }
  if (value.minimumPrice >= value.maximumPrice || value.minimumQuantity > value.maximumQuantity) return "Native spread metadata bounds are inconsistent";
  return undefined;
}

function matchingEngineTs(event: { payload: unknown; receivedAt: number }) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) throw new Error("Native spread replay payload is invalid");
  const value = (event.payload as Record<string, unknown>).matchingEngineTs;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > event.receivedAt) throw new Error("Native spread replay requires valid matchingEngineTs provenance");
  return value;
}

function nonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function floorToStep(value: number, step: number) {
  const units = Math.floor(value / step + 1e-10);
  return Math.max(0, Number((units * step).toFixed(12)));
}
