// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_REPRESENTATION_SETTINGS,
  loadPriceRepresentationSettings,
  PRICE_REPRESENTATION_SETTINGS_EVENT,
  priceRepresentationBadge,
  sanitizePriceRepresentationSettings,
  storePriceRepresentationSettings
} from "../src/chart/priceRepresentationSettings";

beforeEach(() => localStorage.clear());

describe("price-representation settings", () => {
  it("loads safe defaults when storage is absent or malformed", () => {
    expect(loadPriceRepresentationSettings()).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
    localStorage.setItem("mf:price-representation-settings:v1", "{");
    expect(loadPriceRepresentationSettings()).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
  });

  it("clamps and rounds every persisted construction parameter", () => {
    const safe = sanitizePriceRepresentationSettings({ renkoBrickPercent: 99, lineBreakDepth: 2.8, kagiReversalPercent: -1 });
    expect(safe).toEqual({ renkoBrickPercent: 10, lineBreakDepth: 3, kagiReversalPercent: 0.01 });
    storePriceRepresentationSettings(safe);
    expect(loadPriceRepresentationSettings()).toEqual(safe);
  });

  it("notifies every chart instance after a same-tab update", () => {
    let detail: unknown;
    window.addEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, (event) => { detail = (event as CustomEvent).detail; }, { once: true });
    storePriceRepresentationSettings({ renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.3 });
    expect(detail).toEqual({ renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.3 });
  });

  it("formats the active chart construction compactly", () => {
    const settings = { renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.35 };
    expect(priceRepresentationBadge("renko", settings)).toBe("RENKO 0.20%");
    expect(priceRepresentationBadge("linebreak", settings)).toBe("4LB");
    expect(priceRepresentationBadge("kagi", settings)).toBe("KAGI 0.35%");
    expect(priceRepresentationBadge("candles", settings)).toBe("");
  });
});
