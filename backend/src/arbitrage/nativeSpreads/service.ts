import { BybitSpreadAdapter } from "./bybit.js";
import { SharedAbortableWork, throwIfAborted } from "../sharedAbortableWork.js";
import type { NativeSpreadContractType, NativeSpreadInstrument, NativeSpreadOpportunity, NativeSpreadScan } from "./types.js";

const MAX_BOOK_AGE_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 2_000;

export interface NativeSpreadScanOptions {
  contractType?: NativeSpreadContractType;
  baseCoin?: string;
  minimumQuantity: number;
  sort: "capacity" | "tightness" | "freshness";
  maxCandidates: number;
  limit: number;
}

export interface NativeSpreadScannerOptions {
  adapter?: Pick<BybitSpreadAdapter, "instruments" | "orderBook">;
  now?: () => number;
  concurrency?: number;
  /** Maximum number of distinct upstream scans in flight across all callers. */
  maxConcurrentScans?: number;
}

export class NativeSpreadScannerService {
  private readonly adapter: Pick<BybitSpreadAdapter, "instruments" | "orderBook">;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly scanWork: SharedAbortableWork<string, NativeSpreadScan>;

  constructor(options: NativeSpreadScannerOptions = {}) {
    this.adapter = options.adapter ?? new BybitSpreadAdapter();
    this.now = options.now ?? Date.now;
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 4)));
    this.scanWork = new SharedAbortableWork(Math.max(1, Math.min(8, Math.trunc(options.maxConcurrentScans ?? 2))));
  }

  async scan(options: NativeSpreadScanOptions, signal?: AbortSignal): Promise<NativeSpreadScan> {
    const normalized = normalizeScanOptions(options);
    return this.scanWork.run(scanKey(normalized), (sharedSignal) => this.scanOnce(normalized, sharedSignal), signal);
  }

  private async scanOnce(options: NativeSpreadScanOptions, signal: AbortSignal): Promise<NativeSpreadScan> {
    const snapshot = await this.adapter.instruments(signal);
    throwIfAborted(signal);
    const baseCoin = options.baseCoin?.trim().toUpperCase();
    const eligible = snapshot.instruments
      .filter((instrument) => instrument.status === "Trading")
      .filter((instrument) => !options.contractType || instrument.contractType === options.contractType)
      .filter((instrument) => !baseCoin || instrument.baseCoin === baseCoin)
      .filter((instrument) => instrument.maximumQuantity >= options.minimumQuantity);
    const candidates = selectCandidates(eligible, options.sort, options.maxCandidates);
    const candidateTruncated = eligible.length > candidates.length;
    const sourceErrors = snapshot.rejectedRows.slice(0, 50);

    const books = await pooledMap(candidates, this.concurrency, async (instrument) => {
      try {
        throwIfAborted(signal);
        const book = await this.adapter.orderBook(instrument.symbol, 1, signal);
        throwIfAborted(signal);
        const evaluatedAt = this.now();
        const quoteAgeMs = evaluatedAt - book.exchangeTs;
        if (quoteAgeMs > MAX_BOOK_AGE_MS) throw new Error(`stale by ${quoteAgeMs}ms`);
        if (quoteAgeMs < -MAX_FUTURE_SKEW_MS) throw new Error(`timestamp is ${Math.abs(quoteAgeMs)}ms in the future`);
        const bookWidth = book.askPrice - book.bidPrice;
        const midpoint = (book.askPrice + book.bidPrice) / 2;
        const relativeBookWidthBps = Math.abs(midpoint) > instrument.tickSize ? (bookWidth / Math.abs(midpoint)) * 10_000 : undefined;
        const opportunity: NativeSpreadOpportunity = {
          ...instrument,
          id: `bybit:native-spread:${instrument.symbol}`,
          venue: "bybit",
          bidPrice: book.bidPrice,
          bidQuantity: book.bidQuantity,
          askPrice: book.askPrice,
          askQuantity: book.askQuantity,
          bookWidth,
          ...(relativeBookWidthBps !== undefined && Number.isFinite(relativeBookWidthBps) ? { relativeBookWidthBps } : {}),
          executableQuantity: floorToStep(Math.min(book.bidQuantity, book.askQuantity, instrument.maximumQuantity), instrument.quantityStep),
          sequence: book.sequence,
          exchangeTs: book.exchangeTs,
          matchingEngineTs: book.matchingEngineTs,
          receivedAt: book.receivedAt,
          quoteAgeMs: Math.max(0, quoteAgeMs),
          riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
        };
        return opportunity;
      } catch (error) {
        // Cancellation belongs to the scan lifecycle, not to one venue book.
        // Converting it into a rejected row could publish a successful empty
        // scan after every subscriber has already disconnected.
        throwIfAborted(signal);
        sourceErrors.push(`${instrument.symbol}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    });
    throwIfAborted(signal);

    const updatedAt = this.now();
    const healthy: NativeSpreadOpportunity[] = [];
    for (const row of books) {
      if (!row) continue;
      const quoteAgeMs = updatedAt - row.exchangeTs;
      if (quoteAgeMs > MAX_BOOK_AGE_MS) {
        sourceErrors.push(`${row.symbol}: stale by ${quoteAgeMs}ms at scan completion`);
        continue;
      }
      if (quoteAgeMs < -MAX_FUTURE_SKEW_MS) {
        sourceErrors.push(`${row.symbol}: timestamp is ${Math.abs(quoteAgeMs)}ms in the future at scan completion`);
        continue;
      }
      if (row.receivedAt > updatedAt) {
        sourceErrors.push(`${row.symbol}: receive timestamp is after scan completion`);
        continue;
      }
      healthy.push({ ...row, quoteAgeMs: Math.max(0, quoteAgeMs) });
    }
    const all = healthy.filter((row) => row.executableQuantity >= Math.max(options.minimumQuantity, row.minimumQuantity));
    all.sort((left, right) => compare(left, right, options.sort));
    const opportunities = all.slice(0, options.limit);
    return {
      venue: "bybit",
      marketDataMode: "venue-native-spread-orderbook",
      executionModel: "venue-matched-multi-leg",
      readOnly: true,
      updatedAt,
      totalInstruments: snapshot.instruments.length,
      eligibleInstruments: eligible.length,
      scannedInstruments: candidates.length,
      healthyBooks: healthy.length,
      totalOpportunities: all.length,
      truncated: candidateTruncated || all.length > opportunities.length,
      candidateTruncated,
      sourceErrors: sourceErrors.slice(0, 100),
      opportunities
    };
  }
}

function normalizeScanOptions(options: NativeSpreadScanOptions): NativeSpreadScanOptions {
  return {
    ...(options.contractType ? { contractType: options.contractType } : {}),
    ...(options.baseCoin ? { baseCoin: options.baseCoin.trim().toUpperCase() } : {}),
    minimumQuantity: options.minimumQuantity,
    sort: options.sort,
    maxCandidates: options.maxCandidates,
    limit: options.limit
  };
}

function scanKey(options: NativeSpreadScanOptions): string {
  return JSON.stringify([
    options.contractType ?? "",
    options.baseCoin ?? "",
    options.minimumQuantity,
    options.sort,
    options.maxCandidates,
    options.limit
  ]);
}

/**
 * A candidate cap necessarily makes the final ranking partial. Use instrument
 * metadata as a sort-specific upper-bound proxy instead of taking a lexical
 * prefix; `candidateTruncated` keeps that partial coverage explicit to callers.
 */
function selectCandidates(instruments: NativeSpreadInstrument[], sort: NativeSpreadScanOptions["sort"], limit: number) {
  return [...instruments].sort((left, right) => compareCandidate(left, right, sort)).slice(0, limit);
}

function compareCandidate(left: NativeSpreadInstrument, right: NativeSpreadInstrument, sort: NativeSpreadScanOptions["sort"]) {
  if (sort === "capacity") {
    return right.maximumQuantity - left.maximumQuantity || left.minimumQuantity - right.minimumQuantity || left.quantityStep - right.quantityStep || left.symbol.localeCompare(right.symbol);
  }
  if (sort === "freshness") {
    return right.launchTime - left.launchTime || (right.deliveryTime ?? Number.POSITIVE_INFINITY) - (left.deliveryTime ?? Number.POSITIVE_INFINITY) || left.symbol.localeCompare(right.symbol);
  }
  return left.tickSize - right.tickSize || right.maximumQuantity - left.maximumQuantity || left.symbol.localeCompare(right.symbol);
}

function compare(left: NativeSpreadOpportunity, right: NativeSpreadOpportunity, sort: NativeSpreadScanOptions["sort"]) {
  if (sort === "capacity") return right.executableQuantity - left.executableQuantity || left.bookWidth - right.bookWidth || left.id.localeCompare(right.id);
  if (sort === "freshness") return left.quoteAgeMs - right.quoteAgeMs || right.executableQuantity - left.executableQuantity || left.id.localeCompare(right.id);
  const leftWidth = left.relativeBookWidthBps ?? Number.POSITIVE_INFINITY;
  const rightWidth = right.relativeBookWidthBps ?? Number.POSITIVE_INFINITY;
  return leftWidth - rightWidth || left.bookWidth - right.bookWidth || left.id.localeCompare(right.id);
}

function floorToStep(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || value <= 0 || step <= 0) return 0;
  const units = Math.floor(value / step + 1e-10);
  return Math.max(0, Number((units * step).toFixed(Math.min(15, decimalPlaces(step)))));
}

function decimalPlaces(value: number) {
  const [coefficient = "", rawExponent] = value.toString().toLowerCase().split("e");
  const fractionDigits = coefficient.split(".")[1]?.length ?? 0;
  const exponent = Number(rawExponent ?? 0);
  return Math.max(0, fractionDigits - exponent);
}

async function pooledMap<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(values[index]!);
      }
    })
  );
  return results;
}
