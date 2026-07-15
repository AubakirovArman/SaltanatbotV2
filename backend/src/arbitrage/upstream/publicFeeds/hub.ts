import { ContinuousPublicFeed } from "./feed.js";
import type { ContinuousFeedCallbacks, ContinuousFeedInstrument, ContinuousFeedSnapshot, ContinuousFeedStatus, ContinuousFeedSubscription, ContinuousFundingObservation, ContinuousPublicBook, ContinuousTopBook } from "./types.js";

interface ManagedFeed extends ContinuousFeedSubscription {
  start(): void;
}

export interface ContinuousFeedListener {
  onBook?(book: ContinuousPublicBook): void;
  onTopBook?(book: ContinuousTopBook): void;
  onFunding?(funding: ContinuousFundingObservation): void;
  onInvalidate?(reason: string): void;
  onStatus?(status: ContinuousFeedStatus): void;
}

type FeedFactory = (instrument: ContinuousFeedInstrument, callbacks: ContinuousFeedCallbacks) => ManagedFeed;

interface HubEntry {
  instrument: ContinuousFeedInstrument;
  feed: ManagedFeed;
  listeners: Set<ContinuousFeedListener>;
  status: ContinuousFeedStatus;
  lastReceive?: NonNullable<ContinuousFeedSnapshot["lastReceive"]>;
  lastBookEvidence?: NonNullable<ContinuousFeedSnapshot["lastBookEvidence"]>;
  book?: ContinuousPublicBook;
  topBook?: ContinuousTopBook;
  funding?: ContinuousFundingObservation;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
}

export interface ContinuousPublicFeedHubOptions {
  feedFactory?: FeedFactory;
  now?: () => number;
  maxStreams?: number;
  maxStreamsPerVenue?: number;
  maxListeners?: number;
  maxBookAgeMs?: number;
  idleTtlMs?: number;
}

/** Process-shareable, bounded subscription hub; one instrument failure cannot invalidate another. */
export class ContinuousPublicFeedHub {
  private readonly entries = new Map<string, HubEntry>();
  private readonly feedFactory: FeedFactory;
  private readonly now: () => number;
  private readonly maxStreams: number;
  private readonly maxStreamsPerVenue: number;
  private readonly maxListeners: number;
  private readonly maxBookAgeMs: number;
  private readonly idleTtlMs: number;
  private listenerCount = 0;

  constructor(options: ContinuousPublicFeedHubOptions = {}) {
    this.feedFactory = options.feedFactory ?? ((instrument, callbacks) => new ContinuousPublicFeed(instrument, callbacks));
    this.now = options.now ?? Date.now;
    this.maxStreams = bounded(options.maxStreams ?? 24, 1, 128, "maxStreams");
    this.maxStreamsPerVenue = bounded(options.maxStreamsPerVenue ?? 8, 1, 32, "maxStreamsPerVenue");
    this.maxListeners = bounded(options.maxListeners ?? 128, 1, 2_000, "maxListeners");
    this.maxBookAgeMs = bounded(options.maxBookAgeMs ?? 10_000, 1, 60_000, "maxBookAgeMs");
    this.idleTtlMs = bounded(options.idleTtlMs ?? 30_000, 1, 300_000, "idleTtlMs");
  }

  subscribe(instrument: ContinuousFeedInstrument, listener: ContinuousFeedListener): ContinuousFeedSubscription {
    validateInstrument(instrument);
    if (this.listenerCount >= this.maxListeners) throw new Error(`Continuous public feed listener limit reached (${this.maxListeners})`);
    const key = instrument.instrumentId;
    let entry = this.entries.get(key);
    if (entry) requireSameInstrument(entry.instrument, instrument);
    else entry = this.createEntry(instrument);
    if (entry.listeners.has(listener)) throw new Error(`Duplicate continuous public feed listener for ${key}`);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.listeners.add(listener);
    entry.lastUsedAt = this.now();
    this.listenerCount += 1;
    listener.onStatus?.({ ...entry.status });
    if (entry.book && this.isCurrent(entry.book)) listener.onBook?.(cloneBook(entry.book));
    if (entry.topBook && this.isCurrentTop(entry.topBook)) listener.onTopBook?.(cloneTop(entry.topBook));
    if (entry.funding) listener.onFunding?.({ ...entry.funding });
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        if (!entry?.listeners.delete(listener)) return;
        this.listenerCount -= 1;
        entry.lastUsedAt = this.now();
        this.scheduleIdle(key, entry);
      }
    };
  }

  snapshots(): ContinuousFeedSnapshot[] {
    return [...this.entries.values()]
      .sort((left, right) => left.instrument.instrumentId.localeCompare(right.instrument.instrumentId))
      .map((entry) => ({
        instrument: { ...entry.instrument },
        status: { ...entry.status },
        ...(entry.lastReceive ? { lastReceive: { ...entry.lastReceive } } : {}),
        ...(entry.lastBookEvidence ? { lastBookEvidence: { ...entry.lastBookEvidence, continuity: { ...entry.lastBookEvidence.continuity } } } : {}),
        ...(entry.book && this.isCurrent(entry.book) ? { book: cloneBook(entry.book) } : {}),
        ...(entry.topBook && this.isCurrentTop(entry.topBook) ? { topBook: cloneTop(entry.topBook) } : {}),
        ...(entry.funding ? { funding: { ...entry.funding } } : {})
      }));
  }

  activeStreams() {
    return this.entries.size;
  }

  isCurrent(book: ContinuousPublicBook) {
    const entry = this.entries.get(book.instrumentId);
    const current = entry?.book;
    return Boolean(current && current.connectionGeneration === book.connectionGeneration && sameProof(current, book) && current.exchangeTs === book.exchangeTs && current.receivedAt === book.receivedAt && this.now() - current.receivedAt <= this.maxBookAgeMs);
  }

  close() {
    for (const [key, entry] of this.entries) this.dispose(key, entry);
  }

  private createEntry(instrument: ContinuousFeedInstrument) {
    this.evictIdle();
    if (this.entries.size >= this.maxStreams) throw new Error(`Continuous public feed stream limit reached (${this.maxStreams})`);
    const venueCount = [...this.entries.values()].filter((entry) => entry.instrument.venue === instrument.venue).length;
    if (venueCount >= this.maxStreamsPerVenue) throw new Error(`${instrument.venue} continuous stream limit reached (${this.maxStreamsPerVenue})`);
    let entry: HubEntry;
    const callbacks: ContinuousFeedCallbacks = {
      onBook: (book) => {
        if (this.entries.get(instrument.instrumentId) !== entry) return;
        entry.book = cloneBook(book);
        entry.lastReceive = newestReceive(entry.lastReceive, { at: book.receivedAt, kind: "book", connectionGeneration: book.connectionGeneration });
        entry.lastBookEvidence = { receivedAt: book.receivedAt, connectionGeneration: book.connectionGeneration, continuity: { ...book.continuity } };
        entry.lastUsedAt = this.now();
        for (const listener of entry.listeners) listener.onBook?.(cloneBook(book));
      },
      onTopBook: (book) => {
        if (this.entries.get(instrument.instrumentId) !== entry) return;
        entry.topBook = cloneTop(book);
        entry.lastReceive = newestReceive(entry.lastReceive, { at: book.receivedAt, kind: "top-book", connectionGeneration: book.connectionGeneration });
        entry.lastBookEvidence = { receivedAt: book.receivedAt, connectionGeneration: book.connectionGeneration, continuity: { ...book.continuity } };
        for (const listener of entry.listeners) listener.onTopBook?.(cloneTop(book));
      },
      onFunding: (funding) => {
        if (this.entries.get(instrument.instrumentId) !== entry) return;
        entry.funding = { ...funding };
        entry.lastReceive = newestReceive(entry.lastReceive, { at: funding.receivedAt, kind: "funding", connectionGeneration: funding.connectionGeneration });
        for (const listener of entry.listeners) listener.onFunding?.({ ...funding });
      },
      onInvalidate: (reason) => {
        if (this.entries.get(instrument.instrumentId) !== entry) return;
        entry.book = undefined;
        entry.topBook = undefined;
        entry.funding = undefined;
        for (const listener of entry.listeners) listener.onInvalidate?.(reason);
      },
      onStatus: (status) => {
        if (this.entries.get(instrument.instrumentId) !== entry) return;
        // Book feeds commonly repeat the identical `live` status for every
        // market-data frame. State truth has not changed, so do not amplify that
        // high-rate stream into downstream discovery/lifecycle work.
        if (sameStatus(entry.status, status)) return;
        entry.status = { ...status };
        for (const listener of entry.listeners) listener.onStatus?.({ ...status });
      }
    };
    const feed = this.feedFactory(instrument, callbacks);
    entry = {
      instrument: { ...instrument },
      feed,
      listeners: new Set(),
      status: { venue: instrument.venue, instrumentId: instrument.instrumentId, state: "connecting", message: "Feed created", generation: 0 },
      lastUsedAt: this.now()
    };
    this.entries.set(instrument.instrumentId, entry);
    try {
      feed.start();
    } catch (error) {
      this.entries.delete(instrument.instrumentId);
      feed.close();
      throw error;
    }
    return entry;
  }

  private isCurrentTop(book: ContinuousTopBook) {
    const current = this.entries.get(book.instrumentId)?.topBook;
    return Boolean(current && current.connectionGeneration === book.connectionGeneration && current.receivedAt === book.receivedAt && this.now() - current.receivedAt <= this.maxBookAgeMs);
  }

  private scheduleIdle(key: string, entry: HubEntry) {
    if (entry.listeners.size > 0 || entry.idleTimer || this.entries.get(key) !== entry) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.listeners.size === 0 && this.entries.get(key) === entry) this.dispose(key, entry);
    }, this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private evictIdle() {
    if (this.entries.size < this.maxStreams) return;
    const candidate = [...this.entries.entries()].filter(([, entry]) => entry.listeners.size === 0).sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (candidate) this.dispose(candidate[0], candidate[1]);
  }

  private dispose(key: string, entry: HubEntry) {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.listenerCount -= entry.listeners.size;
    entry.listeners.clear();
    entry.feed.close();
  }
}

function validateInstrument(value: ContinuousFeedInstrument) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,199}$/.test(value.instrumentId)) throw new Error("Invalid continuous feed instrumentId");
  if (!/^[A-Za-z0-9@][A-Za-z0-9_./-]{0,99}$/.test(value.venueSymbol)) throw new Error("Invalid continuous feed venueSymbol");
}

function requireSameInstrument(left: ContinuousFeedInstrument, right: ContinuousFeedInstrument) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`Conflicting continuous feed metadata for ${left.instrumentId}`);
}

function cloneBook(book: ContinuousPublicBook): ContinuousPublicBook {
  return { ...book, continuity: { ...book.continuity }, bids: book.bids.map(([price, quantity]) => [price, quantity]), asks: book.asks.map(([price, quantity]) => [price, quantity]) };
}

function cloneTop(book: ContinuousTopBook): ContinuousTopBook {
  return { ...book, continuity: { ...book.continuity } };
}

function sameProof(left: ContinuousPublicBook, right: ContinuousPublicBook) {
  if (left.continuity.kind !== right.continuity.kind) return false;
  if (left.continuity.kind === "atomic-snapshot") return true;
  if (right.continuity.kind === "checksum-verified") {
    return left.continuity.kind === "checksum-verified" && left.continuity.sequence === right.continuity.sequence && left.continuity.checksum === right.continuity.checksum;
  }
  return "sequence" in left.continuity && "sequence" in right.continuity && left.continuity.sequence === right.continuity.sequence;
}

function sameStatus(left: ContinuousFeedStatus, right: ContinuousFeedStatus) {
  return left.venue === right.venue && left.instrumentId === right.instrumentId && left.state === right.state && left.message === right.message && left.generation === right.generation;
}

function newestReceive(current: NonNullable<ContinuousFeedSnapshot["lastReceive"]> | undefined, next: NonNullable<ContinuousFeedSnapshot["lastReceive"]>) {
  if (!current || next.at > current.at) return { ...next };
  if (next.at < current.at) return current;
  const priority = { book: 0, "top-book": 1, funding: 2 } as const;
  return priority[next.kind] < priority[current.kind] ? { ...next } : current;
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
