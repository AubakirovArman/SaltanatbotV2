import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeribitContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/deribitProtocol.js";
import { GateContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/gateProtocol.js";
import { HyperliquidContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/hyperliquidProtocol.js";
import { OkxContinuousProtocol } from "../src/arbitrage/upstream/publicFeeds/okxProtocol.js";
import type { ContinuousFeedInstrument } from "../src/arbitrage/upstream/publicFeeds/types.js";

const RECEIVED_AT = 1_784_000_000_500;

describe("continuous public WebSocket protocols", () => {
  it("reconstructs OKX books with prevSeqId/seqId and preserves a verified funding schedule", () => {
    const protocol = new OkxContinuousProtocol(instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"));
    expect(protocol.push(fixture("okx-book-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100, 3],
          [99, 2]
        ],
        continuity: { kind: "sequence-verified", sequence: 100, protocol: "okx-seqid" }
      }
    });
    expect(protocol.push(fixture("okx-book-update.json"), RECEIVED_AT + 100)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 6],
          [99, 2]
        ],
        asks: [
          [101, 7],
          [102, 5]
        ],
        continuity: { sequence: 101 }
      }
    });
    expect(protocol.push(fixture("okx-funding.json"), RECEIVED_AT + 123)).toMatchObject({
      kind: "funding",
      funding: { currentEstimateRate: 0.00012, nextEstimateRate: 0.00008, intervalMinutes: 240, scheduleVerified: true, exchangeTimestampVerified: true }
    });

    const gap = structuredClone(fixture("okx-book-update.json")) as { data: Array<{ prevSeqId: string }> };
    gap.data[0]!.prevSeqId = "99";
    expect(protocol.push(gap, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected prevSeqId 101/) });
    expect(protocol.push(fixture("okx-book-update.json"), RECEIVED_AT + 300)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/before a full snapshot/) });
  });

  it("accepts Gate spot full snapshots and fails closed when U/u skips the successor", () => {
    const protocol = new GateContinuousProtocol(instrument("gate", "BTC_USDT", "spot", "base"));
    expect(protocol.push(fixture("gate-spot-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: { continuity: { sequence: 205, protocol: "gate-update-id" }, receivedAt: RECEIVED_AT }
    });
    expect(protocol.push(fixture("gate-spot-update.json"), RECEIVED_AT + 100)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 8],
          [99, 2]
        ],
        continuity: { sequence: 207 }
      }
    });
    const gap = structuredClone(fixture("gate-spot-update.json")) as { result: { U: number; u: number } };
    gap.result.U = 210;
    gap.result.u = 211;
    expect(protocol.push(gap, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected update 208/) });
  });

  it("bridges Gate perpetual deltas from an exact REST update ID and bounds bootstrap memory", () => {
    const protocol = new GateContinuousProtocol(instrument("gate", "BTC_USDT", "perpetual", "contract"), { gateMode: "incremental-rest-bridge" });
    expect(protocol.push(fixture("gate-perpetual-update.json"), RECEIVED_AT + 100)).toEqual({ kind: "accepted" });
    expect(protocol.applyBootstrap(depthSnapshot(300))).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 8],
          [99, 2]
        ],
        continuity: { sequence: 302 }
      }
    });
    expect(protocol.push(fixture("gate-funding.json"), RECEIVED_AT + 123)).toMatchObject({
      kind: "funding",
      funding: { currentEstimateRate: -0.000015, scheduleVerified: false }
    });

    const bounded = new GateContinuousProtocol(instrument("gate", "BTC_USDT", "perpetual", "contract"), { gateMode: "incremental-rest-bridge", maxBufferedEvents: 1 });
    expect(bounded.push(fixture("gate-perpetual-update.json"), RECEIVED_AT)).toEqual({ kind: "accepted" });
    expect(bounded.push(fixture("gate-perpetual-update.json"), RECEIVED_AT + 1)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/hard bound/) });
  });

  it("accepts Gate futures.obu full snapshots without inventing a missing first update ID", () => {
    const protocol = new GateContinuousProtocol(instrument("gate", "BTC_USDT", "perpetual", "contract"));
    expect(protocol.push(fixture("gate-perpetual-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100, 3],
          [99, 2]
        ],
        continuity: { sequence: 300, protocol: "gate-update-id" }
      }
    });
    expect(protocol.push({ channel: "futures.obu", event: "update", time_ms: RECEIVED_AT + 1, result: { t: RECEIVED_AT + 1, s: "ob.BTC_USDT.50", U: 301, u: 302 } }, RECEIVED_AT + 1)).toMatchObject({
      kind: "book",
      book: { continuity: { sequence: 302 } }
    });
  });

  it("labels Hyperliquid block books as atomic snapshots, never sequence-verified", () => {
    const protocol = new HyperliquidContinuousProtocol(instrument("hyperliquid", "BTC", "perpetual", "base"));
    expect(protocol.push(fixture("hyperliquid-book.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: { continuity: { kind: "atomic-snapshot", protocol: "hyperliquid-block-snapshot", sequenceVerified: false } }
    });
    expect(protocol.push(fixture("hyperliquid-funding.json"), RECEIVED_AT + 1)).toMatchObject({
      kind: "funding",
      funding: { currentEstimateRate: 0.000012, scheduleVerified: false, exchangeTimestampVerified: false }
    });
    expect(protocol.push(fixture("hyperliquid-book.json"), RECEIVED_AT + 2)).toEqual({ kind: "ignored" });
  });

  it("reconstructs Deribit changes only when prev_change_id matches", () => {
    const protocol = new DeribitContinuousProtocol(instrument("deribit", "BTC-PERPETUAL", "perpetual", "quote"));
    expect(protocol.push(fixture("deribit-book-snapshot.json"), RECEIVED_AT)).toMatchObject({
      kind: "book",
      book: { continuity: { sequence: 400, protocol: "deribit-change-id" } }
    });
    expect(protocol.push(fixture("deribit-book-change.json"), RECEIVED_AT + 100)).toMatchObject({
      kind: "book",
      book: {
        bids: [
          [100.5, 6000],
          [99, 2000]
        ],
        asks: [
          [101, 7000],
          [102, 5000]
        ],
        continuity: { sequence: 401 }
      }
    });
    expect(protocol.push(fixture("deribit-funding.json"), RECEIVED_AT + 123)).toMatchObject({
      kind: "funding",
      funding: { currentEstimateRate: 0.000082, scheduleVerified: false }
    });
    const gap = structuredClone(fixture("deribit-book-change.json")) as { params: { data: { prev_change_id: number; change_id: number } } };
    gap.params.data.prev_change_id = 399;
    gap.params.data.change_id = 402;
    expect(protocol.push(gap, RECEIVED_AT + 200)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/expected prev_change_id 401/) });
  });

  it("rejects crossed, malformed and wrong-symbol payloads instead of retaining a previous book", () => {
    const okx = new OkxContinuousProtocol(instrument("okx", "BTC-USDT-SWAP", "perpetual", "contract"));
    const crossed = structuredClone(fixture("okx-book-snapshot.json")) as { data: Array<{ asks: string[][] }> };
    crossed.data[0]!.asks[0]![0] = "99";
    expect(okx.push(crossed, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/crossed or locked/) });

    const hyperliquid = new HyperliquidContinuousProtocol(instrument("hyperliquid", "BTC", "perpetual", "base"));
    const wrong = structuredClone(fixture("hyperliquid-book.json")) as { data: { coin: string } };
    wrong.data.coin = "ETH";
    expect(hyperliquid.push(wrong, RECEIVED_AT)).toMatchObject({ kind: "gap", reason: expect.stringMatching(/Malformed/) });
    expect(okx.push([], RECEIVED_AT)).toMatchObject({ kind: "gap" });
  });
});

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/public-feeds/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

function instrument(venue: ContinuousFeedInstrument["venue"], venueSymbol: string, marketType: ContinuousFeedInstrument["marketType"], quantityUnit: ContinuousFeedInstrument["quantityUnit"]): ContinuousFeedInstrument {
  return { venue, instrumentId: `${venue}:${marketType}:${venueSymbol}`, venueSymbol, marketType, quantityUnit };
}

function depthSnapshot(sequence: number) {
  return {
    venue: "gate",
    instrumentId: "BTC_USDT",
    marketType: "perpetual" as const,
    quantityUnit: "contract" as const,
    bids: [
      [100, 3],
      [99, 2]
    ] as const,
    asks: [
      [101, 4],
      [102, 5]
    ] as const,
    sequence,
    exchangeTs: RECEIVED_AT - 1,
    receivedAt: RECEIVED_AT,
    complete: true as const
  };
}
