import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTriangularScan, parseTriangularScan } from "./triangularClient";

const opportunity = {
  id: "binance:USDT-BTC-ETH-USDT",
  edgeKind: "non-executable-candidate",
  executionStatus: "non-executable-candidate",
  marketDataMode: "rest-top-book",
  sequenceVerified: false,
  venue: "binance",
  startAsset: "USDT",
  startQuantity: 1_000,
  endQuantity: 1_002,
  grossReturnBps: 50,
  netReturnBps: 20,
  limitingCapacity: {
    requestedStartQuantity: 1_000,
    executableStartQuantity: 900,
    utilizationPct: 90
  },
  legs: [
    { index: 0, symbol: "BTCUSDT", side: "buy", fromAsset: "USDT", toAsset: "BTC", inputQuantity: 900, outputQuantity: 0.01, averagePrice: 90_000, feeBps: 10, levelsUsed: 1 },
    { index: 1, symbol: "ETHBTC", side: "buy", fromAsset: "BTC", toAsset: "ETH", inputQuantity: 0.01, outputQuantity: 0.25, averagePrice: 0.04, feeBps: 10, levelsUsed: 1 },
    { index: 2, symbol: "ETHUSDT", side: "sell", fromAsset: "ETH", toAsset: "USDT", inputQuantity: 0.25, outputQuantity: 1_002, averagePrice: 4_008, feeBps: 10, levelsUsed: 1 }
  ],
  timestamps: { evaluatedAt: 100, quoteAgeMs: 20, legSkewMs: 4, exchangeTimestampsVerified: false },
  riskFlags: ["sequential-leg-risk", "top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]
};

const payload = {
  updatedAt: 100,
  venue: "binance",
  startAsset: "USDT",
  requestedStartQuantity: 1_000,
  scannedMarkets: 300,
  scannedCycles: 40,
  totalOpportunities: 1,
  truncated: false,
  marketDataMode: "rest-top-book",
  snapshotSource: "rest-snapshot",
  executionStatus: "non-executable-candidate",
  sequenceVerified: false,
  opportunities: [opportunity]
};

afterEach(() => vi.unstubAllGlobals());

describe("triangular scanner browser contract", () => {
  it("parses a bounded three-leg payload", () => {
    const parsed = parseTriangularScan(payload);
    expect(parsed.opportunities).toHaveLength(1);
    expect(parsed.opportunities[0].legs.map((leg) => leg.index)).toEqual([0, 1, 2]);
    expect(parsed.opportunities[0].netReturnBps).toBe(20);
    expect(parsed.opportunities[0]).toMatchObject({ edgeKind: "non-executable-candidate", sequenceVerified: false });
  });

  it("rejects malformed routes and unsupported data modes", () => {
    expect(() => parseTriangularScan({ ...payload, opportunities: [{ ...opportunity, legs: opportunity.legs.slice(0, 2) }] })).toThrow(/three legs/);
    expect(() => parseTriangularScan({ ...payload, marketDataMode: "websocket" })).toThrow(/unsupported/);
    expect(() => parseTriangularScan({ ...payload, sequenceVerified: true })).toThrow(/cannot be sequence verified/);
    expect(() => parseTriangularScan({ ...payload, opportunities: [{ ...opportunity, edgeKind: "executable-sequential" }] })).toThrow(/unsequenced REST top-book candidate/);
  });

  it("requires explicit unique and ordered wire leg indices", () => {
    const missingIndex = opportunity.legs.map(({ index: _index, ...leg }) => leg);
    const duplicateIndex = opportunity.legs.map((leg, index) => ({ ...leg, index: index === 2 ? 1 : leg.index }));
    const reordered = [opportunity.legs[1], opportunity.legs[0], opportunity.legs[2]];

    expect(() => parseTriangularScan({ ...payload, opportunities: [{ ...opportunity, legs: missingIndex }] })).toThrow(/leg\[0\]\.index/);
    expect(() => parseTriangularScan({ ...payload, opportunities: [{ ...opportunity, legs: duplicateIndex }] })).toThrow(/ordered 0,1,2/);
    expect(() => parseTriangularScan({ ...payload, opportunities: [{ ...opportunity, legs: reordered }] })).toThrow(/ordered 0,1,2/);
  });

  it("sends explicit scanner parameters and surfaces API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "venue unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTriangularScan({ venue: "binance", startAsset: "USDT", startQuantity: 1_000, takerFeeBps: 7.5, minimumNetReturnBps: 5 })).resolves.toMatchObject({ scannedCycles: 40 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("takerFeeBps=7.5");
    await expect(fetchTriangularScan({ venue: "bybit", startAsset: "USDT", startQuantity: 1_000, takerFeeBps: 10, minimumNetReturnBps: 0 })).rejects.toThrow("venue unavailable");
  });
});
