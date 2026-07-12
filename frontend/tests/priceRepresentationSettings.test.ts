// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_REPRESENTATION_SETTINGS,
  LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY,
  loadPriceRepresentationSettings,
  PRICE_REPRESENTATION_SETTINGS_EVENT,
  priceRepresentationSettingsStorageKey,
  priceRepresentationBadge,
  sanitizePriceRepresentationSettings,
  storePriceRepresentationSettings
} from "../src/chart/priceRepresentationSettings";

beforeEach(() => localStorage.clear());

describe("price-representation settings", () => {
  it("loads safe defaults when storage is absent or malformed", () => {
    expect(loadPriceRepresentationSettings()).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
    localStorage.setItem(LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY, "{");
    expect(loadPriceRepresentationSettings()).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
    localStorage.setItem(priceRepresentationSettingsStorageKey("BTCUSDT", "chart-4"), `"${"x".repeat(4097)}"`);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-4")).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
  });

  it("clamps and rounds every persisted construction parameter", () => {
    const safe = sanitizePriceRepresentationSettings({ renkoBrickPercent: 99, lineBreakDepth: 2.8, kagiReversalPercent: -1 });
    expect(safe).toEqual({ renkoBrickPercent: 10, lineBreakDepth: 3, kagiReversalPercent: 0.01, pnfBoxPercent: 0.1, pnfReversalBoxes: 3 });
    storePriceRepresentationSettings(safe, "BTCUSDT", "chart-2");
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-2")).toEqual(safe);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-1")).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
  });

  it("notifies only the addressed pane scope after a same-tab update", () => {
    let detail: unknown;
    window.addEventListener(PRICE_REPRESENTATION_SETTINGS_EVENT, (event) => { detail = (event as CustomEvent).detail; }, { once: true });
    const settings = { renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.3, pnfBoxPercent: 0.4, pnfReversalBoxes: 5 };
    storePriceRepresentationSettings(settings, "ETHUSDT", "chart-3");
    expect(detail).toEqual({ key: priceRepresentationSettingsStorageKey("ETHUSDT", "chart-3"), settings });
  });

  it("migrates the global legacy settings only into the primary pane", () => {
    const legacy = { renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.3, pnfBoxPercent: 0.4, pnfReversalBoxes: 5 };
    localStorage.setItem(LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-2")).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-1")).toEqual(legacy);
    expect(localStorage.getItem(LEGACY_PRICE_REPRESENTATION_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("formats the active chart construction compactly", () => {
    const settings = { renkoBrickPercent: 0.2, lineBreakDepth: 4, kagiReversalPercent: 0.35, pnfBoxPercent: 0.5, pnfReversalBoxes: 4 };
    expect(priceRepresentationBadge("renko", settings)).toBe("RENKO 0.20%");
    expect(priceRepresentationBadge("linebreak", settings)).toBe("4LB");
    expect(priceRepresentationBadge("kagi", settings)).toBe("KAGI 0.35%");
    expect(priceRepresentationBadge("pnf", settings)).toBe("P&F 0.50% ×4");
    expect(priceRepresentationBadge("candles", settings)).toBe("");
  });
});
