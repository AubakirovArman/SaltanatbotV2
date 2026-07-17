import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hook = readFileSync(new URL("../src/hooks/usePriceAlerts.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles/market-panels.css", import.meta.url), "utf8");

describe("database-owned price alert boundary", () => {
  it("does not call the legacy trading notification endpoint", () => {
    expect(hook).not.toContain("notifyAlert");
    expect(hook).not.toContain("notify-alert");
    expect(hook).not.toContain("getToken");
    expect(hook).toContain("createAlertRule");
    expect(hook).toContain("archiveAlertRule");
    expect(hook).toContain("rearmAlertRule");
  });

  it("keeps alert controls at a touch-safe mobile size without clipping the form", () => {
    expect(styles).toMatch(/\.alert-add \{\s*block-size: auto;\s*min-block-size: 44px;/);
    expect(styles).toMatch(/\.alert-add input \{\s*min-block-size: 44px;/);
    expect(styles).toMatch(/\.alert-sync-summary button,[\s\S]*min-inline-size: 44px;[\s\S]*min-block-size: 44px;/);
  });
});
