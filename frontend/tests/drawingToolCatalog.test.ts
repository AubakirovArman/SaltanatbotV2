import { describe, expect, it } from "vitest";
import { TOOL_POINT_COUNT } from "../src/chart/drawings";
import {
  DRAWING_GROUP_LABEL_KEYS,
  DRAWING_GROUP_ORDER,
  DRAWING_MANAGE_ITEMS,
  DRAWING_TOOL_CATALOG,
  DRAWING_TOOL_ITEMS,
  DRAWING_VIEW_ITEMS,
  drawingToolLabelKey
} from "../src/components/chartCanvas/drawingToolCatalog";
import { shellText } from "../src/i18n/shell";

describe("drawing tool catalog", () => {
  it("lists every shape tool plus the cursor exactly once, in existing groups", () => {
    const ids = DRAWING_TOOL_CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(DRAWING_TOOL_CATALOG.length);
    expect(DRAWING_TOOL_CATALOG).toHaveLength(21);

    const toolIds = DRAWING_TOOL_CATALOG.filter((item) => item.kind === "tool").map((item) => item.id);
    expect([...toolIds].sort()).toEqual(["cursor", ...Object.keys(TOOL_POINT_COUNT)].sort());
    expect(DRAWING_TOOL_CATALOG.every((item) => DRAWING_GROUP_ORDER.includes(item.group))).toBe(true);
    expect(DRAWING_GROUP_ORDER).toHaveLength(7);
  });

  it("derives the rail sections by kind and group so catalog growth cannot skew them", () => {
    expect([...DRAWING_TOOL_ITEMS, ...DRAWING_VIEW_ITEMS, ...DRAWING_MANAGE_ITEMS]).toEqual([...DRAWING_TOOL_CATALOG]);
    expect(DRAWING_TOOL_ITEMS.every((item) => item.kind === "tool")).toBe(true);
    expect(DRAWING_VIEW_ITEMS.map((item) => item.id)).toEqual(["magnet", "volume", "order-book", "trade-footprint"]);
    expect(DRAWING_MANAGE_ITEMS.map((item) => item.id)).toEqual(["objects", "delete-all"]);
  });

  it("places the research tools next to their families with localized labels", () => {
    expect(DRAWING_TOOL_CATALOG.find((item) => item.id === "parallel-channel")?.group).toBe("lines");
    expect(DRAWING_TOOL_CATALOG.find((item) => item.id === "text-note")?.group).toBe("measure");
    expect(drawingToolLabelKey("parallel-channel")).toBe("parallelChannel");
    expect(drawingToolLabelKey("text-note")).toBe("textNote");

    for (const locale of ["en", "ru", "kk"] as const) {
      for (const item of DRAWING_TOOL_CATALOG) {
        expect(shellText(locale, item.labelKey).trim(), `shell.${item.labelKey} (${locale})`).not.toBe("");
      }
      for (const group of DRAWING_GROUP_ORDER) {
        expect(shellText(locale, DRAWING_GROUP_LABEL_KEYS[group]).trim(), `group ${group} (${locale})`).not.toBe("");
      }
    }
  });
});
