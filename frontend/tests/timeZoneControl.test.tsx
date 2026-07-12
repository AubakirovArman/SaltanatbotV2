// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TimeZoneControl } from "../src/components/chartCanvas/TimeZoneControl";
import { ChartPriceHud } from "../src/components/chartCanvas/ChartPriceHud";

describe("TimeZoneControl", () => {
  it("uses a labelled native select and emits a validated zone", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onChange = vi.fn();
    await act(async () => root.render(<TimeZoneControl chartId="chart-2" locale="ru" value="UTC" onChange={onChange} />));
    const label = container.querySelector("label");
    const select = container.querySelector("select")!;
    expect(label?.textContent).toContain("Часовой пояс");
    expect(label?.htmlFor).toBe("chart-2-time-zone");
    expect(select.name).toBe("chart-time-zone");
    expect(select.options).toHaveLength(9);
    await act(async () => {
      select.value = "Asia/Almaty";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Asia/Almaty");
    await act(async () => root.unmount());
  });

  it("keeps hook order stable while an initially empty pane receives data", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<ChartPriceHud timeframe="1m" decimals={2} locale="en" timeZone="UTC" />));
    await act(async () => root.render(<ChartPriceHud
      latest={{ time: Date.UTC(2026, 6, 12), open: 100, high: 101, low: 99, close: 101, volume: 10 }}
      timeframe="1m"
      decimals={2}
      locale="en"
      timeZone="Asia/Almaty"
    />));
    expect(container.textContent).toBe("");
    await act(async () => root.unmount());
  });
});
