import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/auth-account.css", import.meta.url), "utf8");

describe("R3.1 account/admin responsive contract", () => {
  it("collapses account, filters, permissions and change previews to one column by mobile widths", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 700px)"), css.indexOf("@media (max-width: 390px)"));
    expect(mobile).toContain(".auth-account-layout");
    expect(mobile).toContain(".auth-permission-grid");
    expect(mobile).toContain(".auth-user-filters");
    expect(mobile).toContain(".auth-audit-filters");
    expect(mobile).toContain(".auth-change-preview");
    expect(mobile).toContain("grid-template-columns: 1fr");
  });

  it("contains the dialog at 320/360 widths and keeps interactive controls at least 44 CSS pixels high", () => {
    expect(css).toContain("inline-size: calc(100vw - 0.5rem)");
    expect(css).toContain("max-block-size: calc(100dvh - 0.5rem)");
    expect(css).toContain("@media (max-width: 390px)");
    expect(css).toContain("min-block-size: 2.75rem");
    expect(css).not.toMatch(/min-inline-size:\s*(?:2[0-9]|3[0-9])px/);
  });
});
