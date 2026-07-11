// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ChartDataPanel } from "../src/components/ChartDataPanel";

const candles = [
  { time: Date.UTC(2026, 0, 1, 10), open: 100, high: 106, low: 99, close: 104, volume: 1200 },
  { time: Date.UTC(2026, 0, 1, 11), open: 104, high: 108, low: 102, close: 107, volume: 1500 }
];

describe("ChartDataPanel", () => {
  it("exposes focused OHLC, signals and trades through native tables", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <ChartDataPanel
          candles={candles}
          decimals={2}
          focusedIndex={0}
          signals={[{ time: candles[0].time, price: 104, kind: "buy", label: "Breakout" }]}
          trades={[
            {
              entryTime: candles[0].time,
              entryPrice: 104,
              exitTime: candles[1].time,
              exitPrice: 107,
              direction: "long",
              reason: "target",
              pnl: 3
            }
          ]}
          symbol="BTCUSDT"
          timeframe="1h"
          summaryId="chart-summary"
        />
      )
    );

    const summary = container.querySelector("#chart-summary");
    expect(summary?.textContent).toContain("Focused candle close 104.00");

    const toggle = container.querySelector<HTMLButtonElement>(".chart-data-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-controls")).toBe("chart-summary-panel");
    await act(async () => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const tables = [...container.querySelectorAll("table")];
    expect(tables).toHaveLength(4);
    expect(tables[0].querySelector("caption")?.textContent).toBe("Focused candle");
    expect([...tables[0].querySelectorAll('th[scope="col"]')].map((cell) => cell.textContent)).toEqual(["Time", "Open", "High", "Low", "Close", "Volume"]);
    expect(tables[0].textContent).toContain("104.00");
    expect(tables[2].textContent).toContain("Breakout");
    expect(tables[3].textContent).toContain("target");
    expect(tables[3].textContent).toContain("3.00");

    await act(async () => root.unmount());
  });

  it("uses informative empty rows while chart data loads", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<ChartDataPanel candles={[]} decimals={2} symbol="EURUSD" timeframe="1m" summaryId="empty-summary" />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

    expect(container.textContent).toContain("Market data is loading.");
    expect(container.textContent).toContain("No strategy signals.");
    expect(container.textContent).toContain("No executed trades.");

    await act(async () => root.unmount());
  });
});
