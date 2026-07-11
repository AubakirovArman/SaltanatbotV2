import { describe, expect, it } from "vitest";
import { calculateVirtualWindow } from "../src/market/virtualList";

describe("watchlist windowing", () => {
  it("keeps small lists fully rendered for assistive technology", () => {
    expect(calculateVirtualWindow(40, 500, 200)).toEqual({ start: 0, end: 40, paddingBefore: 0, paddingAfter: 0 });
  });

  it("bounds large lists with overscan and preserves total scroll height", () => {
    const window = calculateVirtualWindow(1_000, 3_400, 340, 34, 2);
    expect(window).toEqual({ start: 98, end: 112, paddingBefore: 3_332, paddingAfter: 30_192 });
    expect(window.paddingBefore + (window.end - window.start) * 34 + window.paddingAfter).toBe(34_000);
  });
});
