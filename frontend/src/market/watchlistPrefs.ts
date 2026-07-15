import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

export type WatchlistSort = "symbol" | "change-desc" | "change-asc";

const KEY = "sbv2:watchlistSort";
const VALID: WatchlistSort[] = ["symbol", "change-desc", "change-asc"];

export function loadWatchlistSort(ownerId?: string): WatchlistSort {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    return VALID.includes(raw as WatchlistSort) ? (raw as WatchlistSort) : "symbol";
  } catch {
    return "symbol";
  }
}

export function storeWatchlistSort(sort: WatchlistSort, ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, KEY, sort, ownerId);
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
