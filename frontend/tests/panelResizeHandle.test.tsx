// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { PanelResizeHandle } from "../src/components/PanelResizeHandle";

describe("PanelResizeHandle", () => {
  it("exposes separator values and supports bounded keyboard resizing", async () => {
    const resize = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<PanelResizeHandle side="left" value={260} min={180} max={520} label="Resize markets" onResize={resize} />));
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.getAttribute("aria-valuenow")).toBe("260");
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(resize).toHaveBeenNthCalledWith(1, 276);
    expect(resize).toHaveBeenNthCalledWith(2, 180);
    await act(async () => root.unmount());
  });
});
