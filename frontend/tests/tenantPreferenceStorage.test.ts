// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadCompare, loadCryptoExchange } from "../src/app/shellStorage";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
import { loadDrawingTemplates, saveDrawingTemplate } from "../src/chart/drawingTemplates";
import { loadMicrostructureAlertSettings, storeMicrostructureAlertSettings } from "../src/chart/microstructureAlertStore";
import { DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS } from "../src/chart/microstructureAlerts";
import { DEFAULT_PRICE_REPRESENTATION_SETTINGS, loadPriceRepresentationSettings, priceRepresentationSettingsStorageKey, storePriceRepresentationSettings } from "../src/chart/priceRepresentationSettings";
import { loadFavorites, storeFavorites } from "../src/market/favorites";
import { loadWatchlistSort, storeWatchlistSort } from "../src/market/watchlistPrefs";

const template = {
  id: "risk-line",
  name: "Risk line",
  tool: "hline" as const,
  style: { color: "#f00", width: 2 },
  createdAt: 1
};

describe("tenant-private chart and watchlist preferences", () => {
  beforeEach(() => localStorage.clear());

  it("lets one authenticated owner claim all legacy preferences", () => {
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "user-a");
    localStorage.setItem("sbv2:compare", JSON.stringify(["ETHUSDT"]));
    localStorage.setItem("mf:cryptoExchange", "bybit");
    localStorage.setItem("sbv2:favorites", JSON.stringify(["BTCUSDT"]));
    localStorage.setItem("sbv2:watchlistSort", "change-desc");
    localStorage.setItem("sbv2:drawing-templates:v1", JSON.stringify([template]));
    localStorage.setItem("sbv2:microstructure-alerts:v1", JSON.stringify({ ...DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, largePrintNotional: 123 }));
    const priceKey = priceRepresentationSettingsStorageKey("BTCUSDT", "chart-1");
    localStorage.setItem(priceKey, JSON.stringify({ ...DEFAULT_PRICE_REPRESENTATION_SETTINGS, renkoBrickPercent: 0.25 }));

    expect(loadCompare("1m", "candles", "user-a").map(({ symbol }) => symbol)).toEqual(["ETHUSDT"]);
    expect(loadCryptoExchange("user-a")).toBe("bybit");
    expect(loadFavorites("user-a")).toEqual(["BTCUSDT"]);
    expect(loadWatchlistSort("user-a")).toBe("change-desc");
    expect(loadDrawingTemplates("user-a")).toEqual([template]);
    expect(loadMicrostructureAlertSettings("user-a").largePrintNotional).toBe(123);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-1", "user-a").renkoBrickPercent).toBe(0.25);
    expect(localStorage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBe("user-a");

    expect(loadCompare("1m", "candles", "user-b")).toEqual([]);
    expect(loadCryptoExchange("user-b")).toBe("binance");
    expect(loadFavorites("user-b")).toEqual([]);
    expect(loadWatchlistSort("user-b")).toBe("symbol");
    expect(loadDrawingTemplates("user-b")).toEqual([]);
    expect(loadMicrostructureAlertSettings("user-b")).toEqual(DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-1", "user-b")).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);
  });

  it("keeps writes isolated, fails closed for an empty database owner and preserves legacy mode", () => {
    storeFavorites(["BTCUSDT"], "user-a");
    storeFavorites(["ETHUSDT"], "user-b");
    storeWatchlistSort("change-desc", "user-a");
    storeWatchlistSort("change-asc", "user-b");
    saveDrawingTemplate(template, "user-a");
    storeMicrostructureAlertSettings({ ...DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, largePrintNotional: 111 }, "user-a");
    storePriceRepresentationSettings({ ...DEFAULT_PRICE_REPRESENTATION_SETTINGS, lineBreakDepth: 4 }, "BTCUSDT", "chart-1", "user-a");

    expect(loadFavorites("user-a")).toEqual(["BTCUSDT"]);
    expect(loadFavorites("user-b")).toEqual(["ETHUSDT"]);
    expect(loadWatchlistSort("user-a")).toBe("change-desc");
    expect(loadWatchlistSort("user-b")).toBe("change-asc");
    expect(loadDrawingTemplates("user-b")).toEqual([]);

    storeFavorites(["SOLUSDT"], "");
    storeWatchlistSort("change-desc", "");
    saveDrawingTemplate(template, "");
    storeMicrostructureAlertSettings({ ...DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, largePrintNotional: 222 }, "");
    storePriceRepresentationSettings({ ...DEFAULT_PRICE_REPRESENTATION_SETTINGS, lineBreakDepth: 5 }, "BTCUSDT", "chart-1", "");
    expect(loadFavorites("")).toEqual([]);
    expect(loadWatchlistSort("")).toBe("symbol");
    expect(loadDrawingTemplates("")).toEqual([]);
    expect(loadMicrostructureAlertSettings("")).toEqual(DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS);
    expect(loadPriceRepresentationSettings("BTCUSDT", "chart-1", "")).toEqual(DEFAULT_PRICE_REPRESENTATION_SETTINGS);

    storeFavorites(["XRPUSDT"]);
    storeWatchlistSort("change-asc");
    expect(loadFavorites()).toEqual(["XRPUSDT"]);
    expect(loadWatchlistSort()).toBe("change-asc");
  });
});
