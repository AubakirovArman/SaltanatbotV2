// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
import { drawingStorageKey, loadDrawings, MAX_DRAWINGS_PER_PANE, normalizeDrawings, saveDrawings, validMultilineDrawingText } from "../src/chart/drawingStore";
import type { DrawingObject } from "../src/chart/drawings";

const line = (id: string, price = 100): DrawingObject => ({
  id,
  tool: "hline",
  points: [{ time: 1_700_000_000_000, price }],
  style: { color: "#4db6ff", width: 1.5 }
});

const note = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "note-1",
  tool: "text-note",
  points: [{ time: 1_700_000_000_000, price: 100 }],
  style: { color: "#f7c948", width: 1.5 },
  text: "Support retest\nwatch the volume",
  author: "owner-login",
  createdAt: 1_700_000_000_000,
  ...overrides
});

const channel = (points: Array<{ time: number; price: number }>): Record<string, unknown> => ({
  id: "channel-1",
  tool: "parallel-channel",
  points,
  style: { color: "#4db6ff", width: 1.5, fill: "rgba(77, 182, 255, 0.10)" }
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

  it("keeps note metadata within the shared contract and strips unknown or invalid fields", () => {
    const [normalized] = normalizeDrawings([note({ unknownField: "future" })]);
    expect(normalized).toEqual({
      id: "note-1",
      tool: "text-note",
      points: [{ time: 1_700_000_000_000, price: 100 }],
      style: { color: "#f7c948", width: 1.5 },
      text: "Support retest\nwatch the volume",
      author: "owner-login",
      createdAt: 1_700_000_000_000
    });
    expect("unknownField" in normalized).toBe(false);

    const [degraded] = normalizeDrawings([
      note({ id: "n2", text: "tab\tinside", author: "a".repeat(65), createdAt: 0.5 })
    ]);
    expect(degraded.text).toBeUndefined();
    expect(degraded.author).toBeUndefined();
    expect(degraded.createdAt).toBeUndefined();

    expect(normalizeDrawings([note({ id: "n3", text: "" })])[0].text).toBeUndefined();
    expect(normalizeDrawings([note({ id: "n4", text: "x".repeat(501) })])[0].text).toBeUndefined();
    expect(normalizeDrawings([note({ id: "n5", text: "x".repeat(500) })])[0].text).toHaveLength(500);
    // Note metadata never leaks onto other tools.
    expect(normalizeDrawings([{ ...line("plain"), text: "nope", author: "nope" }])[0]).not.toHaveProperty("text");

    expect(validMultilineDrawingText("multi\nline")).toBe(true);
    expect(validMultilineDrawingText("bell\u0007")).toBe(false);
    expect(validMultilineDrawingText("")).toBe(false);
  });

  it("accepts only parallel channels whose anchors satisfy the canonical geometry contract", () => {
    const a = { time: 1_700_000_000_000, price: 100 };
    const b = { time: 1_700_000_600_000, price: 110 };
    const valid = channel([a, b, { time: 1_700_000_300_000, price: 102 }]);
    expect(normalizeDrawings([valid])).toHaveLength(1);
    expect(normalizeDrawings([channel([a, b, { time: 1_700_000_300_000, price: 105 }])])).toEqual([]);
    expect(normalizeDrawings([channel([a, { ...b, time: a.time }, { time: a.time, price: 90 }])])).toEqual([]);
    expect(normalizeDrawings([channel([a, b])])).toEqual([]);
  });

  it("loads pre-R5 stores without the research-tool fields unchanged", () => {
    const key = drawingStorageKey("BTCUSDT", "chart-1");
    localStorage.setItem(key, JSON.stringify([
      line("old-hline"),
      { id: "old-trend", tool: "trendline", points: [{ time: 1, price: 1 }, { time: 2, price: 2 }], style: { color: "#4db6ff", width: 1.5 } }
    ]));
    expect(loadDrawings("BTCUSDT", "chart-1").map(({ id }) => id)).toEqual(["old-hline", "old-trend"]);
  });

  it("allows only one authenticated owner to claim legacy pane drawings", () => {
    const key = drawingStorageKey("ETHUSDT", "chart-1");
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "user-a");
    localStorage.setItem(key, JSON.stringify([line("legacy-pane")]));

    expect(loadDrawings("ETHUSDT", "chart-1", "user-a").map(({ id }) => id)).toEqual(["legacy-pane"]);
    expect(loadDrawings("ETHUSDT", "chart-1", "user-b")).toEqual([]);
  });
});
