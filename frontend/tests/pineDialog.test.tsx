// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PineImportDialog } from "../src/components/PineImportDialog";

/**
 * Regression guard for the Pine import dialog's overlay. It must render on the
 * SAME fixed, centered overlay classes as the template gallery (.gallery-backdrop /
 * .gallery-modal) — an earlier version referenced .modal-backdrop/.modal, which
 * exist nowhere in the CSS, so the "modal" rendered inline at the bottom of the
 * library sidebar, half-clipped, and shifted the action buttons.
 */
describe("PineImportDialog overlay", () => {
  it("renders on the fixed gallery overlay, not the dead .modal classes", () => {
    const html = renderToStaticMarkup(<PineImportDialog onClose={() => {}} onImportMany={() => {}} />);
    expect(html).toContain("gallery-backdrop");
    expect(html).toContain("gallery-modal pine-import");
    expect(html).toContain("gallery-body pine-body");
    expect(html).not.toContain("modal-backdrop");
    expect(html).toContain('aria-modal="true"');
  });
});
