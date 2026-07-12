// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { assignShortcut, DEFAULT_SHORTCUTS, loadShortcuts, matchesShortcut, saveShortcuts, shortcutFromEvent } from "../src/app/shortcuts";

describe("custom keyboard shortcuts", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes platform modifiers and matches exact chords", () => {
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    expect(shortcutFromEvent(event)).toBe("Mod+K");
    expect(matchesShortcut(event, "Mod+K")).toBe(true);
    expect(matchesShortcut(event, "K")).toBe(false);
  });

  it("rejects conflicts and persists complete maps", () => {
    expect(assignShortcut(DEFAULT_SHORTCUTS, "openChart", "S")).toMatchObject({ conflict: "openStrategy" });
    const assigned = assignShortcut(DEFAULT_SHORTCUTS, "openChart", "Alt+C").shortcuts;
    saveShortcuts(assigned);
    expect(loadShortcuts().openChart).toBe("Alt+C");
  });

  it("migrates older shortcut maps with pane navigation bindings", () => {
    localStorage.setItem("sbv2:shortcuts:v1", JSON.stringify({ commandPalette: "Mod+P" }));
    expect(loadShortcuts()).toMatchObject({ commandPalette: "Mod+P", previousChart: "Alt+K", nextChart: "Alt+J", maximizeChart: "Alt+Enter" });
    expect(matchesShortcut(new KeyboardEvent("keydown", { key: "Enter", altKey: true }), loadShortcuts().maximizeChart)).toBe(true);
  });
});
