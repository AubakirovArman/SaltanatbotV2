// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAWINGS_CHANGED_EVENT, drawingStorageKey, loadDrawings, type DrawingStorageEventDetail } from "../src/chart/drawingStore";
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

  it("publishes the in-memory drawing snapshot before the debounced storage write", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let draw: (() => void) | undefined;
    let detail: DrawingStorageEventDetail | undefined;
    window.addEventListener(DRAWINGS_CHANGED_EVENT, (event) => {
      detail = (event as CustomEvent<DrawingStorageEventDetail>).detail;
    }, { once: true });

    function Harness() {
      const [, setDrawings] = usePersistentDrawings("BTCUSDT", "chart-1");
      draw = () => setDrawings([line("immediate")]);
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => draw?.());

    expect(detail).toMatchObject({ chartId: "chart-1", symbol: "BTCUSDT", drawings: [{ id: "immediate" }] });
    expect(loadDrawings("BTCUSDT", "chart-1")).toEqual([]);
    await act(async () => vi.advanceTimersByTime(250));
    expect(loadDrawings("BTCUSDT", "chart-1").map(({ id }) => id)).toEqual(["immediate"]);
    await act(async () => root.unmount());
  });

  it("does not publish duplicate committed snapshots in StrictMode", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let draw: (() => void) | undefined;
    const snapshots: string[][] = [];
    const listener = (event: Event) => {
      snapshots.push((event as CustomEvent<DrawingStorageEventDetail>).detail.drawings.map(({ id }) => id));
    };
    window.addEventListener(DRAWINGS_CHANGED_EVENT, listener);

    function Harness() {
      const [, setDrawings] = usePersistentDrawings("BTCUSDT", "chart-1");
      draw = () => setDrawings([line("strict")]);
      return null;
    }

    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    await act(async () => draw?.());
    expect(snapshots).toEqual([["strict"]]);

    window.removeEventListener(DRAWINGS_CHANGED_EVENT, listener);
    await act(async () => root.unmount());
  });

  it("never emits the previous snapshot after a new drawing and flushes the latest on pagehide", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let draw: (() => void) | undefined;
    const snapshots: string[][] = [];
    const listener = (event: Event) => {
      snapshots.push((event as CustomEvent<DrawingStorageEventDetail>).detail.drawings.map(({ id }) => id));
    };
    window.addEventListener(DRAWINGS_CHANGED_EVENT, listener);

    function Harness() {
      const [, setDrawings] = usePersistentDrawings("BTCUSDT", "chart-1");
      draw = () => setDrawings([line("latest")]);
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => draw?.());
    expect(snapshots).toEqual([["latest"]]);
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide")));

    expect(snapshots).toEqual([["latest"], ["latest"]]);
    expect(loadDrawings("BTCUSDT", "chart-1").map(({ id }) => id)).toEqual(["latest"]);
    window.removeEventListener(DRAWINGS_CHANGED_EVENT, listener);
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
