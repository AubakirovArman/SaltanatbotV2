// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawingStorageKey, loadDrawings } from "../src/chart/drawingStore";
import type { DrawingObject } from "../src/chart/drawings";
import { usePersistentDrawings } from "../src/components/chartCanvas/usePersistentDrawings";

const line = (id: string): DrawingObject => ({ id, tool: "hline", points: [{ time: 1, price: 100 }], style: { color: "#fff", width: 1 } });

describe("usePersistentDrawings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("flushes the current pane before switching symbols without contaminating the next scope", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let draw: (() => void) | undefined;

    function Harness({ symbol, chartId }: { symbol: string; chartId: string }) {
      const [drawings, setDrawings] = usePersistentDrawings(symbol, chartId);
      draw = () => setDrawings([line(`${chartId}-${symbol}`)]);
      return <output>{drawings.map(({ id }) => id).join(",")}</output>;
    }

    await act(async () => root.render(<Harness symbol="BTCUSDT" chartId="chart-2" />));
    await act(async () => draw?.());
    await act(async () => root.render(<Harness symbol="ETHUSDT" chartId="chart-2" />));

    expect(container.querySelector("output")?.textContent).toBe("");
    expect(loadDrawings("BTCUSDT", "chart-2").map(({ id }) => id)).toEqual(["chart-2-BTCUSDT"]);
    expect(localStorage.getItem(drawingStorageKey("ETHUSDT", "chart-2"))).toBeNull();

    await act(async () => draw?.());
    await act(async () => vi.advanceTimersByTime(250));
    expect(loadDrawings("ETHUSDT", "chart-2").map(({ id }) => id)).toEqual(["chart-2-ETHUSDT"]);
    await act(async () => root.unmount());
  });

  it("flushes an account switch back to the departing owner instead of the arriving owner", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let draw: (() => void) | undefined;

    function Harness({ ownerId }: { ownerId: string }) {
      const [drawings, setDrawings] = usePersistentDrawings("BTCUSDT", "chart-1", ownerId);
      draw = () => setDrawings([line(`private-${ownerId}`)]);
      return <output>{drawings.map(({ id }) => id).join(",")}</output>;
    }

    await act(async () => root.render(<Harness ownerId="user-a" />));
    await act(async () => draw?.());
    await act(async () => root.render(<Harness ownerId="user-b" />));

    expect(container.querySelector("output")?.textContent).toBe("");
    expect(loadDrawings("BTCUSDT", "chart-1", "user-a").map(({ id }) => id)).toEqual(["private-user-a"]);
    expect(loadDrawings("BTCUSDT", "chart-1", "user-b")).toEqual([]);
    await act(async () => root.unmount());
  });
});
