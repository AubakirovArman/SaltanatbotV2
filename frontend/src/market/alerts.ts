import { readTenantLocalItem, tenantLocalStorageKey, writeTenantLocalItem } from "../app/tenantLocalStorage";
import type { AlertRuleLifecycleStateV1 } from "@saltanatbotv2/contracts";
import type { ChartDataRoute, Timeframe } from "../types";

export type AlertDirection = "above" | "below";
export type PriceAlertSource = "browser" | "server";
export type PriceAlertSyncState = "browser-only" | "needs-review" | "syncing" | "synced" | "sync-error" | "deleting";

export interface PriceAlert extends ChartDataRoute {
  id: string;
  /** Stable owner-local idempotency key used by the server reconciliation. */
  clientId?: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  /** Legacy rows intentionally keep this absent and can never be silently imported. */
  timeframe?: Timeframe;
  createdAt: number;
  triggered: boolean;
  source?: PriceAlertSource;
  /** A suspended browser row is retained for recovery but must never be evaluated. */
  suspended?: boolean;
  syncState?: PriceAlertSyncState;
  serverRuleId?: string;
  serverRevision?: number;
  serverLifecycle?: AlertRuleLifecycleStateV1;
  /** Owner-local Lamport clock used to merge storage updates across tabs. */
  localRevision?: number;
  /** Durable tombstones prevent a stale tab from resurrecting a deleted alert. */
  deleted?: boolean;
  /** The browser row is inert while its linked server rule is being archived. */
  deletionPending?: boolean;
  /** A durable local definition is waiting for its linked server revision. */
  pendingDefinitionUpdate?: boolean;
  /** Server rule also delivers to the owner's active Telegram binding. */
  telegramDelivery?: boolean;
}

const KEY = "sbv2:alerts";
export const PRICE_ALERT_STORAGE_KEY = KEY;

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
  return loadAlertSnapshot(ownerId, legacyRoute).filter((alert) => !alert.deleted);
}

/** Internal durable snapshot, including inert deletion tombstones. */
export function loadAlertSnapshot(ownerId?: string, legacyRoute: ChartDataRoute = DEFAULT_PRICE_ALERT_ROUTE): PriceAlert[] {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => parseStoredPriceAlert(value, legacyRoute)).filter((value): value is PriceAlert => value !== undefined);
  } catch {
    return [];
  }
}

export function priceAlertStorageKey(ownerId?: string): string | undefined {
  return tenantLocalStorageKey(KEY, ownerId);
}

/**
 * Merge independently updated owner-local snapshots without allowing an older
 * tab to overwrite a newer suspended checkpoint or deletion tombstone.
 */
export function mergePriceAlertSnapshots(left: PriceAlert[], right: PriceAlert[]): PriceAlert[] {
  const order: string[] = [];
  const merged = new Map<string, PriceAlert>();
  for (const alert of [...left, ...right]) {
    if (!merged.has(alert.id)) order.push(alert.id);
    const current = merged.get(alert.id);
    merged.set(alert.id, current ? newerLocalAlert(current, alert) : alert);
  }
  return order.map((id) => merged.get(id)).filter((alert): alert is PriceAlert => alert !== undefined);
}

export function storeAlerts(alerts: PriceAlert[], ownerId?: string): boolean {
  try {
    const serialized = JSON.stringify(alerts);
    writeTenantLocalItem(window.localStorage, KEY, serialized, ownerId);
    return readTenantLocalItem(window.localStorage, KEY, ownerId) === serialized;
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
    return false;
  }
}

export function parseStoredPriceAlert(value: unknown, legacyRoute: ChartDataRoute = DEFAULT_PRICE_ALERT_ROUTE): PriceAlert | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const alert = value as Record<string, unknown>;
  if (typeof alert.id !== "string" || alert.id.length < 1 || alert.id.length > 256 || typeof alert.symbol !== "string" || alert.symbol.length < 1 || alert.symbol.length > 64 || typeof alert.price !== "number" || !Number.isFinite(alert.price) || alert.price <= 0 || (alert.direction !== "above" && alert.direction !== "below") || typeof alert.createdAt !== "number" || !Number.isSafeInteger(alert.createdAt) || alert.createdAt < 0 || typeof alert.triggered !== "boolean") return undefined;
  const legacy = alert.exchange === undefined && alert.marketType === undefined && alert.priceType === undefined;
  const route = legacy
    ? legacyRoute
    : isExchange(alert.exchange) && isMarketType(alert.marketType) && isPriceType(alert.priceType)
      ? { exchange: alert.exchange, marketType: alert.marketType, priceType: alert.priceType }
      : undefined;
  if (!route) return undefined;
  const timeframe = isTimeframe(alert.timeframe) ? alert.timeframe : undefined;
  const source = alert.source === "server" ? "server" : alert.source === "browser" ? "browser" : undefined;
  const syncState = isSyncState(alert.syncState) ? alert.syncState : undefined;
  const serverLifecycle = isServerLifecycle(alert.serverLifecycle) ? alert.serverLifecycle : undefined;
  return {
    id: alert.id,
    symbol: alert.symbol,
    price: alert.price,
    direction: alert.direction,
    createdAt: alert.createdAt,
    triggered: alert.triggered,
    ...route,
    ...(timeframe ? { timeframe } : {}),
    ...(source ? { source } : {}),
    ...(typeof alert.clientId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(alert.clientId) ? { clientId: alert.clientId } : {}),
    ...(alert.suspended === true ? { suspended: true } : {}),
    ...(syncState ? { syncState } : {}),
    ...(typeof alert.serverRuleId === "string" && isUuid(alert.serverRuleId) ? { serverRuleId: alert.serverRuleId } : {}),
    ...(typeof alert.serverRevision === "number" && Number.isSafeInteger(alert.serverRevision) && alert.serverRevision > 0 ? { serverRevision: alert.serverRevision } : {}),
    ...(serverLifecycle ? { serverLifecycle } : {}),
    ...(typeof alert.localRevision === "number" && Number.isSafeInteger(alert.localRevision) && alert.localRevision > 0 ? { localRevision: alert.localRevision } : {}),
    ...(alert.deleted === true ? { deleted: true } : {}),
    ...(alert.deletionPending === true ? { deletionPending: true } : {}),
    ...(alert.pendingDefinitionUpdate === true ? { pendingDefinitionUpdate: true } : {}),
    ...(alert.telegramDelivery === true ? { telegramDelivery: true } : {})
  };
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
export function evaluateAlertPrices(alerts: PriceAlert[], route: ChartDataRoute, prices: Record<string, number>, timeframe?: Timeframe): { alerts: PriceAlert[]; fired: TriggeredPriceAlert[] } {
  let next = alerts;
  const fired: TriggeredPriceAlert[] = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    if (alert.deleted || alert.deletionPending || alert.triggered || alert.suspended || alert.source === "server" || !samePriceAlertRoute(alert, route) || (timeframe !== undefined && alert.timeframe !== timeframe)) continue;
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

function isTimeframe(value: unknown): value is Timeframe {
  return value === "1m" || value === "5m" || value === "15m" || value === "30m" || value === "1h" || value === "2h" || value === "4h" || value === "1d" || value === "1w" || value === "1M";
}

function isSyncState(value: unknown): value is PriceAlertSyncState {
  return value === "browser-only" || value === "needs-review" || value === "syncing" || value === "synced" || value === "sync-error" || value === "deleting";
}

function isServerLifecycle(value: unknown): value is AlertRuleLifecycleStateV1 {
  return value === "armed" || value === "triggered" || value === "disabled" || value === "stale" || value === "error" || value === "archived";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function newerLocalAlert(left: PriceAlert, right: PriceAlert): PriceAlert {
  const leftRevision = left.localRevision ?? 0;
  const rightRevision = right.localRevision ?? 0;
  if (leftRevision !== rightRevision) return leftRevision > rightRevision ? left : right;
  const leftSafety = localSafetyRank(left);
  const rightSafety = localSafetyRank(right);
  if (leftSafety !== rightSafety) return leftSafety > rightSafety ? left : right;
  // Deterministic convergence for the extremely rare equal-clock conflict.
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right;
}

function localSafetyRank(alert: PriceAlert): number {
  if (alert.deleted) return 5;
  if (alert.deletionPending) return 4;
  if (alert.triggered) return 3;
  if (alert.suspended) return 2;
  return 1;
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
