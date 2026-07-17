// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateAlertPrices, loadAlerts, parseStoredPriceAlert, type PriceAlert } from "../src/market/alerts";
import { groupPriceAlertSubscriptions } from "../src/market/PriceAlertFeed";
import type { ChartDataRoute } from "../src/types";

const spot: ChartDataRoute = { exchange: "binance", marketType: "spot", priceType: "last" };
const mark: ChartDataRoute = { exchange: "binance", marketType: "linear", priceType: "mark" };

describe("route-aware price alerts", () => {
  beforeEach(() => localStorage.clear());

  it("migrates route-less legacy rows to the explicit fallback and rejects partial routes", () => {
    const legacy = { id: "legacy", symbol: "BTCUSDT", price: 100, direction: "above", createdAt: 1, triggered: false };
    localStorage.setItem("sbv2:alerts", JSON.stringify([legacy, { ...legacy, id: "partial", exchange: "bybit" }]));

    expect(loadAlerts(undefined, mark)).toEqual([{ ...legacy, ...mark }]);
    expect(groupPriceAlertSubscriptions(loadAlerts(undefined, mark))).toEqual([]);
  });

  it("parses bounded migration metadata without inventing a legacy timeframe", () => {
    const parsed = parseStoredPriceAlert({
      id: "local",
      clientId: "browser-alert:local",
      symbol: "BTCUSDT",
      price: 100,
      direction: "above",
      timeframe: "5m",
      createdAt: 1,
      triggered: false,
      source: "browser",
      suspended: true,
      syncState: "syncing",
      serverRuleId: "00000000-0000-4000-8000-000000000041",
      serverRevision: 2,
      serverLifecycle: "disabled",
      ...spot
    });
    expect(parsed).toMatchObject({ timeframe: "5m", source: "browser", suspended: true, syncState: "syncing", serverRevision: 2 });
    expect(parseStoredPriceAlert({ id: "legacy", symbol: "BTCUSDT", price: 100, direction: "above", createdAt: 1, triggered: false }, spot)).not.toHaveProperty("timeframe");
  });

  it("fires only alerts whose complete market route matches the received prices", () => {
    const spotAlert = alert("spot", "BTCUSDT", spot);
    const markAlert = alert("mark", "BTCUSDT", mark);

    const result = evaluateAlertPrices([spotAlert, markAlert], mark, { BTCUSDT: 101 });

    expect(result.alerts.map(({ triggered }) => triggered)).toEqual([false, true]);
    expect(result.fired).toEqual([{ alert: { ...markAlert, triggered: true }, hitPrice: 101 }]);
  });

  it("deduplicates symbols per route and splits every route into batches of at most 40", () => {
    const alerts = Array.from({ length: 83 }, (_, index) => alert(`spot-${index}`, `S${String(index).padStart(3, "0")}`, spot));
    alerts.push(alert("duplicate", "S000", spot));
    alerts.push(alert("mark", "BTCUSDT", mark));
    alerts.push({ ...alert("triggered", "IGNORED", mark), triggered: true });

    const batches = groupPriceAlertSubscriptions(alerts);

    expect(batches.map(({ route, timeframe, symbols }) => [route.marketType, route.priceType, timeframe, symbols.length])).toEqual([
      ["linear", "mark", "1m", 1],
      ["spot", "last", "1m", 40],
      ["spot", "last", "1m", 40],
      ["spot", "last", "1m", 3]
    ]);
    expect(batches.flatMap(({ symbols }) => symbols).filter((symbol) => symbol === "S000")).toHaveLength(1);
    expect(batches.flatMap(({ symbols }) => symbols)).not.toContain("IGNORED");
  });

  it("keeps identical routes on different explicit timeframes in separate subscriptions", () => {
    const oneMinute = alert("one", "BTCUSDT", spot);
    const fiveMinutes = { ...alert("five", "BTCUSDT", spot), timeframe: "5m" as const };

    expect(groupPriceAlertSubscriptions([fiveMinutes, oneMinute]).map(({ timeframe, symbols }) => ({ timeframe, symbols }))).toEqual([
      { timeframe: "1m", symbols: ["BTCUSDT"] },
      { timeframe: "5m", symbols: ["BTCUSDT"] }
    ]);
  });
});

function alert(id: string, symbol: string, route: ChartDataRoute): PriceAlert {
  return { id, symbol, price: 100, direction: "above", timeframe: "1m", createdAt: 1, triggered: false, ...route };
}
