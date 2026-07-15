import { DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, parseMicrostructureAlertSettings, type MicrostructureAlertSettings } from "./microstructureAlerts";
import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

const KEY = "sbv2:microstructure-alerts:v1";

export function loadMicrostructureAlertSettings(ownerId?: string): MicrostructureAlertSettings {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    return raw ? parseMicrostructureAlertSettings(JSON.parse(raw) as unknown) : DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS;
  } catch {
    return DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS;
  }
}

export function storeMicrostructureAlertSettings(settings: MicrostructureAlertSettings, ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, KEY, JSON.stringify(settings), ownerId);
  } catch {
    // Runtime settings still work when storage is unavailable.
  }
}
