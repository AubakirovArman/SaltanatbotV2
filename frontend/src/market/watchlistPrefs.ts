export type WatchlistSort = "symbol" | "change-desc" | "change-asc";

const KEY = "sbv2:watchlistSort";
const VALID: WatchlistSort[] = ["symbol", "change-desc", "change-asc"];

export function loadWatchlistSort(): WatchlistSort {
  try {
    const raw = window.localStorage.getItem(KEY);
    return VALID.includes(raw as WatchlistSort) ? (raw as WatchlistSort) : "symbol";
  } catch {
    return "symbol";
  }
}

export function storeWatchlistSort(sort: WatchlistSort) {
  try {
    window.localStorage.setItem(KEY, sort);
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
