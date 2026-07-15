import { describe, expect, it } from "vitest";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../app/tenantLocalStorage";
import { BROWSER_ALERT_STORAGE_KEY, loadBrowserAlertConfig, storeBrowserAlertConfig } from "./browserAlerts";
import { ARBITRAGE_FEE_PROFILE_STORAGE_KEY, DEFAULT_FEE_PROFILE, loadFeeProfile, storeFeeProfile } from "./fees";

describe("tenant-scoped arbitrage browser preferences", () => {
  it("claims legacy fee and alert preferences for only the first authenticated owner", () => {
    const storage = new MemoryStorage();
    storage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "roman");
    storage.setItem(ARBITRAGE_FEE_PROFILE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_FEE_PROFILE, binanceSpotTakerBps: 2.5 }));
    storage.setItem(BROWSER_ALERT_STORAGE_KEY, JSON.stringify({ enabled: true, thresholdBps: 75 }));

    expect(loadFeeProfile("roman", storage).binanceSpotTakerBps).toBe(2.5);
    expect(loadBrowserAlertConfig("roman", storage)).toEqual({ enabled: true, thresholdBps: 75 });
    expect(storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBe("roman");
    expect(storage.getItem(`${ARBITRAGE_FEE_PROFILE_STORAGE_KEY}:roman`)).not.toBeNull();
    expect(storage.getItem(`${BROWSER_ALERT_STORAGE_KEY}:roman`)).not.toBeNull();

    expect(loadFeeProfile("arman", storage)).toEqual(DEFAULT_FEE_PROFILE);
    expect(loadBrowserAlertConfig("arman", storage)).toEqual({ enabled: false, thresholdBps: 50 });
  });

  it("fails closed for an empty database-auth owner and keeps legacy mode compatible", () => {
    const storage = new MemoryStorage();
    const feeProfile = { ...DEFAULT_FEE_PROFILE, bybitSpotTakerBps: 3 };
    storage.setItem(ARBITRAGE_FEE_PROFILE_STORAGE_KEY, JSON.stringify(feeProfile));
    storage.setItem(BROWSER_ALERT_STORAGE_KEY, JSON.stringify({ enabled: true, thresholdBps: 90 }));

    expect(loadFeeProfile("", storage)).toEqual(DEFAULT_FEE_PROFILE);
    expect(loadBrowserAlertConfig("", storage)).toEqual({ enabled: false, thresholdBps: 50 });
    storeFeeProfile({ ...DEFAULT_FEE_PROFILE, bybitSpotTakerBps: 8 }, "", storage);
    storeBrowserAlertConfig({ enabled: false, thresholdBps: 10 }, "", storage);
    expect(storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBeNull();
    expect(loadFeeProfile(undefined, storage)).toEqual(feeProfile);
    expect(loadBrowserAlertConfig(undefined, storage)).toEqual({ enabled: true, thresholdBps: 90 });
  });

  it("keeps authenticated writes isolated between owners", () => {
    const storage = new MemoryStorage();
    const roman = { ...DEFAULT_FEE_PROFILE, expectedHoldingHours: 12 };
    const arman = { ...DEFAULT_FEE_PROFILE, expectedHoldingHours: 24 };

    storeFeeProfile(roman, "roman", storage);
    storeBrowserAlertConfig({ enabled: true, thresholdBps: 60 }, "roman", storage);
    storeFeeProfile(arman, "arman", storage);
    storeBrowserAlertConfig({ enabled: false, thresholdBps: 120 }, "arman", storage);

    expect(loadFeeProfile("roman", storage)).toEqual(roman);
    expect(loadBrowserAlertConfig("roman", storage)).toEqual({ enabled: true, thresholdBps: 60 });
    expect(loadFeeProfile("arman", storage)).toEqual(arman);
    expect(loadBrowserAlertConfig("arman", storage)).toEqual({ enabled: false, thresholdBps: 120 });
  });
});

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}
