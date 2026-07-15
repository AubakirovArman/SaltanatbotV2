import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { instrumentRegistry, type InstrumentRegistry } from "../../market/instrumentRegistry.js";
import { TriangularArbitrageEngine, buildTriangularGraph } from "../engines/triangular/index.js";
import type { TriangularBookUpdate, TriangularMarketMetadata, TriangularRejection } from "../engines/triangular/index.js";
import { SharedAbortableWork } from "../sharedAbortableWork.js";
import { sequenceVerifiedL2Hub } from "../upstream/l2/index.js";
import type { SequenceVerifiedBookProvider, SequenceVerifiedL2Book } from "../upstream/l2/index.js";
import type { TriangularDepthEvidence, TriangularDepthVerificationRequest, TriangularDepthVerificationResponse } from "./types.js";

const MAX_QUOTE_AGE_MS = 2_000;
const MAX_LEG_SKEW_MS = 500;
const verificationWork = new SharedAbortableWork<string, TriangularDepthVerificationResponse>(4);
let isolatedServiceSequence = 0;

interface ServiceOptions {
  registry?: Pick<InstrumentRegistry, "snapshot">;
  books?: SequenceVerifiedBookProvider;
  now?: () => number;
  maxQuoteAgeMs?: number;
  maxLegSkewMs?: number;
}

export class TriangularDepthVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 422 = 422
  ) {
    super(message);
    this.name = "TriangularDepthVerificationError";
  }
}

/** Verifies one candidate against three current, sequence-reconstructed spot books. */
export class TriangularDepthVerificationService {
  private readonly registry: Pick<InstrumentRegistry, "snapshot">;
  private readonly books: SequenceVerifiedBookProvider;
  private readonly now: () => number;
  private readonly maxQuoteAgeMs: number;
  private readonly maxLegSkewMs: number;
  private readonly scope: string;

  constructor(options: ServiceOptions = {}) {
    this.registry = options.registry ?? instrumentRegistry;
    this.books = options.books ?? sequenceVerifiedL2Hub;
    this.now = options.now ?? Date.now;
    this.maxQuoteAgeMs = boundedDuration(options.maxQuoteAgeMs ?? MAX_QUOTE_AGE_MS, "maxQuoteAgeMs");
    this.maxLegSkewMs = boundedDuration(options.maxLegSkewMs ?? MAX_LEG_SKEW_MS, "maxLegSkewMs");
    this.scope = defaultOptions(options) ? "public-default" : `isolated-${++isolatedServiceSequence}`;
  }

  async verify(request: TriangularDepthVerificationRequest, signal?: AbortSignal): Promise<TriangularDepthVerificationResponse> {
    const normalized = normalizeRequest(request);
    return verificationWork.run(`${this.scope}:${JSON.stringify(normalized)}`, (sharedSignal) => this.verifyOnce(normalized, sharedSignal), signal);
  }

  private async verifyOnce(request: TriangularDepthVerificationRequest, signal?: AbortSignal): Promise<TriangularDepthVerificationResponse> {
    throwIfAborted(signal);
    const snapshot = await abortable(this.registry.snapshot(), signal);
    const selected = selectInstruments(snapshot.verifiedInstruments, request);
    const metadata = selected.map((instrument) => metadataFromInstrument(instrument, request.takerFeeBps));
    const graph = buildTriangularGraph(metadata, new Set([request.startAsset]));
    if (graph.cycles.length === 0) throw new TriangularDepthVerificationError("Selected symbols do not form a triangular cycle for the requested start asset");

    const books = (await Promise.all(request.symbols.map((symbol) => this.books.getBook(request.venue, "spot", symbol, signal)))) as [SequenceVerifiedL2Book, SequenceVerifiedL2Book, SequenceVerifiedL2Book];
    assertCurrentLeases(this.books, books);
    const evaluatedAt = this.now();
    const engine = new TriangularArbitrageEngine(
      metadata,
      {
        startQuantities: { [request.startAsset]: request.startQuantity },
        minNetReturnBps: request.minimumNetReturnBps,
        maxQuoteAgeMs: this.maxQuoteAgeMs,
        maxLegSkewMs: this.maxLegSkewMs,
        now: () => evaluatedAt,
        marketDataMode: "sequence-verified-depth"
      },
      graph
    );
    let rejections: TriangularRejection[] = [];
    for (const book of books) {
      const result = engine.updateBook(toEngineBook(book));
      rejections = result.rejections;
    }
    const opportunities = engine.opportunities();
    assertCurrentLeases(this.books, books);
    return {
      schemaVersion: 1,
      readOnly: true,
      researchOnly: true,
      executable: false,
      execution: "none",
      verificationStatus: "sequence-verified-paper-candidate",
      marketDataMode: "sequence-verified-depth",
      venue: request.venue,
      startAsset: request.startAsset,
      requestedStartQuantity: request.startQuantity,
      symbols: request.symbols,
      evaluatedAt,
      books: books.map(bookEvidence) as [TriangularDepthEvidence, TriangularDepthEvidence, TriangularDepthEvidence],
      totalOpportunities: opportunities.length,
      opportunities,
      rejections: opportunities.length > 0 ? [] : uniqueRejections(rejections)
    };
  }
}

function selectInstruments(instruments: readonly RegistryInstrument[], request: TriangularDepthVerificationRequest) {
  const bySymbol = new Map(instruments.filter((row) => row.venue === request.venue && row.marketType === "spot" && row.status === "trading").map((row) => [row.venueSymbol.toUpperCase(), row]));
  return request.symbols.map((symbol) => {
    const instrument = bySymbol.get(symbol);
    if (!instrument) throw new TriangularDepthVerificationError(`Verified spot metadata is unavailable for ${request.venue}:${symbol}`);
    if (!(instrument.quantityStep > 0 && instrument.minimumQuantity > 0 && instrument.minimumNotional > 0)) {
      throw new TriangularDepthVerificationError(`Trading filters are incomplete for ${request.venue}:${symbol}`);
    }
    return instrument;
  });
}

function metadataFromInstrument(instrument: RegistryInstrument, takerFeeBps: number): TriangularMarketMetadata {
  return {
    marketId: `${instrument.venue}:spot:${instrument.venueSymbol}`,
    venue: instrument.venue,
    symbol: instrument.venueSymbol,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    quantityStep: instrument.quantityStep,
    minimumQuantity: instrument.minimumQuantity,
    minimumNotional: instrument.minimumNotional,
    takerFeeBps
  };
}

function toEngineBook(book: SequenceVerifiedL2Book): TriangularBookUpdate {
  return {
    marketId: `${book.exchange}:spot:${book.symbol}`,
    bids: book.bids,
    asks: book.asks,
    exchangeTs: book.exchangeTs,
    exchangeTimestampVerified: true,
    receivedAt: book.receivedAt,
    complete: true,
    sequence: book.sequence,
    sequenceVerified: true
  };
}

function bookEvidence(book: SequenceVerifiedL2Book): TriangularDepthEvidence {
  if (!book.connectionGeneration) throw new TriangularDepthVerificationError("Depth book has no current connection generation", 409);
  return {
    symbol: book.symbol,
    sequence: book.sequence,
    connectionGeneration: book.connectionGeneration,
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt,
    retainedDepth: book.retainedDepth,
    source: "websocket-reconstructed",
    sequenceVerified: true
  };
}

function assertCurrentLeases(provider: SequenceVerifiedBookProvider, books: readonly SequenceVerifiedL2Book[]) {
  if (books.some((book) => !provider.isCurrent(book))) {
    throw new TriangularDepthVerificationError("A depth stream changed generation during verification; retry with a fresh route", 409);
  }
}

function normalizeRequest(request: TriangularDepthVerificationRequest): TriangularDepthVerificationRequest {
  const symbols = request.symbols.map((symbol) => symbol.trim().toUpperCase()) as [string, string, string];
  if (new Set(symbols).size !== 3) throw new TriangularDepthVerificationError("A triangular route requires three distinct symbols");
  return { ...request, startAsset: request.startAsset.trim().toUpperCase(), symbols };
}

function uniqueRejections(input: readonly TriangularRejection[]) {
  return [...new Map(input.map((row) => [`${row.cycleId ?? ""}:${row.code}:${row.legIndex ?? ""}:${row.marketId ?? ""}`, row])).values()].sort((left, right) => (left.cycleId ?? "").localeCompare(right.cycleId ?? "") || left.code.localeCompare(right.code));
}

function boundedDuration(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error(`${label} must be between 1 and 60000`);
  return value;
}

function defaultOptions(options: ServiceOptions) {
  return options.registry === undefined && options.books === undefined && options.now === undefined && options.maxQuoteAgeMs === undefined && options.maxLegSkewMs === undefined;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
