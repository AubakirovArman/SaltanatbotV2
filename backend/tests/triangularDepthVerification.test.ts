import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { SaltanatArbitrageClient } from "../../packages/arbitrage-sdk/client.js";
import { createTriangularDepthVerificationHandler, TriangularDepthVerificationError, TriangularDepthVerificationService } from "../src/arbitrage/triangularDepth/index.js";
import type { SequenceVerifiedBookProvider, SequenceVerifiedL2Book } from "../src/arbitrage/upstream/l2/index.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("selected triangular sequence-verified depth", () => {
  it("re-simulates all three legs with current L2 leases while keeping execution unavailable", async () => {
    const service = createService();
    const result = await service.verify(request());

    expect(result).toMatchObject({
      schemaVersion: 1,
      readOnly: true,
      researchOnly: true,
      executable: false,
      execution: "none",
      verificationStatus: "sequence-verified-paper-candidate",
      marketDataMode: "sequence-verified-depth",
      totalOpportunities: 1
    });
    expect(result.books.map((book) => book.symbol)).toEqual(["BTCUSDT", "ETHBTC", "ETHUSDT"]);
    expect(result.books.every((book) => book.sequenceVerified && book.source === "websocket-reconstructed")).toBe(true);
    expect(result.opportunities[0]).toMatchObject({
      edgeKind: "executable-sequential",
      executionStatus: "executable",
      marketDataMode: "sequence-verified-depth",
      sequenceVerified: true,
      riskFlags: expect.arrayContaining(["sequential-leg-risk", "output-fee-assumption"])
    });
    expect(result.opportunities[0]?.riskFlags).not.toContain("top-book-only");
  });

  it("returns deterministic rejection evidence when visible depth removes the candidate", async () => {
    const service = createService();
    const result = await service.verify({ ...request(), minimumNetReturnBps: 1_000 });

    expect(result.totalOpportunities).toBe(0);
    expect(result.opportunities).toEqual([]);
    expect(result.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ code: "non-profitable" })]));
    expect(result.executable).toBe(false);
  });

  it("fails closed on an unknown symbol before opening any book", async () => {
    let calls = 0;
    const base = provider();
    const service = createService({
      getBook: async (...args) => {
        calls += 1;
        return base.getBook(...args);
      },
      isCurrent: (book) => base.isCurrent(book)
    });

    await expect(service.verify({ ...request(), symbols: ["BTCUSDT", "ETHBTC", "UNKNOWN"] })).rejects.toBeInstanceOf(TriangularDepthVerificationError);
    expect(calls).toBe(0);
  });

  it("withdraws the result when any connection-generation lease is no longer current", async () => {
    const base = provider();
    const service = createService({ getBook: (...args) => base.getBook(...args), isCurrent: () => false });

    await expect(service.verify(request())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed generation/) });
  });

  it("requires three distinct symbols and a real triangle", async () => {
    const service = createService();
    await expect(service.verify({ ...request(), symbols: ["BTCUSDT", "BTCUSDT", "ETHUSDT"] })).rejects.toThrow(/three distinct symbols/);
    await expect(service.verify({ ...request(), startAsset: "SOL" })).rejects.toThrow(/do not form a triangular cycle/);
  });

  it("round-trips the live route through the strict public SDK and rejects execution-shaped input", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/arbitrage/triangular/verify-depth", createTriangularDepthVerificationHandler(createService()));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const client = new SaltanatArbitrageClient({ baseUrl });

    await expect(client.verifyTriangularDepth(request())).resolves.toMatchObject({
      executable: false,
      execution: "none",
      totalOpportunities: 1,
      opportunities: [expect.objectContaining({ marketDataMode: "sequence-verified-depth", sequenceVerified: true })]
    });

    const forbidden = await fetch(`${baseUrl}/api/arbitrage/triangular/verify-depth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request(), apiKey: "must-not-be-accepted" })
    });
    expect(forbidden.status).toBe(400);
  });
});

function createService(books: SequenceVerifiedBookProvider = provider()) {
  const instruments = [instrument("BTCUSDT", "BTC", "USDT"), instrument("ETHBTC", "ETH", "BTC"), instrument("ETHUSDT", "ETH", "USDT")];
  return new TriangularDepthVerificationService({
    now: () => 10_100,
    maxQuoteAgeMs: 1_000,
    maxLegSkewMs: 100,
    books,
    registry: { snapshot: async () => ({ updatedAt: 10_000, instruments, verifiedInstruments: instruments, capabilities: [], sourceErrors: [], sourceStates: [] }) }
  });
}

function request() {
  return {
    venue: "binance" as const,
    startAsset: "USDT",
    startQuantity: 1_000,
    takerFeeBps: 0,
    minimumNetReturnBps: 0,
    symbols: ["BTCUSDT", "ETHBTC", "ETHUSDT"] as const
  };
}

function provider(): SequenceVerifiedBookProvider {
  const books = new Map([
    ["BTCUSDT", book("BTCUSDT", [[99, 100]], [[100, 100]], 1)],
    ["ETHBTC", book("ETHBTC", [[0.049, 1_000]], [[0.05, 1_000]], 2)],
    ["ETHUSDT", book("ETHUSDT", [[5.2, 1_000]], [[5.3, 1_000]], 3)]
  ]);
  return {
    getBook: async (_venue, _market, symbol) => {
      const value = books.get(symbol);
      if (!value) throw new Error(`missing ${symbol}`);
      return structuredClone(value);
    },
    isCurrent: (value) => books.get(value.symbol)?.sequence === value.sequence && value.connectionGeneration === 1
  };
}

function book(symbol: string, bids: Array<[number, number]>, asks: Array<[number, number]>, sequence: number): SequenceVerifiedL2Book {
  return {
    exchange: "binance",
    market: "spot",
    symbol,
    bids,
    asks,
    sequence,
    sequenceVerified: true,
    exchangeTs: 10_000,
    exchangeTimestampSource: "event-time",
    receivedAt: 10_010,
    source: "websocket-reconstructed",
    retainedDepth: 100,
    connectionGeneration: 1
  };
}

function instrument(symbol: string, baseAsset: string, quoteAsset: string): RegistryInstrument {
  return {
    id: `binance:spot:${symbol}`,
    assetId: baseAsset,
    venue: "binance",
    venueSymbol: symbol,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    tickSize: 0.000001,
    quantityStep: 0.0001,
    minimumQuantity: 0.0001,
    minimumNotional: 0.000001,
    status: "trading"
  };
}
