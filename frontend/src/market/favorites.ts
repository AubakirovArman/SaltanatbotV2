import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

const KEY = "sbv2:favorites";

/** Persisted set of pinned/favorite symbols. Pinned symbols sort to the top of the watchlist. */
export function loadFavorites(ownerId?: string): string[] {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function storeFavorites(symbols: string[], ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, KEY, JSON.stringify(symbols), ownerId);
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
