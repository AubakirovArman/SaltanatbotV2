// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PineSourceComparison } from "../src/strategy/components/PineSourceComparison";
import { importPineScript } from "../src/strategy/pine";

describe("Pine source / blocks / preview comparison", () => {
  it("focuses the exact source range from a compatibility diagnostic", async () => {
    const converted = importPineScript(`//@version=6\nindicator("MTF")\nplot(request.security("BINANCE:BTCUSDT", "60", close))`);
    if (!converted.ok) throw new Error(converted.error);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<PineSourceComparison locale="en" pine={{
      source: converted.source,
      language: converted.language,
      diagnostics: converted.diagnostics,
      report: converted.report,
      sourceMap: converted.sourceMap
    }} />));

    const editor = container.querySelector<HTMLTextAreaElement>("textarea");
    const diagnostic = converted.diagnostics.find((item) => item.span);
    const diagnosticButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(diagnostic?.code ?? "missing"));
    expect(editor?.readOnly).toBe(true);
    expect(container.textContent).toContain("Pine source");
    await act(async () => diagnosticButton?.click());
    expect(document.activeElement).toBe(editor);
    expect(editor?.selectionStart).toBe(diagnostic?.span?.start.offset);
    expect(editor?.selectionEnd).toBe(diagnostic?.span?.end.offset);

    await act(async () => root.unmount());
    container.remove();
  });
});
