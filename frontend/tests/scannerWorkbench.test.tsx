// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ScannerWorkbench, type ScannerVisualRow } from "../src/arbitrage/ScannerWorkbench";
import { SCANNER_WORKSPACE_STORAGE_KEY } from "../src/arbitrage/scannerPrefs";

const columns = [
  { id: "route", label: "Route", required: true },
  { id: "net", label: "Net" },
  { id: "actions", label: "Actions", required: true }
];
const rows: ScannerVisualRow[] = [
  {
    id: "route-a",
    label: "BTCUSDT",
    subtitle: "Binance → Bybit",
    heatValue: 120,
    nodes: [{ label: "Binance", detail: "spot" }, { label: "BTCUSDT" }, { label: "Bybit", detail: "perpetual" }],
    metrics: [
      { key: "primary", label: "Net", value: 120, formatted: "+1.20%" },
      { key: "secondary", label: "P&L", value: 12, formatted: "$12" },
      { key: "capacity", label: "Capacity", value: 1_000, formatted: "$1,000" },
      { key: "freshness", label: "Freshness", value: -5, formatted: "5 ms" }
    ]
  },
  {
    id: "route-b",
    label: "ETHUSDT",
    subtitle: "Bybit → Binance",
    heatValue: 80,
    nodes: [{ label: "Bybit", detail: "spot" }, { label: "ETHUSDT" }, { label: "Binance", detail: "perpetual" }],
    metrics: [
      { key: "primary", label: "Net", value: 80, formatted: "+0.80%" },
      { key: "secondary", label: "P&L", value: 8, formatted: "$8" },
      { key: "capacity", label: "Capacity", value: 800, formatted: "$800" },
      { key: "freshness", label: "Freshness", value: -9, formatted: "9 ms" }
    ]
  }
];

describe("ScannerWorkbench", () => {
  beforeEach(() => localStorage.clear());

  it("renders a semantic heatmap with exact values in Russian", () => {
    storeView("heatmap");
    const html = render("ru");
    expect(html).toContain("Тепловая карта возможностей");
    expect(html).toContain("<ol>");
    expect(html).toContain("+1.20%");
    expect(html).toContain("Место 1");
    expect(html).not.toContain("data-table-child");
  });

  it("renders an informative route SVG and a semantic comparison table in Kazakh", () => {
    storeView("compare", ["route-a", "route-b"]);
    const html = render("kk");
    expect(html).toContain('role="img"');
    expect(html).toContain("BTCUSDT бағытының графы");
    expect(html).toContain("Ағымдағы snapshot салыстыруы");
    expect(html).toContain("ETHUSDT");
    expect(html).toContain('<ol class="sr-only"');
  });

  it("keeps required column controls visible in the default table view", () => {
    const html = render("en");
    expect(html).toContain("data-table-child");
    expect(html).toContain("Route<small> · required</small>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
  });
});

function render(locale: "en" | "ru" | "kk") {
  return renderToStaticMarkup(
    <ScannerWorkbench mode="basis" locale={locale} filters={{ minEdge: 0 }} columns={columns} defaultColumns={["route", "net", "actions"]} rows={rows} onApplyFilters={() => {}}>
      {() => <div data-table-child="true">table</div>}
    </ScannerWorkbench>
  );
}

function storeView(visualization: "heatmap" | "compare", compareIds: [string, string] = ["", ""]) {
  localStorage.setItem(
    SCANNER_WORKSPACE_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      modes: {
        basis: { columns: ["route", "net", "actions"], visualization, compareIds, presets: [], selectedPresetId: "" }
      }
    })
  );
}
