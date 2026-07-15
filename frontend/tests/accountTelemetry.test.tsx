// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { accountTelemetrySearch, parseAccountTelemetrySnapshot } from "../src/trading/accountTelemetry";
import { AccountTelemetryView } from "../src/trading/components/AccountTelemetryPanel";

describe("protected account telemetry browser contract", () => {
  it("strictly parses the conservative safety boundary and encodes bounded queries", () => {
    const snapshot = parseAccountTelemetrySnapshot(fixture());
    expect(snapshot).toMatchObject({ schemaVersion: 1, readOnly: true, complete: true, readiness: { executable: false, feeAssets: false, borrowRecall: false } });
    expect(snapshot.venues[0]?.fees[0]).toMatchObject({ symbol: "BTCUSDT", takerBps: 5, usableForRateRanking: true });
    expect(accountTelemetrySearch({ venues: ["bybit", "binance"], symbols: ["btcusdt"], assets: ["btc", "usdt"], stableAssets: ["usdc"] })).toBe("venues=bybit%2Cbinance&symbols=BTCUSDT&assets=BTC%2CUSDT&stableAssets=USDC");
  });

  it("rejects executable, recalled or crossed-FX claims", () => {
    const unsafe = fixture();
    unsafe.readiness.executable = true;
    expect(() => parseAccountTelemetrySnapshot(unsafe)).toThrow(/unsafe readiness flags/);

    const crossed = fixture();
    crossed.stablecoinFx[0]!.bid = 1.01;
    crossed.stablecoinFx[0]!.ask = 1;
    expect(() => parseAccountTelemetrySnapshot(crossed)).toThrow(/FX book is invalid or crossed/);
  });

  it("renders Russian account-scoped evidence without an execution action", () => {
    const html = renderToStaticMarkup(<AccountTelemetryView locale="ru" snapshot={parseAccountTelemetrySnapshot(fixture())} />);
    expect(html).toContain("Комиссии аккаунта");
    expect(html).toContain("Доступный займ");
    expect(html).toContain("BTCUSDT");
    expect(html).toContain("Гарантия отсутствия отзыва");
    expect(html).not.toContain("Выставить ордер");
    expect(html).not.toContain("apiSecret");
  });
});

function fixture() {
  const evidence = {
    source: "bybit:/v5/account/fee-rate",
    version: "account-telemetry-v1",
    asOf: 2_000,
    validUntil: 32_000,
    timestampQuality: "venue",
    fresh: true
  };
  return {
    schemaVersion: 1,
    readOnly: true,
    generatedAt: 2_000,
    validUntil: 32_000,
    complete: true,
    request: { venues: ["bybit"], symbols: ["BTCUSDT"], assets: ["BTC"], stableAssets: ["USDC"] },
    venues: [
      {
        venue: "bybit",
        configured: true,
        status: "fresh",
        generatedAt: 2_000,
        validUntil: 32_000,
        fees: [
          {
            venue: "bybit",
            market: "perpetual",
            symbol: "BTCUSDT",
            tierId: "account-symbol",
            makerBps: 2,
            takerBps: 5,
            feeAsset: { status: "execution-dependent", actualFillRequired: true },
            usableForRateRanking: true,
            evidence
          }
        ],
        borrow: [
          {
            venue: "bybit",
            asset: "BTC",
            availableQuantity: 0.5,
            accountLimitQuantity: 1,
            annualRateBps: 1_200,
            rateBasis: "current-hourly-annualized",
            borrowable: true,
            recallStatus: "unknown",
            usableForProjectedCost: true,
            usableForNonRecallableRoutes: false,
            evidence
          }
        ],
        transferNetworks: [
          {
            venue: "bybit",
            asset: "BTC",
            network: "BTC",
            depositEnabled: true,
            withdrawEnabled: true,
            fixedWithdrawFee: 0.0001,
            estimatedArrivalMinutes: 20,
            usableForTransfer: true,
            evidence
          }
        ],
        issues: []
      }
    ],
    stablecoinFx: [
      {
        venue: "bybit",
        baseAsset: "USDC",
        quoteAsset: "USDT",
        symbol: "USDCUSDT",
        bid: 0.999,
        ask: 1.001,
        usableForEconomics: true,
        evidence
      }
    ],
    issues: [],
    readiness: {
      feeRates: true,
      feeAssets: false,
      borrowCapacityAndRate: true,
      borrowRecall: false,
      transferNetworks: true,
      stablecoinFx: true,
      executable: false,
      blockers: ["Borrow recall is not proven"]
    },
    governor: { healthy: true, sources: [] }
  };
}
