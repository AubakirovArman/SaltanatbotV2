import { DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, parseMicrostructureAlertSettings, type MicrostructureAlertSettings } from "./microstructureAlerts";

const KEY = "sbv2:microstructure-alerts:v1";

export function loadMicrostructureAlertSettings(): MicrostructureAlertSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? parseMicrostructureAlertSettings(JSON.parse(raw) as unknown) : DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS;
  } catch {
    return DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS;
  }
}

export function storeMicrostructureAlertSettings(settings: MicrostructureAlertSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Runtime settings still work when storage is unavailable.
  }
}
