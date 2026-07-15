import type WebSocket from "ws";
import { parseL2Levels } from "../l2/boundedBook.js";
import { ContinuousBoundedBook, finite, record, safeInteger, validReceivedAt } from "./bookState.js";
import type { ContinuousVenueProtocol, ProtocolOptions, ProtocolResult } from "./protocol.js";
import { subscriptionError } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

const MAX_LEVELS_PER_MESSAGE = 2_000;

export class OkxContinuousProtocol implements ContinuousVenueProtocol {
  readonly url = "wss://ws.okx.com:8443/ws/v5/public";
  readonly needsBootstrap = false;
  private readonly book: ContinuousBoundedBook;
  private sequence?: number;

  constructor(
    readonly instrument: ContinuousFeedInstrument,
    options: ProtocolOptions = {}
  ) {
    if (instrument.venue !== "okx") throw new Error("OKX protocol requires an OKX instrument");
    this.book = new ContinuousBoundedBook(options.maxLevels ?? 400, options.publishLevels ?? 100);
  }

  reset() {
    this.book.clear();
    this.sequence = undefined;
  }

  subscribe(socket: WebSocket) {
    const args: Array<Record<string, string>> = [{ channel: "books", instId: this.instrument.venueSymbol }];
    if (this.instrument.marketType === "perpetual") args.push({ channel: "funding-rate", instId: this.instrument.venueSymbol });
    socket.send(JSON.stringify({ id: "publicfeed1", op: "subscribe", args }));
  }

  heartbeat(socket: WebSocket) {
    socket.send("ping");
  }

  push(value: unknown, receivedAt: number): ProtocolResult {
    if (!validReceivedAt(receivedAt)) return this.fail("OKX local receive timestamp is invalid");
    const failure = subscriptionError(value);
    if (failure) return this.fail(`OKX ${failure}`);
    const envelope = record(value);
    if (!envelope) return this.fail("OKX public message is not an object");
    if (envelope.event === "subscribe" || envelope.event === "unsubscribe" || envelope.event === "pong") return { kind: "accepted" };
    const arg = record(envelope.arg);
    if (!arg) return { kind: "ignored" };
    const channel = typeof arg?.channel === "string" ? arg.channel : undefined;
    if (channel === "books") return this.pushBook(envelope, arg, receivedAt);
    if (channel === "funding-rate") return this.pushFunding(envelope, arg, receivedAt);
    return { kind: "ignored" };
  }

  private pushBook(envelope: Record<string, unknown>, arg: Record<string, unknown>, receivedAt: number): ProtocolResult {
    if (arg.instId !== this.instrument.venueSymbol) return this.fail("OKX book symbol changed inside one subscription");
    const action = envelope.action;
    const rows = envelope.data;
    if ((action !== "snapshot" && action !== "update") || !Array.isArray(rows) || rows.length !== 1) return this.fail("Malformed OKX books envelope");
    const row = record(rows[0]);
    const sequence = safeInteger(row?.seqId);
    const previous = safeInteger(row?.prevSeqId, -1);
    const exchangeTs = safeInteger(row?.ts, 1);
    const bids = parseL2Levels(row?.bids, MAX_LEVELS_PER_MESSAGE);
    const asks = parseL2Levels(row?.asks, MAX_LEVELS_PER_MESSAGE);
    if (sequence === undefined || previous === undefined || exchangeTs === undefined || !bids || !asks) return this.fail("Malformed OKX books payload");
    try {
      let levels: ReturnType<ContinuousBoundedBook["snapshot"]>;
      if (action === "snapshot") {
        if (previous !== -1) return this.fail("OKX snapshot prevSeqId must be -1");
        levels = this.book.reset(bids, asks);
      } else {
        if (this.sequence === undefined) return this.fail("OKX update arrived before a full snapshot");
        const keepalive = previous === this.sequence && sequence === this.sequence && bids.length === 0 && asks.length === 0;
        if (!keepalive && previous !== this.sequence) return this.fail(`OKX sequence gap: expected prevSeqId ${this.sequence}, received ${previous}`);
        if (sequence < this.sequence) return this.fail(`OKX sequence regressed from ${this.sequence} to ${sequence}`);
        levels = this.book.apply(bids, asks);
      }
      this.sequence = sequence;
      return {
        kind: "book",
        book: {
          venue: "okx",
          instrumentId: this.instrument.instrumentId,
          venueSymbol: this.instrument.venueSymbol,
          marketType: this.instrument.marketType,
          quantityUnit: this.instrument.quantityUnit,
          bids: levels.bids,
          asks: levels.asks,
          exchangeTs,
          receivedAt,
          complete: true,
          continuity: { kind: "sequence-verified", sequence, protocol: "okx-seqid" },
          source: "public-websocket",
          retainedDepth: this.book.retainedDepth()
        }
      };
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : "Invalid OKX reconstructed book");
    }
  }

  private pushFunding(envelope: Record<string, unknown>, arg: Record<string, unknown>, receivedAt: number): ProtocolResult {
    if (arg.instId !== this.instrument.venueSymbol || this.instrument.marketType !== "perpetual") return this.fail("OKX funding scope changed inside one subscription");
    if (!Array.isArray(envelope.data) || envelope.data.length !== 1) return this.fail("Malformed OKX funding envelope");
    const row = record(envelope.data[0]);
    if (!row) return this.fail("Malformed OKX funding payload");
    const rate = finite(row?.fundingRate);
    const fundingTime = safeInteger(row?.fundingTime, 1);
    const nextFundingTime = safeInteger(row?.nextFundingTime, 1);
    const exchangeTs = safeInteger(row?.ts, 1);
    if (rate === undefined || fundingTime === undefined || nextFundingTime === undefined || exchangeTs === undefined) return this.fail("Malformed OKX funding payload");
    const intervalMinutes = (nextFundingTime - fundingTime) / 60_000;
    const scheduleVerified = Number.isSafeInteger(intervalMinutes) && intervalMinutes > 0 && intervalMinutes <= 1_440;
    const nextEstimateRate = finite(row?.nextFundingRate);
    return {
      kind: "funding",
      funding: {
        venue: "okx",
        instrumentId: this.instrument.instrumentId,
        currentEstimateRate: rate,
        ...(nextEstimateRate === undefined ? {} : { nextEstimateRate }),
        nextFundingTime,
        ...(scheduleVerified ? { intervalMinutes } : {}),
        scheduleVerified,
        exchangeTs,
        exchangeTimestampVerified: true,
        receivedAt,
        source: "public-websocket"
      }
    };
  }

  private fail(reason: string): ProtocolResult {
    this.reset();
    return { kind: "gap", reason };
  }
}
