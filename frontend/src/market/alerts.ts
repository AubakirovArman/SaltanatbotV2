import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";
import type { ChartDataRoute } from "../types";

export type AlertDirection = "above" | "below";

export interface PriceAlert extends ChartDataRoute {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  createdAt: number;
  triggered: boolean;
}

const KEY = "sbv2:alerts";

export const DEFAULT_PRICE_ALERT_ROUTE: ChartDataRoute = Object.freeze({
  exchange: "binance",
  marketType: "spot",
  priceType: "last"
});

export interface TriggeredPriceAlert {
  alert: PriceAlert;
  hitPrice: number;
}

export function loadAlerts(ownerId?: string, legacyRoute: ChartDataRoute = DEFAULT_PRICE_ALERT_ROUTE): PriceAlert[] {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => parseAlert(value, legacyRoute)).filter((value): value is PriceAlert => value !== undefined);
  } catch {
    return [];
  }
}

export function storeAlerts(alerts: PriceAlert[], ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, KEY, JSON.stringify(alerts), ownerId);
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}

function parseAlert(value: unknown, legacyRoute: ChartDataRoute): PriceAlert | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const alert = value as Record<string, unknown>;
  if (typeof alert.id !== "string" || typeof alert.symbol !== "string" || typeof alert.price !== "number" || !Number.isFinite(alert.price) || (alert.direction !== "above" && alert.direction !== "below") || typeof alert.createdAt !== "number" || typeof alert.triggered !== "boolean") return undefined;
  const legacy = alert.exchange === undefined && alert.marketType === undefined && alert.priceType === undefined;
  const route = legacy
    ? legacyRoute
    : isExchange(alert.exchange) && isMarketType(alert.marketType) && isPriceType(alert.priceType)
      ? { exchange: alert.exchange, marketType: alert.marketType, priceType: alert.priceType }
      : undefined;
  return route ? { id: alert.id, symbol: alert.symbol, price: alert.price, direction: alert.direction, createdAt: alert.createdAt, triggered: alert.triggered, ...route } : undefined;
}

/**
 * True when `price` has reached/crossed the alert threshold in its configured
 * direction. Uses inclusive comparison so an exact touch fires.
 */
export function alertCrossed(alert: PriceAlert, price: number): boolean {
  return alert.direction === "above" ? price >= alert.price : price <= alert.price;
}

export function priceAlertRouteKey(route: ChartDataRoute): string {
  return `${route.exchange}:${route.marketType}:${route.priceType}`;
}

export function samePriceAlertRoute(alert: PriceAlert, route: ChartDataRoute): boolean {
  return alert.exchange === route.exchange && alert.marketType === route.marketType && alert.priceType === route.priceType;
}

/** Pure transition used by the alert feed before React commits and delivers effects. */
export function evaluateAlertPrices(alerts: PriceAlert[], route: ChartDataRoute, prices: Record<string, number>): { alerts: PriceAlert[]; fired: TriggeredPriceAlert[] } {
  let next = alerts;
  const fired: TriggeredPriceAlert[] = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    if (alert.triggered || !samePriceAlertRoute(alert, route)) continue;
    const price = prices[alert.symbol];
    if (price === undefined || !Number.isFinite(price) || !alertCrossed(alert, price)) continue;
    if (next === alerts) next = alerts.slice();
    const triggered = { ...alert, triggered: true };
    next[index] = triggered;
    fired.push({ alert: triggered, hitPrice: price });
  }
  return { alerts: next, fired };
}

function isExchange(value: unknown): value is ChartDataRoute["exchange"] {
  return value === "binance" || value === "bybit";
}

function isMarketType(value: unknown): value is ChartDataRoute["marketType"] {
  return value === "spot" || value === "linear" || value === "inverse";
}

function isPriceType(value: unknown): value is ChartDataRoute["priceType"] {
  return value === "last" || value === "mark" || value === "index";
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
  showSystemNotification(`${alert.symbol} ${arrow} ${alert.price.toFixed(decimals)}`, `Price ${alert.direction === "above" ? "rose above" : "fell below"} ${alert.price.toFixed(decimals)} (now ${price.toFixed(decimals)})`, alert.id);
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
