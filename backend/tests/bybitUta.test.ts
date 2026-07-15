import { describe, expect, it } from "vitest";
import { assertBorrowAllowed, BybitUtaService, type BybitUtaSnapshot } from "../src/trading/bybitUta.js";
import type { BybitMethod } from "../src/trading/exchange/bybitClient.js";

class FakeClient {
  calls: Array<{ method: BybitMethod; path: string; params: Record<string, unknown> }> = [];

  async request<T>(method: BybitMethod, path: string, params: Record<string, unknown> = {}): Promise<{ result: T }> {
    this.calls.push({ method, path, params });
    if (path === "/v5/account/wallet-balance") return result(wallet()) as { result: T };
    if (path === "/v5/account/info") return result({ unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN" }) as { result: T };
    if (path === "/v5/account/collateral-info") return result({ list: collateral() }) as { result: T };
    if (path === "/v5/account/borrow-history") return result({ list: [{ currency: "USDT", createdTime: "1000", borrowAmount: "100", InterestBearingBorrowSize: "90", hourlyBorrowRate: "0.00001", borrowCost: "0.001", freeBorrowedAmount: "10" }] }) as { result: T };
    if (path.includes("repay")) return result({ resultStatus: "P" }) as { result: T };
    return result({ coin: String(params.coin ?? ""), amount: String(params.amount ?? "") }) as { result: T };
  }
}

describe("Bybit UTA service", () => {
  it("normalizes collateral, liabilities and account-wide risk fields", async () => {
    const snapshot = await new BybitUtaService(new FakeClient()).snapshot();

    expect(snapshot.account).toMatchObject({ unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN", totalEquity: 50_000, accountMmRate: 0.1 });
    expect(snapshot.assets.find((asset) => asset.coin === "BTC")).toMatchObject({ walletBalance: 1, usdValue: 49_000, collateralEnabled: true, marginCollateral: true });
    expect(snapshot.assets.find((asset) => asset.coin === "USDT")).toMatchObject({ borrowAmount: 100, spotBorrow: 40, derivativesBorrow: 60, availableToBorrow: 900 });
    expect(snapshot.borrowHistory[0]).toMatchObject({ coin: "USDT", borrowAmount: 100, interestBearingAmount: 90 });
    expect(snapshot.risk).toMatchObject({ level: "warning", entryAllowed: true, maxBorrowUsageRate: 0.1 });
  });

  it("blocks new debt when account or projected borrow usage exceeds a hard guard", () => {
    const base = safeSnapshot();
    expect(() => assertBorrowAllowed({ ...base, account: { ...base.account, accountMmRate: 0.5 }, risk: { ...base.risk, entryAllowed: false, reasons: ["high MMR"] } }, "USDT", 1)).toThrow(/risk guard/i);
    expect(() => assertBorrowAllowed(base, "USDT", 750)).toThrow(/80% usage guard/i);
    expect(() => assertBorrowAllowed(base, "DOGE", 1)).toThrow(/not currently borrowable/i);
  });

  it("uses explicit variable-rate borrow and safe no-conversion repay endpoints", async () => {
    const client = new FakeClient();
    const service = new BybitUtaService(client);

    await service.borrow("USDT", 25);
    await service.repay({ coin: "USDT", amount: 10, repaymentType: "FLEXIBLE", convertCollateral: false });
    await service.repay({ coin: "USDT", repaymentType: "ALL", convertCollateral: true });

    expect(client.calls.find((call) => call.path === "/v5/account/borrow")).toMatchObject({ method: "POST", params: { coin: "USDT", amount: "25" } });
    expect(client.calls.find((call) => call.path === "/v5/account/no-convert-repay")).toMatchObject({ method: "POST", params: { coin: "USDT", amount: "10", repaymentType: "FLEXIBLE" } });
    expect(client.calls.find((call) => call.path === "/v5/account/repay")).toMatchObject({ method: "POST", params: { coin: "USDT", repaymentType: "ALL" } });
  });

  it("asserts the current authorization lease after preflight and before every UTA POST", async () => {
    const client = new FakeClient();
    const events: string[] = [];
    const service = new BybitUtaService(client, async () => {
      events.push("revalidate");
      return {
        assertCurrent() {
          events.push("assert");
          return false;
        }
      };
    });

    await expect(service.borrow("USDT", 25)).rejects.toThrow(/authorization changed/i);
    expect(events).toEqual(["revalidate", "assert"]);
    expect(client.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("changes only supported collateral coins", async () => {
    const client = new FakeClient();
    const service = new BybitUtaService(client);

    await service.setCollateral("BTC", true);
    expect(client.calls.find((call) => call.path === "/v5/account/set-collateral-switch")).toMatchObject({ params: { coin: "BTC", collateralSwitch: "ON" } });
    await expect(service.setCollateral("USDT", false)).rejects.toThrow(/managed by Bybit/i);
  });
});

function result<T>(value: T): { result: T } {
  return { result: value };
}

function wallet() {
  return { list: [{
    accountIMRate: "0.2", accountMMRate: "0.1", totalEquity: "50000", totalWalletBalance: "49000", totalMarginBalance: "49500", totalAvailableBalance: "39000", totalPerpUPL: "500", totalInitialMargin: "10000", totalMaintenanceMargin: "5000",
    coin: [
      { coin: "BTC", equity: "1", walletBalance: "1", usdValue: "49000", borrowAmount: "0", spotBorrow: "0", accruedInterest: "0", marginCollateral: true, collateralSwitch: true, colRes: "0" },
      { coin: "USDT", equity: "-100", walletBalance: "0", usdValue: "-100", borrowAmount: "100", spotBorrow: "40", accruedInterest: "0.01", marginCollateral: true, collateralSwitch: true, colRes: "0" }
    ]
  }] };
}

function collateral() {
  return [
    { currency: "BTC", hourlyBorrowRate: "0.000001", maxBorrowingAmount: "10", availableToBorrow: "9", borrowUsageRate: "0.1", borrowAmount: "1", borrowable: true, marginCollateral: true, collateralSwitch: true },
    { currency: "USDT", hourlyBorrowRate: "0.00001", maxBorrowingAmount: "1000", availableToBorrow: "900", borrowUsageRate: "0.1", borrowAmount: "100", borrowable: true, marginCollateral: true, collateralSwitch: true }
  ];
}

function safeSnapshot(): BybitUtaSnapshot {
  return {
    updatedAt: 1,
    account: { unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN", totalEquity: 50_000, totalWalletBalance: 50_000, totalMarginBalance: 50_000, totalAvailableBalance: 45_000, totalPerpUpl: 0, totalInitialMargin: 5_000, totalMaintenanceMargin: 1_000, accountImRate: 0.1, accountMmRate: 0.02 },
    assets: [
      { coin: "BTC", equity: 1, usdValue: 49_000, walletBalance: 1, borrowAmount: 0, spotBorrow: 0, derivativesBorrow: 0, accruedInterest: 0, unrealisedPnl: 0, marginCollateral: true, collateralEnabled: true, collateralRestriction: "none", hourlyBorrowRate: 0, maxBorrowingAmount: 10, availableToBorrow: 10, borrowUsageRate: 0, borrowable: true },
      { coin: "USDT", equity: 0, usdValue: 0, walletBalance: 0, borrowAmount: 100, spotBorrow: 100, derivativesBorrow: 0, accruedInterest: 0, unrealisedPnl: 0, marginCollateral: true, collateralEnabled: true, collateralRestriction: "none", hourlyBorrowRate: 0.00001, maxBorrowingAmount: 1_000, availableToBorrow: 900, borrowUsageRate: 0.1, borrowable: true }
    ],
    borrowHistory: [],
    risk: { level: "warning", entryAllowed: true, reasons: [], maxBorrowUsageRate: 0.1 },
    limits: { maxBorrowUsageRate: 0.8, maxAccountMmRate: 0.5 }
  };
}
