// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("CommandPalette accessibility", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("links its labelled combobox to the active listbox option", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const first = vi.fn();
    const second = vi.fn();

    await act(async () =>
      root.render(
        <CommandPalette
          locale="en"
          open
          onClose={() => {}}
          commands={[
            { id: "first", label: "First command", group: "View", run: first },
            { id: "second", label: "Second command", group: "View", run: second }
          ]}
        />
      )
    );

    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(input?.labels?.[0]?.textContent).toContain("Search symbols");
    expect(input?.getAttribute("aria-controls")).toBe(listbox?.id);
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(input?.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
