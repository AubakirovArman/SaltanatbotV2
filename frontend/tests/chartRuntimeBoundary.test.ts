import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../src/app/ChartWorkspaceRuntime.tsx", import.meta.url), "utf8");
const alertFeed = readFileSync(new URL("../src/market/PriceAlertFeed.tsx", import.meta.url), "utf8");
const watchlistQuotes = readFileSync(new URL("../src/components/WatchlistQuotePanel.tsx", import.meta.url), "utf8");
const multiChart = readFileSync(new URL("../src/components/MultiChartWorkspace.tsx", import.meta.url), "utf8");
const chartCanvas = readFileSync(new URL("../src/components/ChartCanvas.tsx", import.meta.url), "utf8");

describe("chart runtime ownership boundary", () => {
  it("keeps high-frequency chart hooks out of the application root", () => {
    for (const hook of ["useMarketStream", "useSparklines", "useCompareSeries", "useLivePositions"]) {
      expect(app).not.toContain(`${hook}(`);
    }
    expect(app).toContain('mode === "chart" ? (');
    expect(app).toContain("<ChartWorkspaceRuntime");
  });

  it("owns chart subscriptions inside the monitoring-only runtime", () => {
    expect(runtime).toContain("useMarketStream(");
    expect(runtime).not.toContain("useSparklines(");
    expect(runtime).toContain("useCompareSeries(");
    expect(runtime).toContain("useLivePositions(");
    expect(runtime).toContain("onPrimaryOperationalChange");
  });

  it("isolates watchlist quote state below the chart runtime", () => {
    expect(runtime).toContain("<WatchlistQuotePanel");
    expect(runtime).toContain("enabled={watchlistVisible}");
    expect(runtime).toContain("exchange={activeExchange}");
    expect(runtime).toContain("marketType={activeMarketType}");
    expect(runtime).toContain("priceType={activePriceType}");
    expect(watchlistQuotes).toContain("useSparklines(");
    expect(watchlistQuotes).toContain(".slice(0, 40)");
    expect(watchlistQuotes).toContain('recordBrowserRender("WatchlistQuotePanel")');
  });

  it("subscribes the background alert feed only to armed alert symbols", () => {
    expect(alertFeed).toContain("if (alert.triggered) continue");
    expect(alertFeed).toContain("enabled: symbols.length > 0");
  });

  it("pauses hidden chart resources without unmounting pane state", () => {
    expect(runtime).toContain("operational={primaryOperational}");
    expect(multiChart).toContain("operational={operational}");
    expect(chartCanvas).toContain("enabled={operational && showOrderBookHeatmap");
    expect(chartCanvas).toContain("enabled={operational && showTradeFootprint");
    expect(chartCanvas).toContain("previous.operational === false && next.operational === false");
  });
});
