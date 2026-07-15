// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ScannerModeNav, type ScannerMode } from "../src/arbitrage/ScannerModeNav";

describe("ScannerModeNav", () => {
  it("expands mobile choices, collapses after selection and restores trigger focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>(".arb-mode-trigger")!;
    const options = container.querySelector<HTMLElement>(".arb-mode-options")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(options.classList.contains("is-open")).toBe(false);

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(options.classList.contains("is-open")).toBe(true);

    const triangular = [...options.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Triangular")!;
    await act(async () => triangular.click());
    expect(trigger.textContent).toContain("Triangular");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(triangular.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    await act(async () => options.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    await act(async () => root.unmount());
    container.remove();
  });
});

function Harness() {
  const [mode, setMode] = useState<ScannerMode>("basis");
  return <ScannerModeNav locale="en" mode={mode} onMode={setMode} />;
}
