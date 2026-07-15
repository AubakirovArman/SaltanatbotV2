import express, { Router } from "express";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { registerArbitrageAlertRoutes } from "../src/arbitrage/alertRoutes.js";
import { ArbitrageAlertService } from "../src/arbitrage/alerts.js";
import type { ArbitrageOpportunity, ArbitrageScanResponse } from "../src/arbitrage/types.js";

describe("durable arbitrage alert reliability", () => {
  it("tracks crossings per rule+opportunity and does not suppress a new route behind the current best", async () => {
    const storage = memoryStorage();
    const delivered: string[] = [];
    const service = new ArbitrageAlertService({
      storage,
      deliver: async (payload) => delivered.push(payload.symbol ?? ""),
      now: () => 1_000
    });
    service.save(ruleInput(), 1_000);

    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 2_000);
    expect(delivered).toEqual([]); // first snapshot establishes a restart-safe baseline

    const newRoute = await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150), opportunity("route-b", "ETHUSDT", 120)]), 3_000);
    expect(newRoute.queuedDeliveryIds).toHaveLength(1);
    expect(newRoute.deliveredDeliveryIds).toHaveLength(1);
    expect(delivered).toEqual(["ETHUSDT"]);

    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20), opportunity("route-b", "ETHUSDT", 20)]), 4_000);
    const recross = await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 130, "binance", "bybit", 64_000), opportunity("route-b", "ETHUSDT", 140, "binance", "bybit", 64_000)]), 64_000);
    expect(recross.deliveredDeliveryIds).toHaveLength(2);
    expect(delivered).toEqual(["ETHUSDT", "BTCUSDT", "ETHUSDT"]);
    expect(service.listDeliveries().every((delivery) => delivery.status === "delivered")).toBe(true);
  });

  it("persists failed attempts and resumes exponential retry after service restart", async () => {
    const storage = memoryStorage();
    const first = new ArbitrageAlertService({
      storage,
      deliver: async () => {
        throw new Error("telegram offline");
      },
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      maxAttempts: 3,
      now: () => 2_000
    });
    first.save(ruleInput(), 1_000);
    await first.evaluate(scan([opportunity("route-a", "BTCUSDT", 20)]), 1_500);
    const failedAttempt = await first.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 2_000);

    expect(failedAttempt.retryingDeliveryIds).toHaveLength(1);
    expect(first.listDeliveries()[0]).toMatchObject({ status: "retrying", attempts: 1, nextAttemptAt: 2_100, lastError: "telegram offline" });

    let restartedAttempts = 0;
    const restarted = new ArbitrageAlertService({
      storage,
      deliver: async () => {
        restartedAttempts += 1;
      },
      retryBaseMs: 100,
      retryMaxMs: 1_000,
      maxAttempts: 3,
      now: () => 2_100
    });
    expect((await restarted.flush(2_099)).attemptedDeliveryIds).toEqual([]);
    const recovered = await restarted.flush(2_100);

    expect(recovered.deliveredDeliveryIds).toEqual(failedAttempt.retryingDeliveryIds);
    expect(restartedAttempts).toBe(1);
    expect(restarted.listDeliveries()[0]).toMatchObject({ status: "delivered", attempts: 2, deliveredAt: 2_100 });
    expect(restarted.list()[0]?.lastDelivery).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("exposes terminal delivery errors instead of treating them as successful", async () => {
    const storage = memoryStorage();
    const service = new ArbitrageAlertService({
      storage,
      deliver: async () => {
        throw new Error("HTTP 503");
      },
      retryBaseMs: 100,
      maxAttempts: 2,
      now: () => 2_000
    });
    service.save(ruleInput(), 1_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20)]), 1_500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 2_000);
    const terminal = await service.flush(2_100);

    expect(terminal.failedDeliveryIds).toHaveLength(1);
    expect(service.listDeliveries()[0]).toMatchObject({ status: "failed", attempts: 2, lastError: "HTTP 503" });
    expect(service.list()[0]?.lastDelivery).toMatchObject({ status: "failed", attempts: 2, lastError: "HTTP 503" });
  });

  it("cancels queued retry work when its rule is disabled", async () => {
    const storage = memoryStorage();
    const service = new ArbitrageAlertService({
      storage,
      deliver: async () => {
        throw new Error("offline");
      },
      retryBaseMs: 100,
      now: () => 2_000
    });
    const rule = service.save(ruleInput(), 1_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20)]), 1_500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 2_000);
    service.save({ ...ruleInput(), id: rule.id, enabled: false }, 2_050);

    expect(service.listDeliveries()[0]).toMatchObject({ status: "cancelled", lastError: "Rule was updated before delivery" });
    expect(service.list()[0]?.lastDelivery).toMatchObject({ status: "cancelled", lastError: "Rule was updated before delivery" });
    expect((await service.flush(5_000)).attemptedDeliveryIds).toEqual([]);
  });

  it("fails alert eligibility closed for an unhealthy route dependency and untrusted route quality", async () => {
    const delivered: string[] = [];
    const service = new ArbitrageAlertService({ storage: memoryStorage(), deliver: async (payload) => delivered.push(payload.symbol ?? "") });
    service.save(ruleInput(), 1_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20)]), 1_500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)], [source("binance", "spot", false), source("binance", "perpetual", true), source("bybit", "spot", true), source("bybit", "perpetual", true)], true), 2_000);
    await service.evaluate(scan([{ ...opportunity("route-a", "BTCUSDT", 150), dataQuality: "skewed" }]), 3_000);

    expect(delivered).toEqual([]);
    expect(service.listDeliveries()).toEqual([]);
  });

  it("alerts an independent fresh route while a failed source blocks only dependent routes", async () => {
    const delivered: string[] = [];
    const service = new ArbitrageAlertService({ storage: memoryStorage(), deliver: async (payload) => delivered.push(payload.symbol ?? "") });
    service.save(ruleInput(), 1_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20, "binance", "bybit"), opportunity("route-b", "ETHUSDT", 20, "bybit", "binance")]), 1_500);

    const result = await service.evaluate(
      scan([opportunity("route-a", "BTCUSDT", 150, "binance", "bybit"), opportunity("route-b", "ETHUSDT", 150, "bybit", "binance")], [source("binance", "spot", true), source("binance", "perpetual", true), source("bybit", "spot", false), source("bybit", "perpetual", true)], true),
      2_000
    );

    expect(result.deliveredDeliveryIds).toHaveLength(1);
    expect(delivered).toEqual(["BTCUSDT"]);
  });

  it("does not turn stale or truncated absence into a duplicate re-crossing", async () => {
    const delivered: string[] = [];
    const service = new ArbitrageAlertService({ storage: memoryStorage(), deliver: async (payload) => delivered.push(payload.symbol ?? "") });
    service.save(ruleInput(), 1_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20)]), 1_500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 2_000);
    await service.evaluate({ ...scan([]), stale: true }, 3_000);
    await service.evaluate({ ...scan([]), truncated: true }, 4_000);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150)]), 5_000);

    expect(delivered).toEqual(["BTCUSDT"]);
  });

  it("coalesces pending market state while delivery is blocked and never replays an obsolete crossing", async () => {
    const delivered: string[] = [];
    let releaseFirstDelivery!: () => void;
    let markDeliveryStarted!: () => void;
    const firstDeliveryBlocked = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    let deliveries = 0;
    const service = new ArbitrageAlertService({
      storage: memoryStorage(),
      deliver: async (payload) => {
        delivered.push(payload.symbol ?? "");
        deliveries += 1;
        if (deliveries === 1) {
          markDeliveryStarted();
          await firstDeliveryBlocked;
        }
      },
      deliveryTimeoutMs: 60_000
    });
    service.save(ruleInput(), 500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20, "binance", "bybit", 1_000)]), 1_000);

    const firstCrossing = service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150, "binance", "bybit", 2_000)]), 2_000);
    await deliveryStarted;
    const pending = [
      service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20, "binance", "bybit", 63_000)]), 63_000),
      service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150, "binance", "bybit", 64_000)]), 64_000),
      service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20, "binance", "bybit", 65_000)]), 65_000)
    ];
    releaseFirstDelivery();
    await Promise.all([firstCrossing, ...pending]);

    expect(delivered).toEqual(["BTCUSDT"]);
    expect(service.listDeliveries()).toHaveLength(1);

    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150, "binance", "bybit", 66_000)]), 66_000);
    expect(delivered).toEqual(["BTCUSDT", "BTCUSDT"]);
  });

  it("recomputes source freshness when a queued snapshot is actually evaluated", async () => {
    const delivered: string[] = [];
    const service = new ArbitrageAlertService({ storage: memoryStorage(), deliver: async (payload) => delivered.push(payload.symbol ?? "") });
    service.save(ruleInput(), 500);
    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 20, "binance", "bybit", 1_000)]), 1_000);

    await service.evaluate(scan([opportunity("route-a", "BTCUSDT", 150, "binance", "bybit", 1_000)]), 20_000);

    expect(delivered).toEqual([]);
    expect(service.listDeliveries()).toEqual([]);
  });
});

describe("arbitrage alert HTTP contract", () => {
  it("keeps rules backward-compatible and adds bounded delivery status", async () => {
    const service = new ArbitrageAlertService({ storage: memoryStorage(), deliver: async () => {} });
    const app = express();
    const router = Router();
    registerArbitrageAlertRoutes(router, service, (_request, _response, next) => next());
    app.use(express.json());
    app.use(router);
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/arbitrage-alerts`;
    try {
      const created = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ruleInput()) });
      expect(created.status).toBe(200);
      const rule = ((await created.json()) as { rule: { id: string } }).rule;
      expect(rule.id).toBeTruthy();

      const response = await fetch(base);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rules: [{ id: rule.id }], deliveries: [] });
      expect((await fetch(`${base}/deliveries?limit=501`)).status).toBe(400);
      expect((await fetch(`${base}/deliveries?limit=10`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function ruleInput() {
  return {
    minimumNetEdgeBps: 100,
    minimumCapacityUsd: 100,
    estimatedNonFundingCostBps: 0,
    holdingHours: 0,
    cooldownSeconds: 60,
    enabled: true
  };
}

function opportunity(
  id: string,
  symbol: string,
  grossSpreadBps: number,
  spotExchange: ArbitrageOpportunity["spotExchange"] = "binance",
  futuresExchange: ArbitrageOpportunity["futuresExchange"] = "bybit",
  capturedAt = 1_000
): ArbitrageOpportunity {
  return {
    id,
    strategyKind: "cash-and-carry",
    edgeKind: "projected",
    identityScope: spotExchange === futuresExchange ? "venue-native" : "cross-venue-reviewed",
    symbol,
    assetId: symbol.replace(/USDT$/, ""),
    spotInstrumentId: `${spotExchange}:spot:${symbol}`,
    futuresInstrumentId: `${futuresExchange}:perpetual:${symbol}`,
    spotExchange,
    futuresExchange,
    spotBid: 99,
    spotAsk: 100,
    spotAskSize: 100,
    futuresBid: 102,
    futuresAsk: 103,
    futuresBidSize: 100,
    grossSpreadBps,
    estimatedTotalCostBps: 0,
    netEdgeBps: grossSpreadBps,
    topBookCapacityUsd: 10_000,
    topBookMatchedQuantity: 100,
    expectedNetProfitUsd: grossSpreadBps,
    fundingRate: 0,
    fundingScheduleVerified: false,
    spotExchangeTs: capturedAt,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: capturedAt,
    futuresExchangeTs: capturedAt,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: capturedAt,
    quoteAgeMs: 0,
    legSkewMs: 0,
    dataQuality: "fresh",
    capturedAt
  };
}

function scan(opportunities: ArbitrageOpportunity[], sources: ArbitrageScanResponse["sources"] = healthySources(), stale = false): ArbitrageScanResponse {
  return {
    updatedAt: 1_000,
    stale,
    scannedSymbols: opportunities.length,
    totalOpportunities: opportunities.length,
    truncated: false,
    estimatedTotalCostBps: 0,
    opportunities,
    sources
  };
}

function healthySources(): ArbitrageScanResponse["sources"] {
  return [source("binance", "spot", true), source("binance", "perpetual", true), source("bybit", "spot", true), source("bybit", "perpetual", true)];
}

function source(exchange: ArbitrageOpportunity["spotExchange"], market: "spot" | "perpetual", ok: boolean): ArbitrageScanResponse["sources"][number] {
  return { exchange, market, ok };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    get<T>(key: string): T | undefined {
      const value = values.get(key);
      return value === undefined ? undefined : clone(value as T);
    },
    set(key: string, value: unknown) {
      values.set(key, clone(value));
    }
  };
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}
