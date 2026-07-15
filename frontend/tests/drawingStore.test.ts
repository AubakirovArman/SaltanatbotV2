// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
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

  it("isolates authenticated owners and fails closed while the owner id is unresolved", () => {
    saveDrawings("BTCUSDT", [line("owner-a")], "chart-1", "user-a");
    saveDrawings("BTCUSDT", [line("owner-b")], "chart-1", "user-b");
    saveDrawings("BTCUSDT", [line("unresolved")], "chart-1", "");

    expect(loadDrawings("BTCUSDT", "chart-1", "user-a").map(({ id }) => id)).toEqual(["owner-a"]);
    expect(loadDrawings("BTCUSDT", "chart-1", "user-b").map(({ id }) => id)).toEqual(["owner-b"]);
    expect(loadDrawings("BTCUSDT", "chart-1", "")).toEqual([]);
    expect(localStorage.getItem(drawingStorageKey("BTCUSDT", "chart-1"))).toBeNull();
  });

  it("allows only one authenticated owner to claim legacy pane drawings", () => {
    const key = drawingStorageKey("ETHUSDT", "chart-1");
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "user-a");
    localStorage.setItem(key, JSON.stringify([line("legacy-pane")]));

    expect(loadDrawings("ETHUSDT", "chart-1", "user-a").map(({ id }) => id)).toEqual(["legacy-pane"]);
    expect(loadDrawings("ETHUSDT", "chart-1", "user-b")).toEqual([]);
  });
});
