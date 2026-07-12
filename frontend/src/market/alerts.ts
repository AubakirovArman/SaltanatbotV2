export type AlertDirection = "above" | "below";

export interface PriceAlert {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  createdAt: number;
  triggered: boolean;
}

const KEY = "sbv2:alerts";

export function loadAlerts(): PriceAlert[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAlert);
  } catch {
    return [];
  }
}

export function storeAlerts(alerts: PriceAlert[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(alerts));
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}

function isAlert(value: unknown): value is PriceAlert {
  if (typeof value !== "object" || value === null) return false;
  const alert = value as Record<string, unknown>;
  return (
    typeof alert.id === "string" &&
    typeof alert.symbol === "string" &&
    typeof alert.price === "number" &&
    (alert.direction === "above" || alert.direction === "below") &&
    typeof alert.createdAt === "number" &&
    typeof alert.triggered === "boolean"
  );
}

/**
 * True when `price` has reached/crossed the alert threshold in its configured
 * direction. Uses inclusive comparison so an exact touch fires.
 */
export function alertCrossed(alert: PriceAlert, price: number): boolean {
  return alert.direction === "above" ? price >= alert.price : price <= alert.price;
}

/** Request Notification permission (best effort). Resolves to the resulting state. */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showAlertNotification(alert: PriceAlert, price: number, decimals: number) {
  const arrow = alert.direction === "above" ? "▲" : "▼";
  showSystemNotification(
    `${alert.symbol} ${arrow} ${alert.price.toFixed(decimals)}`,
    `Price ${alert.direction === "above" ? "rose above" : "fell below"} ${alert.price.toFixed(decimals)} (now ${price.toFixed(decimals)})`,
    alert.id
  );
}

export function showSystemNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // Notification construction can throw in some browsers; ignore.
  }
}

let audioContext: AudioContext | undefined;

/** Short WebAudio beep. Degrades silently if audio is unavailable/blocked. */
export function playAlertBeep() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioContext) audioContext = new Ctor();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.34);
  } catch {
    // No audio available; alerts still surface visually + as notifications.
  }
}
