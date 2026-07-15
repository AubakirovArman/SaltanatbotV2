import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createPairwiseEvaluationHandler } from "../src/arbitrage/pairwiseRoutes.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("public pairwise research evaluation API", () => {
  it("evaluates a bounded read-only request and never returns an execution path", async () => {
    const now = 10_000;
    const app = express();
    app.use(express.json());
    app.post(
      "/evaluate",
      createPairwiseEvaluationHandler(() => now)
    );
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture(now))
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ engine: "pairwise-v1", executable: false, evaluatedAt: now });
    expect(body.opportunity).toMatchObject({
      strategyKind: "spot-spot",
      edgeKind: "research-simulation",
      executable: false,
      economicAssetId: "crypto:bitcoin",
      provenance: {
        economicIdentity: {
          economicAssetId: "crypto:bitcoin",
          matchPolicy: "exact",
          authority: "caller-supplied"
        }
      }
    });
    expect(body).not.toHaveProperty("order");
  });

  it("fails closed on missing, malformed, unreviewed, stale, future or mismatched economic identity", async () => {
    const now = 10_000;
    const app = express();
    app.use(express.json());
    app.post(
      "/evaluate",
      createPairwiseEvaluationHandler(() => now)
    );
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate`;
    const post = (input: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

    for (const mutate of [
      (input: ReturnType<typeof fixture>) => {
        (input.instruments[1] as Partial<(typeof input.instruments)[number]>).economicIdentity = undefined;
      },
      (input: ReturnType<typeof fixture>) => {
        input.instruments[1]!.economicAssetId = "bitcoin";
      },
      (input: ReturnType<typeof fixture>) => {
        input.instruments[1]!.economicIdentity.status = "unreviewed";
      },
      (input: ReturnType<typeof fixture>) => {
        input.instruments[1]!.economicIdentity.source = "";
      },
      (input: ReturnType<typeof fixture>) => {
        input.instruments[1]!.economicIdentity.version = "";
      }
    ]) {
      const input = fixture(now);
      mutate(input);
      expect((await post(input)).status).toBe(400);
    }

    const mismatch = fixture(now);
    mismatch.instruments[1]!.economicAssetId = "crypto:wrapped-bitcoin";
    const mismatchBody = (await (await post(mismatch)).json()) as { rejection: { code: string } };
    expect(mismatchBody.rejection.code).toBe("economic-identity-mismatch");

    const stale = fixture(now);
    stale.options.maxEconomicIdentityAgeMs = 100;
    stale.instruments[1]!.economicIdentity.asOf = now - 101;
    const staleBody = (await (await post(stale)).json()) as { rejection: { code: string } };
    expect(staleBody.rejection.code).toBe("economic-identity-invalid");

    const future = fixture(now);
    future.instruments[1]!.economicIdentity.asOf = now + 1_001;
    future.instruments[1]!.economicIdentity.validUntil = now + 2_000;
    const futureBody = (await (await post(future)).json()) as { rejection: { code: string } };
    expect(futureBody.rejection.code).toBe("economic-identity-invalid");

    const expired = fixture(now);
    expired.instruments[1]!.economicIdentity.asOf = now - 100;
    expired.instruments[1]!.economicIdentity.validUntil = now - 1;
    const expiredBody = (await (await post(expired)).json()) as { rejection: { code: string } };
    expect(expiredBody.rejection.code).toBe("economic-identity-invalid");
  });

  it("rejects oversized depth and unknown fields at the HTTP boundary", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/evaluate",
      createPairwiseEvaluationHandler(() => 10_000)
    );
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const input = fixture(10_000) as ReturnType<typeof fixture> & { unexpected?: boolean };
    input.unexpected = true;
    input.books[0]!.asks = Array.from({ length: 401 }, () => [100, 1]);
    const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    expect(response.status).toBe(400);
  });
});

function fixture(now: number) {
  const instruments = [
    {
      instrumentId: "binance:spot:BTCUSDT",
      venue: "binance",
      symbol: "BTCUSDT",
      marketType: "spot",
      baseAsset: "BTC",
      economicAssetId: "crypto:bitcoin",
      economicIdentity: { status: "reviewed", source: "test-reviewed-map", version: "2026-07-14", asOf: now - 100, validUntil: now + 86_400_000 },
      quoteAsset: "USDT",
      settleAsset: "USDT",
      quantityModel: { unit: "base" },
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 10,
      takerFeeBps: 10
    },
    {
      instrumentId: "bybit:spot:BTCUSDT",
      venue: "bybit",
      symbol: "BTCUSDT",
      marketType: "spot",
      baseAsset: "BTC",
      economicAssetId: "crypto:bitcoin",
      economicIdentity: { status: "reviewed", source: "test-reviewed-map", version: "2026-07-14", asOf: now - 100, validUntil: now + 86_400_000 },
      quoteAsset: "USDT",
      settleAsset: "USDT",
      quantityModel: { unit: "base" },
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 10,
      takerFeeBps: 10
    }
  ];
  const books = [
    { instrumentId: instruments[0]!.instrumentId, quantityUnit: "base", bids: [[99, 10]], asks: [[100, 10]], exchangeTs: now - 10, receivedAt: now - 8, complete: true, sequence: 1, source: "fixture", sourceId: "fixture:binance" },
    { instrumentId: instruments[1]!.instrumentId, quantityUnit: "base", bids: [[104, 10]], asks: [[105, 10]], exchangeTs: now - 9, receivedAt: now - 7, complete: true, sequence: 1, source: "fixture", sourceId: "fixture:bybit" }
  ];
  return {
    instruments,
    books,
    route: {
      routeId: "spot-spread",
      strategyKind: "spot-spot",
      longInstrumentId: instruments[0]!.instrumentId,
      shortInstrumentId: instruments[1]!.instrumentId,
      requestedBaseQuantity: 1,
      longCapital: { kind: "capital", availableQuoteQuantity: 1_000, availabilityVerified: true, source: "manual-prefund", asOf: now - 100 },
      shortAccess: { kind: "inventory", availableBaseQuantity: 1, availabilityVerified: true, source: "manual-prefund", asOf: now - 100 },
      rebalance: { costBps: 5, source: "manual-rebalance", asOf: now - 100 }
    },
    options: { maxQuoteAgeMs: 2_000, maxLegSkewMs: 250, maxFutureClockSkewMs: 1_000, maxAssumptionAgeMs: 86_400_000, maxEconomicIdentityAgeMs: 30 * 86_400_000, maxResidualDeltaBps: 1, pairingIterations: 20 }
  };
}
