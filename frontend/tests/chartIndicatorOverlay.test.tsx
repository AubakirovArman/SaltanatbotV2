// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChartIndicatorOverlay } from "../src/components/ChartIndicatorOverlay";

describe("ChartIndicatorOverlay", () => {
  it("lists saved custom indicators in the Add menu", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onAddArtifact = vi.fn();

    await act(async () => {
      root.render(
        <ChartIndicatorOverlay
          locale="en"
          indicators={[]}
          onChange={() => {}}
          onEditLogic={() => {}}
          customIndicators={[{
            id: "indicator:pine-cycles",
            name: "Cycles Analysis",
            description: "Imported from Pine Script."
          }]}
          onAddArtifact={onAddArtifact}
        />
      );
    });

    const addButton = container.querySelector<HTMLButtonElement>(".indicator-add");
    await act(async () => addButton?.click());

    expect(container.textContent).toContain("Custom indicators");
    expect(container.textContent).toContain("Cycles Analysis");
    const cyclesButton = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Cycles Analysis"));
    await act(async () => cyclesButton?.click());
    expect(onAddArtifact).toHaveBeenCalledWith("indicator:pine-cycles");

    await act(async () => root.unmount());
  });
});
