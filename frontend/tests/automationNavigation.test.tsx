// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "../src/components/TopBar";
import type { AppMode } from "../src/app/useAppShell";

vi.mock("../src/trading/useRunningBotsSummary", () => ({
  useRunningBotsSummary: () => ({ count: 2, status: "ready", paperOnly: true, refresh: vi.fn() })
}));

describe("primary workspace navigation", () => {
  it("groups the existing modes into Monitoring, Automation and Screener and opens the robots center", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const openRobotsCenter = vi.fn();

    function Harness() {
      const [mode, setMode] = useState<AppMode>("chart");
      return (
        <TopBar
          catalog={{ instruments: [], timeframes: ["1m", "5m", "15m", "1h"], chartTypes: ["candles", "line"] }}
          instrument={{ symbol: "BTCUSDT", displayName: "Bitcoin", assetClass: "crypto", exchange: "Binance", currency: "USDT", provider: "binance", basePrice: 64_000, decimals: 2 }}
          timeframe="1m"
          chartType="candles"
          mode={mode}
          connection="connected"
          theme="dark"
          locale="ru"
          leftOpen
          rightOpen
          panelsSwapped={false}
          workspaces={[]}
          layoutPreset="single"
          onSaveWorkspace={() => {}}
          onApplyWorkspace={() => {}}
          onDeleteWorkspace={() => {}}
          onExportWorkspace={async () => {}}
          onImportWorkspace={async () => true}
          onRollbackWorkspace={() => true}
          onLayoutPresetChange={() => {}}
          canUseDistinctMarkets={false}
          onDistinctMarkets={() => {}}
          onTimeframeChange={() => {}}
          onChartTypeChange={() => {}}
          onModeChange={setMode}
          onOpenRobotsCenter={openRobotsCenter}
          onStrategyWarmup={() => {}}
          onOpenPalette={() => {}}
          onOpenShortcutSettings={() => {}}
          onOpenOfflineResearch={() => {}}
          onToggleTheme={() => {}}
          onToggleLocale={() => {}}
          onToggleLeft={() => {}}
          onToggleRight={() => {}}
          onSwapPanels={() => {}}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const primary = container.querySelector<HTMLElement>('nav[aria-label="Основные пространства"]');
    expect(container.querySelector(".runtime-profile-badge")?.textContent).toContain("Research / Paper");
    expect(primary?.textContent).toContain("Мониторинг");
    expect(primary?.textContent).toContain("Автоматизация");
    expect(primary?.textContent).toContain("Скринер");

    const automation = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Автоматизация"));
    await act(async () => automation?.click());
    expect(container.querySelector('[aria-label="Разделы автоматизации"]')?.textContent).toContain("Стратегии");
    expect(container.querySelector('[aria-label="Разделы автоматизации"]')?.textContent).toContain("Роботы");

    const robots = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Разделы автоматизации"] button')].find((button) => button.textContent?.includes("Роботы"));
    await act(async () => robots?.click());
    expect(robots?.getAttribute("aria-pressed")).toBe("true");

    const running = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Запущено:"));
    expect(running?.textContent).toContain("2");
    await act(async () => running?.click());
    expect(openRobotsCenter).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
