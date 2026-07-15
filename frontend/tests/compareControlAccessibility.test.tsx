// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompareControl } from "../src/components/CompareControl";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("CompareControl accessibility", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("supports arrow navigation and Escape with focus restoration", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onAdd = vi.fn();

    await act(async () =>
      root.render(
        <CompareControl
          locale="en"
          candidates={[
            { symbol: "ETHUSDT", displayName: "ETH / USDT" },
            { symbol: "SOLUSDT", displayName: "SOL / USDT" }
          ]}
          active={[]}
          max={3}
          timeframes={["1m"]}
          chartTypes={["candles", "line"]}
          legend={[]}
          loading={{}}
          errors={{}}
          onAdd={onAdd}
          onUpdate={() => {}}
          onRemove={() => {}}
        />
      )
    );

    const trigger = host.querySelector<HTMLButtonElement>(".compare-add");
    await act(async () => trigger?.click());
    const search = host.querySelector<HTMLInputElement>('.compare-search input[role="combobox"]');
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(search?.getAttribute("aria-controls")).toBe(host.querySelector('[role="listbox"]')?.id);

    await act(async () => search?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options[0]);

    await act(async () => options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options[1]);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    await act(async () => options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".compare-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => root.unmount());
  });
});
