// @vitest-environment jsdom
import { act, useState } from "react";
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

  it("adds volume profile on demand and fully dismisses its settings", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<VolumeProfileHarness />));
    expect(container.textContent).not.toContain("Volume profile");

    await act(async () => container.querySelector<HTMLButtonElement>(".indicator-add")?.click());
    const addProfile = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Volume profile"));
    await act(async () => addProfile?.click());

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Profile timeframe");
    const close = container.querySelector<HTMLButtonElement>('[role="dialog"] button');
    await act(async () => close?.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit Volume profile"]');
    await act(async () => edit?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove Volume profile"]');
    await act(async () => remove?.click());
    expect(container.textContent).not.toContain("Volume profile");

    await act(async () => root.unmount());
    container.remove();
  });
});

function VolumeProfileHarness() {
  const [added, setAdded] = useState(false);
  const [visible, setVisible] = useState(false);
  return (
    <ChartIndicatorOverlay
      locale="en"
      indicators={[]}
      onChange={() => {}}
      onEditLogic={() => {}}
      volumeProfile={{
        added,
        visible,
        chartTimeframe: "1h",
        state: { source: "chart", setSource: () => {}, timeframe: "1h", status: "ready", candles: [], profileCandles: undefined },
        onAdd: () => {
          setAdded(true);
          setVisible(true);
        },
        onVisibleChange: setVisible,
        onRemove: () => {
          setAdded(false);
          setVisible(false);
        }
      }}
    />
  );
}
