import { describe, expect, it } from "vitest";
import { chartTypeAriaLabel } from "../src/components/chartTypePresentation";

const settings = { renkoBrickPercent: 0.2, lineBreakDepth: 5, kagiReversalPercent: 0.35, pnfBoxPercent: 0.5, pnfReversalBoxes: 4 };

describe("dynamic price-chart descriptions", () => {
  it("announces the active construction parameters", () => {
    expect(chartTypeAriaLabel("en", "renko", "BTCUSDT", "1h", settings)).toContain("fixed 0.20% bricks");
    expect(chartTypeAriaLabel("en", "linebreak", "BTCUSDT", "1h", settings)).toContain("5-line reversal");
    expect(chartTypeAriaLabel("en", "kagi", "BTCUSDT", "1h", settings)).toContain("fixed 0.35% reversal");
    expect(chartTypeAriaLabel("ru", "kagi", "BTCUSDT", "1h", settings)).toContain("0,35%");
    expect(chartTypeAriaLabel("en", "pnf", "BTCUSDT", "1h", settings)).toContain("0.50% boxes and a 4-box reversal");
  });
});
