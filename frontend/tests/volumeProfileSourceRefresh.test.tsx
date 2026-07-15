// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCandles } from "../src/api/marketClient";
import { useVolumeProfileSource } from "../src/components/chartCanvas/useVolumeProfileSource";

vi.mock("../src/api/marketClient", () => ({ getCandles: vi.fn() }));

const getCandlesMock = vi.mocked(getCandles);
const VISIBLE_RANGE = { startTime: 0, endTime: 120_000 } as const;

describe("independent volume-profile refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("saltanat.chart.volume-profile-source.v1", "1m");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    getCandlesMock.mockResolvedValue({
      candles: [candle(0), candle(60_000)],
      provider: "Binance public",
      hasMore: false
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    getCandlesMock.mockReset();
    document.body.innerHTML = "";
  });

  it("reloads 1m source data while the visible 1h chart range is unchanged", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await advance(200);
    expect(getCandlesMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("ready:2");

    await advance(60_000);
    await advance(200);
    expect(getCandlesMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("ready:2");
    await act(async () => root.unmount());
  });

  it("changes storage scope atomically when the authenticated owner changes", async () => {
    localStorage.setItem("saltanat.chart.volume-profile-source.v1:user-a", "5m");
    localStorage.setItem("saltanat.chart.volume-profile-source.v1:user-b", "15m");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<OwnerHarness ownerId="user-a" />));
    expect(container.textContent).toBe("5m");
    await act(async () => root.render(<OwnerHarness ownerId="user-b" />));
    expect(container.textContent).toBe("15m");
    await act(async () => root.render(<OwnerHarness ownerId="" />));
    expect(container.textContent).toBe("chart");
    expect(localStorage.getItem("saltanat.chart.volume-profile-source.v1:")).toBeNull();
    await act(async () => root.unmount());
  });
});

function Harness() {
  const state = useVolumeProfileSource({
    enabled: true,
    symbol: "BTCUSDT",
    chartTimeframe: "1h",
    visibleRange: VISIBLE_RANGE,
    exchange: "binance",
    marketType: "spot",
    priceType: "last"
  });
  return (
    <span>
      {state.status}:{state.profileCandles?.length ?? 0}
    </span>
  );
}

function OwnerHarness({ ownerId }: { ownerId: string }) {
  const state = useVolumeProfileSource({
    enabled: false,
    symbol: "BTCUSDT",
    chartTimeframe: "1h",
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    storageOwnerId: ownerId
  });
  return <span>{state.source}</span>;
}

async function advance(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function candle(time: number) {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 10, source: "Binance public" };
}
