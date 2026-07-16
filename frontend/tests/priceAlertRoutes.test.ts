// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateAlertPrices, loadAlerts, type PriceAlert } from "../src/market/alerts";
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

    expect(batches.map(({ route, symbols }) => [route.marketType, route.priceType, symbols.length])).toEqual([
      ["linear", "mark", 1],
      ["spot", "last", 40],
      ["spot", "last", 40],
      ["spot", "last", 3]
    ]);
    expect(batches.flatMap(({ symbols }) => symbols).filter((symbol) => symbol === "S000")).toHaveLength(1);
    expect(batches.flatMap(({ symbols }) => symbols)).not.toContain("IGNORED");
  });
});

function alert(id: string, symbol: string, route: ChartDataRoute): PriceAlert {
  return { id, symbol, price: 100, direction: "above", createdAt: 1, triggered: false, ...route };
}
