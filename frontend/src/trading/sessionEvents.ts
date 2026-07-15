export const TRADING_SESSION_CHANGED_EVENT = "sbv2:trading-session-changed";
export const RUNNING_BOTS_CHANGED_EVENT = "sbv2:running-bots-changed";

export function notifyTradingSessionChanged() {
  window.dispatchEvent(new Event(TRADING_SESSION_CHANGED_EVENT));
}

export function notifyRunningBotsChanged() {
  window.dispatchEvent(new Event(RUNNING_BOTS_CHANGED_EVENT));
}
