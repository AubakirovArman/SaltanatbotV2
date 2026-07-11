// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadDrawingTemplates, removeDrawingTemplate, saveDrawingTemplate } from "../src/chart/drawingTemplates";

describe("drawing templates", () => {
  beforeEach(() => localStorage.clear());

  it("persists reusable tool-specific styles and removes them safely", () => {
    const template = { id: "one", name: "Risk line", tool: "hline" as const, style: { color: "#f00", width: 2 }, createdAt: 1 };
    expect(saveDrawingTemplate(template)).toEqual([template]);
    expect(loadDrawingTemplates()).toEqual([template]);
    expect(removeDrawingTemplate("one")).toEqual([]);
  });
});
