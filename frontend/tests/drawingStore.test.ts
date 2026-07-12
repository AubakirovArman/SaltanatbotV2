// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { drawingStorageKey, loadDrawings, MAX_DRAWINGS_PER_PANE, normalizeDrawings, saveDrawings } from "../src/chart/drawingStore";
import type { DrawingObject } from "../src/chart/drawings";

const line = (id: string, price = 100): DrawingObject => ({
  id,
  tool: "hline",
  points: [{ time: 1_700_000_000_000, price }],
  style: { color: "#4db6ff", width: 1.5 }
});

describe("pane drawing storage", () => {
  beforeEach(() => localStorage.clear());

  it("isolates identical symbols by stable chart id", () => {
    saveDrawings("BTCUSDT", [line("primary")], "chart-1");
    saveDrawings("BTCUSDT", [line("secondary")], "chart-2");

    expect(loadDrawings("BTCUSDT", "chart-1").map(({ id }) => id)).toEqual(["primary"]);
    expect(loadDrawings("BTCUSDT", "chart-2").map(({ id }) => id)).toEqual(["secondary"]);
    expect(drawingStorageKey("BTC/USDT", "chart:2")).toContain("chart%3A2:BTC%2FUSDT");
  });

  it("migrates legacy symbol drawings only into the primary pane", () => {
    localStorage.setItem("mf:drawings:ETHUSDT", JSON.stringify([line("legacy")]));

    expect(loadDrawings("ETHUSDT", "chart-2")).toEqual([]);
    expect(loadDrawings("ETHUSDT", "chart-1").map(({ id }) => id)).toEqual(["legacy"]);
    expect(localStorage.getItem("mf:drawings:ETHUSDT")).toBeNull();
    expect(localStorage.getItem(drawingStorageKey("ETHUSDT", "chart-1"))).not.toBeNull();
  });

  it("rejects corrupt geometry, duplicate ids and unbounded storage", () => {
    const malformed = { ...line("broken"), points: [{ time: Number.NaN, price: 100 }] };
    const many = Array.from({ length: MAX_DRAWINGS_PER_PANE + 20 }, (_, index) => line(`line-${index}`, index));
    const normalized = normalizeDrawings([malformed, line("same"), line("same", 200), ...many]);

    expect(normalized[0]?.id).toBe("same");
    expect(normalized.filter(({ id }) => id === "same")).toHaveLength(1);
    expect(normalized).toHaveLength(MAX_DRAWINGS_PER_PANE);
  });

  it("removes a pane key when its drawing set becomes empty", () => {
    saveDrawings("SOLUSDT", [line("one")], "chart-3");
    saveDrawings("SOLUSDT", [], "chart-3");
    expect(localStorage.getItem(drawingStorageKey("SOLUSDT", "chart-3"))).toBeNull();
  });
});
