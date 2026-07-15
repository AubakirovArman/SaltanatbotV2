import { describe, expect, it } from "vitest";
import { AccountTelemetryService, collectBinanceTelemetry, collectBybitTelemetry, collectStablecoinFx, parseAccountTelemetryQuery, type AccountTelemetryRequest, type BinanceTelemetryRequester, type BybitTelemetryRequester, type ReadonlyTelemetryResponse } from "../src/arbitrage/telemetry/index.js";
import { UpstreamResourceGovernor } from "../src/arbitrage/upstream/resourceGovernor/index.js";

const NOW = 1_800_000_000_000;
const request: AccountTelemetryRequest = {
  venues: ["binance", "bybit"],
  symbols: ["BTCUSDT", "ETHUSDT"],
  assets: ["BTC", "USDT", "USDC"],
  stableAssets: ["USDC"]
};

describe("account economics telemetry", () => {
  it("normalizes signed Binance fees, borrow and network state without claiming a future fee asset", async () => {
    const snapshot = await collectBinanceTelemetry(binanceRequester(), request, () => NOW, new AbortController().signal);
    expect(snapshot.status).toBe("fresh");
    expect(snapshot.fees).toHaveLength(4);
    expect(snapshot.fees.find((row) => row.market === "spot" && row.symbol === "BTCUSDT")).toMatchObject({
      makerBps: 1.2,
      takerBps: 2.2,
      feeAsset: { status: "conditional", discountAsset: "BNB", discountEnabled: true, actualFillRequired: true },
      usableForSettlementAccounting: false
    });
    expect(snapshot.fees.find((row) => row.market === "perpetual" && row.symbol === "BTCUSDT")).toMatchObject({ makerBps: 2, takerBps: 4, tierId: "fee-tier-1", feeAsset: { status: "conditional", discountAsset: "BNB", discountEnabled: true } });
    expect(snapshot.borrow.find((row) => row.asset === "BTC")).toMatchObject({
      availableQuantity: 3,
      accountLimitQuantity: 10,
      annualRateBps: 87.6,
      recallStatus: "unknown",
      usableForNonRecallableRoutes: false
    });
    expect(snapshot.transferNetworks.find((row) => row.asset === "BTC")).toMatchObject({ depositEnabled: true, withdrawEnabled: true, fixedWithdrawFee: 0.0002, usableForTransfer: true });
  });

  it("uses the Bybit envelope timestamp and keeps recallability fail-closed", async () => {
    const snapshot = await collectBybitTelemetry(bybitRequester(), request, () => NOW, new AbortController().signal);
    expect(snapshot.status).toBe("fresh");
    expect(snapshot.fees).toHaveLength(4);
    expect(snapshot.fees[0]).toMatchObject({ venue: "bybit", evidence: { timestampQuality: "venue", fresh: true }, usableForSettlementAccounting: false });
    expect(snapshot.borrow.find((row) => row.asset === "USDC")).toMatchObject({ borrowable: true, annualRateBps: 43.8, recallStatus: "unknown", usableForNonRecallableRoutes: false });
    expect(snapshot.transferNetworks.find((row) => row.asset === "USDC")).toMatchObject({ percentageWithdrawFeeBps: 10, usableForTransfer: true });
  });

  it("combines both protected venues with venue-timestamped stablecoin provenance", async () => {
    let publicCalls = 0;
    const service = new AccountTelemetryService({
      keys: () => ({ apiKey: "account-key", apiSecret: "account-secret" }),
      now: () => NOW,
      binanceRequester: binanceRequester(),
      bybitRequester: bybitRequester(),
      publicGovernor: false,
      fetch: async (input) => {
        publicCalls += 1;
        const url = String(input);
        if (url.includes("binance")) return Response.json({ symbol: "USDCUSDT", bidPrice: "0.9998", bidQty: "10", askPrice: "1.0001", askQty: "11" });
        return Response.json({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "USDCUSDT", bid1Price: "0.9997", bid1Size: "9", ask1Price: "1.0002", ask1Size: "8" }] }, time: NOW });
      }
    });
    const snapshot = await service.snapshot(request);
    expect(snapshot).toMatchObject({ schemaVersion: 1, readOnly: true, complete: true });
    expect(snapshot.stablecoinFx).toHaveLength(2);
    expect(snapshot.stablecoinFx.find((row) => row.venue === "binance")).toMatchObject({ usableForEconomics: false, evidence: { timestampQuality: "receive-time" } });
    expect(snapshot.stablecoinFx.find((row) => row.venue === "bybit")).toMatchObject({ usableForEconomics: true, evidence: { timestampQuality: "venue" } });
    expect(snapshot.readiness).toMatchObject({ feeRates: true, feeAssets: false, borrowCapacityAndRate: true, borrowRecall: false, transferNetworks: true, stablecoinFx: true, executable: false });
    expect(snapshot.readiness.blockers).toContain("future commission asset is execution-dependent; authenticated fills remain mandatory");
    expect(JSON.stringify(snapshot)).not.toContain("account-key");
    expect(JSON.stringify(snapshot)).not.toContain("account-secret");
    expect((await service.snapshot(request)).generatedAt).toBe(snapshot.generatedAt);
    expect(publicCalls).toBe(2);
  });

  it("opens the account circuit after repeated total upstream failures and never emits stale evidence", async () => {
    let calls = 0;
    const failing: BinanceTelemetryRequester = {
      async read() {
        calls += 1;
        throw new Error("fixture unavailable");
      }
    };
    let clock = NOW;
    const governor = new UpstreamResourceGovernor({
      "binance.account-telemetry": { maxConcurrent: 1, failureThreshold: 3, cooldownMs: 30_000 },
      "bybit.account-telemetry": { maxConcurrent: 1, failureThreshold: 3, cooldownMs: 30_000 }
    }, () => clock);
    const service = new AccountTelemetryService({
      keys: () => ({ apiKey: "account-key", apiSecret: "account-secret" }),
      now: () => clock,
      governor,
      binanceRequester: failing,
      publicGovernor: false,
      fetch: async () => Response.json({ symbol: "USDCUSDT", bidPrice: "0.99", askPrice: "1.01" })
    });
    const input = { ...request, venues: ["binance"] as const };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await service.snapshot(input);
      expect(snapshot.venues[0]).toMatchObject({ status: "unavailable", fees: [], borrow: [], transferNetworks: [] });
      clock += 1;
    }
    const beforeCircuitRejection = calls;
    const rejected = await service.snapshot(input);
    expect(calls).toBe(beforeCircuitRejection);
    expect(rejected.governor.sources.find((row) => row.source === "binance.account-telemetry")).toMatchObject({ state: "open", counters: { circuitRejected: 1 } });
    expect(rejected.readiness.executable).toBe(false);
    expect(rejected.validUntil).toBeLessThanOrEqual(rejected.generatedAt);
  });

  it("strictly bounds and validates the HTTP query", () => {
    expect(parseAccountTelemetryQuery({})).toMatchObject({ success: true, value: { venues: ["binance", "bybit"], symbols: ["BTCUSDT", "ETHUSDT"] } });
    expect(parseAccountTelemetryQuery({ symbols: "A,B,C" })).toEqual({ success: false, error: "symbols must contain one or two uppercase venue symbols" });
    expect(parseAccountTelemetryQuery({ stableAssets: "USDT" })).toEqual({ success: false, error: "stableAssets must contain one to three non-USDT asset codes" });
    expect(parseAccountTelemetryQuery({ venues: "kraken" })).toEqual({ success: false, error: "venues must contain binance and/or bybit" });
  });

  it("does not poison the shared public circuit for an unsupported stablecoin pair", async () => {
    const governor = new UpstreamResourceGovernor({ "binance.public-rest": { maxConcurrent: 1, failureThreshold: 1, cooldownMs: 30_000 } }, () => NOW);
    const result = await collectStablecoinFx({ ...request, venues: ["binance"], stableAssets: ["UNLISTED"] }, new AbortController().signal, {
      now: () => NOW,
      governor,
      fetch: async () => new Response('{"code":-1121}', { status: 400 })
    });
    expect(result).toMatchObject({ quotes: [], issues: [{ code: "unavailable", dimension: "stablecoin-fx" }] });
    expect(governor.sourceSnapshot("binance.public-rest")).toMatchObject({ state: "closed", counters: { ignored: 1, failed: 0 } });
  });
});

function binanceRequester(): BinanceTelemetryRequester {
  return {
    async read(target, path, params): Promise<ReadonlyTelemetryResponse> {
      if (path === "/api/v3/account/commission") {
        return response({
          symbol: params.symbol,
          standardCommission: { maker: "0.00010", taker: "0.00020", buyer: "0.00001", seller: "0.00002" },
          specialCommission: { maker: "0", taker: "0", buyer: "0", seller: "0" },
          taxCommission: { maker: "0", taker: "0", buyer: "0", seller: "0" },
          discount: { enabledForAccount: true, enabledForSymbol: true, discountAsset: "BNB", discount: "0.75" }
        });
      }
      if (path === "/fapi/v1/commissionRate" && target === "futures") return response({ symbol: params.symbol, makerCommissionRate: "0.0002", takerCommissionRate: "0.0004", rpiCommissionRate: "0.00005" });
      if (path === "/fapi/v1/accountConfig" && target === "futures") return response({ feeTier: 1 });
      if (path === "/fapi/v1/feeBurn" && target === "futures") return response({ feeBurn: true });
      if (path === "/sapi/v1/margin/maxBorrowable") return response({ amount: params.asset === "BTC" ? "3" : "1000", borrowLimit: params.asset === "BTC" ? "10" : "5000" });
      if (path === "/sapi/v1/margin/next-hourly-interest-rate") return response(params.assets!.split(",").map((asset) => ({ asset, nextHourlyInterestRate: asset === "BTC" ? "0.000001" : "0.0000005" })));
      if (path === "/sapi/v1/capital/config/getall") {
        return response(request.assets.map((asset) => ({ coin: asset, networkList: [{ network: asset === "BTC" ? "BTC" : "ETH", name: "Fixture network", depositEnable: true, withdrawEnable: true, withdrawFee: asset === "BTC" ? "0.0002" : "1", withdrawMin: "0.001", withdrawMax: "1000", minConfirm: 2, unLockConfirm: 3, estimatedArrivalTime: 5, busy: false }] })));
      }
      throw new Error(`Unexpected Binance fixture endpoint ${path}`);
    }
  };
}

function bybitRequester(): BybitTelemetryRequester {
  return {
    async read(path, params): Promise<ReadonlyTelemetryResponse> {
      if (path === "/v5/account/fee-rate") return bybit({ list: [{ symbol: params.symbol, makerFeeRate: "0.0001", takerFeeRate: "0.0006" }] });
      if (path === "/v5/account/collateral-info") {
        return bybit({ list: request.assets.map((currency) => ({ currency, hourlyBorrowRate: currency === "USDC" ? "0.0000005" : "0.000001", maxBorrowingAmount: "10000", availableToBorrow: "9000", borrowable: true, borrowUsageRate: "0.1" })) });
      }
      if (path === "/v5/asset/coin/query-info") {
        return bybit({ rows: [{ coin: params.coin, chains: [{ chain: params.coin === "BTC" ? "BTC" : "ETH", chainType: "Fixture network", confirmation: "2", withdrawFee: "0.1", depositMin: "0", withdrawMin: "1", minAccuracy: "8", chainDeposit: "1", chainWithdraw: "1", withdrawPercentageFee: "0.001", safeConfirmNumber: "3", withdrawMax: "10000" }] }] });
      }
      throw new Error(`Unexpected Bybit fixture endpoint ${path}`);
    }
  };
}

function response(payload: unknown): ReadonlyTelemetryResponse {
  return { payload, receivedAt: NOW };
}

function bybit(result: unknown): ReadonlyTelemetryResponse {
  return response({ retCode: 0, retMsg: "OK", result, time: NOW });
}
